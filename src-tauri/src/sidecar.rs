use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

#[derive(Debug, Deserialize)]
struct SidecarMessage {
    id: Option<Value>,
    event: Option<String>,
    payload: Option<Value>,
    #[serde(rename = "hostMethod")]
    host_method: Option<String>,
    params: Option<Value>,
    result: Option<Value>,
    error: Option<SidecarError>,
}

#[derive(Debug, Deserialize, Serialize)]
struct SidecarError {
    message: String,
}

pub struct SidecarState {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    child: Arc<Mutex<Option<Child>>>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
    next_id: AtomicU64,
}

impl SidecarState {
    pub fn new() -> Self {
        Self {
            stdin: Arc::new(Mutex::new(None)),
            child: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
        }
    }
}

fn resolve_sidecar_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe hatası: {e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "exe dizini çözümlenemedi".to_string())?;

    let candidates = [
        exe_dir.join("mesai-backend.exe"),
        exe_dir.join("mesai-backend-x86_64-pc-windows-msvc.exe"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("mesai-backend-x86_64-pc-windows-msvc.exe"),
    ];

    for c in candidates {
        if c.exists() {
            return Ok(c);
        }
    }

    Err("mesai-backend sidecar yürütülebilir dosyası bulunamadı.".into())
}

fn resolve_user_data_dir() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.trim().is_empty() {
            return PathBuf::from(appdata).join("MesAI");
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        return PathBuf::from(profile)
            .join("AppData")
            .join("Roaming")
            .join("MesAI");
    }
    std::env::temp_dir().join("MesAI")
}

fn resolve_resources_dir(app: &AppHandle) -> PathBuf {
    if let Ok(res_dir) = app.path().resource_dir() {
        if res_dir.join("ZoomChatReader").exists() {
            return res_dir;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

pub async fn start_sidecar(app: &AppHandle) -> Result<(), String> {
    let sidecar_exe = resolve_sidecar_path()?;
    let user_data_dir = resolve_user_data_dir();
    let resources_dir = resolve_resources_dir(app);
    let host_exe = std::env::current_exe().unwrap_or_default();
    let app_version = app.package_info().version.to_string();

    let mut cmd = Command::new(&sidecar_exe);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("MESAI_USER_DATA_DIR", &user_data_dir)
        .env("MESAI_RESOURCES_DIR", &resources_dir)
        .env("MESAI_HOST_EXE", &host_exe)
        .env("MESAI_APP_VERSION", &app_version)
        .env("MESAI_IS_PACKAGED", if cfg!(debug_assertions) { "0" } else { "1" })
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Sidecar başlatılamadı ({}): {e}", sidecar_exe.display()))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Sidecar stdin açılamadı".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Sidecar stdout açılamadı".to_string())?;
    let stderr = child.stderr.take();

    let state = app.state::<SidecarState>();
    {
        let mut s = state.stdin.lock().await;
        *s = Some(stdin);
    }
    {
        let mut c = state.child.lock().await;
        *c = Some(child);
    }

    if let Some(err_stream) = stderr {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(err_stream).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[mesai-backend] {line}");
            }
        });
    }

    let app_for_stdout = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let msg: SidecarMessage = match serde_json::from_str(trimmed) {
                Ok(m) => m,
                Err(e) => {
                    eprintln!("[sidecar-rpc] JSON parse error: {e} | line={trimmed}");
                    continue;
                }
            };

            if let Some(event_name) = msg.event {
                let payload = msg.payload.unwrap_or(Value::Null);
                handle_sidecar_event(&app_for_stdout, &event_name, payload);
                continue;
            }

            if let Some(host_method) = msg.host_method {
                let req_id = msg.id.unwrap_or(Value::Null);
                let params = msg.params.unwrap_or(Value::Null);
                let app_clone = app_for_stdout.clone();
                tauri::async_runtime::spawn(async move {
                    let res = handle_host_method(&app_clone, &host_method, params).await;
                    let response_json = match res {
                        Ok(val) => serde_json::json!({ "id": req_id, "result": val }),
                        Err(err) => serde_json::json!({ "id": req_id, "error": { "message": err } }),
                    };
                    let _ = write_to_sidecar(&app_clone, &response_json).await;
                });
                continue;
            }

            if let Some(id_val) = msg.id {
                let id_key = match id_val {
                    Value::String(s) => s,
                    Value::Number(n) => n.to_string(),
                    other => other.to_string(),
                };
                let state = app_for_stdout.state::<SidecarState>();
                let sender = {
                    let mut pending = state.pending.lock().await;
                    pending.remove(&id_key)
                };
                if let Some(tx) = sender {
                    if let Some(err) = msg.error {
                        let _ = tx.send(Err(err.message));
                    } else {
                        let _ = tx.send(Ok(msg.result.unwrap_or(Value::Null)));
                    }
                }
            }
        }

        // Fail any outstanding calls if sidecar exits unexpectedly
        let state = app_for_stdout.state::<SidecarState>();
        let mut pending = state.pending.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err("Arka plan servisi kapandı.".into()));
        }
    });

    Ok(())
}

async fn write_to_sidecar(app: &AppHandle, msg: &Value) -> Result<(), String> {
    let state = app.state::<SidecarState>();
    let mut guard = state.stdin.lock().await;
    let stdin = guard
        .as_mut()
        .ok_or_else(|| "Arka plan servisi hazır değil.".to_string())?;
    let mut line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("Sidecar yazma hatası: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Sidecar flush hatası: {e}"))?;
    Ok(())
}

pub async fn call_sidecar(app: &AppHandle, method: &str, params: Vec<Value>) -> Result<Value, String> {
    let state = app.state::<SidecarState>();
    let id = state.next_id.fetch_add(1, Ordering::SeqCst).to_string();
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = state.pending.lock().await;
        pending.insert(id.clone(), tx);
    }

    let req = serde_json::json!({
        "id": id,
        "method": method,
        "params": params,
    });

    if let Err(err) = write_to_sidecar(app, &req).await {
        let mut pending = state.pending.lock().await;
        pending.remove(&id);
        return Err(err);
    }

    rx.await
        .map_err(|_| "Arka plan servisinden yanıt alınamadı.".to_string())?
}

pub async fn notify_sidecar(app: &AppHandle, method: &str) {
    let _ = call_sidecar(app, method, Vec::new()).await;
}

pub async fn shutdown_sidecar(app: &AppHandle) {
    let _ = tokio::time::timeout(
        std::time::Duration::from_millis(1500),
        call_sidecar(app, "host:shutdown", Vec::new()),
    )
    .await;

    let state = app.state::<SidecarState>();
    let mut child_guard = state.child.lock().await;
    if let Some(mut child) = child_guard.take() {
        let _ = child.kill().await;
    }
}

fn handle_sidecar_event(app: &AppHandle, event_name: &str, payload: Value) {
    match event_name {
        "host:taskbarTrayUpdate" => {
            let is_paused = payload
                .get("isPaused")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            crate::update_tray_and_taskbar(app, is_paused);
        }
        "host:notification" => {
            let title = payload
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("MesAI");
            let body = payload.get("body").and_then(|v| v.as_str()).unwrap_or("");
            let _ = app
                .notification()
                .builder()
                .title(title)
                .body(body)
                .show();
        }
        "host:quit" => {
            crate::request_app_quit(app);
        }
        _ => {
            let _ = app.emit(event_name, payload);
        }
    }
}

async fn handle_host_method(app: &AppHandle, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "dialog:selectFolder" => {
            let (tx, rx) = oneshot::channel();
            app.dialog().file().pick_folder(move |folder| {
                let path = folder.and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string());
                let _ = tx.send(path);
            });
            let res = rx.await.unwrap_or(None);
            Ok(res.map(Value::String).unwrap_or(Value::Null))
        }
        "dialog:saveFile" => {
            let title = params
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Kaydet")
                .to_string();
            let default_path = params
                .get("defaultPath")
                .and_then(|v| v.as_str())
                .map(PathBuf::from);
            let filters = params
                .get("filters")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            let (tx, rx) = oneshot::channel();
            let mut builder = app.dialog().file().set_title(&title);
            if let Some(dp) = default_path {
                if let Some(parent) = dp.parent() {
                    if parent.exists() {
                        builder = builder.set_directory(parent);
                    }
                }
                if let Some(fname) = dp.file_name().and_then(|f| f.to_str()) {
                    builder = builder.set_file_name(fname);
                }
            }
            for f in filters {
                let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("Dosya");
                let exts: Vec<String> = f
                    .get("extensions")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                let ext_refs: Vec<&str> = exts.iter().map(|s| s.as_str()).collect();
                if !ext_refs.is_empty() {
                    builder = builder.add_filter(name, &ext_refs);
                }
            }

            builder.save_file(move |file| {
                let path = file.and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string());
                let _ = tx.send(path);
            });
            let res = rx.await.unwrap_or(None);
            Ok(res.map(Value::String).unwrap_or(Value::Null))
        }
        "shell:openExternal" => {
            let url = params
                .get("url")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "URL eksik".to_string())?;
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err("Yalnızca http/https bağlantıları açılabilir.".into());
            }
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Bool(true))
        }
        "shell:openPath" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "Dosya yolu eksik".to_string())?;
            app.opener()
                .open_path(path, None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Bool(true))
        }
        "autostart:set" => {
            let enabled = params
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let manager = app.autolaunch();
            if enabled {
                let _ = manager.enable();
            } else {
                let _ = manager.disable();
            }
            Ok(Value::Bool(true))
        }
        "power:getIdleState" => {
            let state = crate::power::get_power_idle_state();
            serde_json::to_value(state).map_err(|e| e.to_string())
        }
        "updater:nativeCheck" => {
            // Only attempt signed Tauri native updater when pubkey is configured in tauri.conf.json
            let has_pubkey = app
                .config()
                .plugins
                .0
                .get("updater")
                .and_then(|u| u.get("pubkey"))
                .and_then(|p| p.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);

            if !has_pubkey {
                return Ok(Value::Null);
            }

            #[cfg(desktop)]
            {
                use tauri_plugin_updater::UpdaterExt;
                if let Ok(updater) = app.updater() {
                    if let Ok(maybe_update) = updater.check().await {
                        if let Some(update) = maybe_update {
                            return Ok(serde_json::json!({
                                "available": true,
                                "version": update.version,
                                "body": update.body,
                                "date": update.date.map(|d| d.to_string()),
                            }));
                        }
                        return Ok(serde_json::json!({ "available": false }));
                    }
                }
            }
            Ok(Value::Null)
        }
        "updater:nativeDownloadAndInstall" => {
            let has_pubkey = app
                .config()
                .plugins
                .0
                .get("updater")
                .and_then(|u| u.get("pubkey"))
                .and_then(|p| p.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);

            if !has_pubkey {
                return Ok(Value::Bool(false));
            }

            #[cfg(desktop)]
            {
                use tauri_plugin_updater::UpdaterExt;
                if let Ok(updater) = app.updater() {
                    if let Ok(Some(update)) = updater.check().await {
                        let app_progress = app.clone();
                        let started = std::time::Instant::now();
                        let mut downloaded: usize = 0;
                        let mut last_emit = std::time::Instant::now();
                        if update
                            .download_and_install(
                                move |chunk_len, content_len| {
                                    downloaded += chunk_len;
                                    if last_emit.elapsed().as_millis() >= 120 {
                                        last_emit = std::time::Instant::now();
                                        let total = content_len.unwrap_or(0);
                                        let secs = started.elapsed().as_secs_f64().max(0.1);
                                        let bps = (downloaded as f64 / secs).round() as u64;
                                        let percent = if total > 0 {
                                            (((downloaded as f64 / total as f64) * 1000.0).round() / 10.0).min(99.9)
                                        } else {
                                            0.0
                                        };
                                        let _ = app_progress.emit(
                                            "mesai:updater:stateChanged",
                                            serde_json::json!({
                                                "status": "downloading",
                                                "currentVersion": app_progress.package_info().version.to_string(),
                                                "progress": {
                                                    "percent": percent,
                                                    "transferredBytes": downloaded,
                                                    "totalBytes": total,
                                                    "bytesPerSecond": bps
                                                },
                                                "errorMessage": null
                                            }),
                                        );
                                    }
                                },
                                || {},
                            )
                            .await
                            .is_ok()
                        {
                            return Ok(Value::Bool(true));
                        }
                    }
                }
            }
            Ok(Value::Bool(false))
        }
        _ => Err(format!("Bilinmeyen host metodu: {method}")),
    }
}
