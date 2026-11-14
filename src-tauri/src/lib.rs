mod dpapi;
mod power;
mod sidecar;
mod taskbar;

pub use dpapi::handle_cli_dpapi;

use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

const TRAY_ACTIVE_PNG: &[u8] = include_bytes!("../../assets/tray-icon-active.png");
const TRAY_PAUSED_PNG: &[u8] = include_bytes!("../../assets/tray-icon-paused.png");

static IS_QUITTING: AtomicBool = AtomicBool::new(false);

struct TrayState {
    tray: Mutex<Option<TrayIcon>>,
    toggle_item: Mutex<Option<MenuItem<tauri::Wry>>>,
}

#[tauri::command]
async fn mesai_rpc(
    app: AppHandle,
    channel: String,
    args: Option<Vec<Value>>,
) -> Result<Value, String> {
    sidecar::call_sidecar(&app, &channel, args.unwrap_or_default()).await
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

pub fn request_app_quit(app: &AppHandle) {
    IS_QUITTING.store(true, Ordering::SeqCst);
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        sidecar::shutdown_sidecar(&app_clone).await;
        app_clone.exit(0);
    });
}

pub fn update_tray_and_taskbar(app: &AppHandle, is_paused: bool) {
    // Update Tray icon, tooltip, and toggle menu label
    if let Some(tray_state) = app.try_state::<TrayState>() {
        if let Ok(guard) = tray_state.tray.lock() {
            if let Some(tray) = guard.as_ref() {
                let icon_bytes = if is_paused {
                    TRAY_PAUSED_PNG
                } else {
                    TRAY_ACTIVE_PNG
                };
                if let Ok(img) = Image::from_bytes(icon_bytes) {
                    let _ = tray.set_icon(Some(img));
                }
                let tooltip = if is_paused {
                    "MesAI (DevTrack AI) — Duraklatıldı"
                } else {
                    "MesAI (DevTrack AI) — Aktif Takip"
                };
                let _ = tray.set_tooltip(Some(tooltip));
            }
        }
        if let Ok(item_guard) = tray_state.toggle_item.lock() {
            if let Some(toggle_item) = item_guard.as_ref() {
                let label = if is_paused {
                    "▶ Takibi Devam Ettir"
                } else {
                    "⏸ Takibi Duraklat"
                };
                let _ = toggle_item.set_text(label);
            }
        }
    }

    // Update Windows Taskbar overlay icon + thumbar buttons on GUI thread
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(windows)]
        if let Some(win) = app_clone.get_webview_window("main") {
            if let Ok(hwnd) = win.hwnd() {
                taskbar::update_taskbar(hwnd.0 as isize, is_paused);
            }
        }
    });
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "tray_open", "MesAI Penceresini Aç", true, None::<&str>)?;
    let toggle_item =
        MenuItem::with_id(app, "tray_toggle", "⏸ Takibi Duraklat", true, None::<&str>)?;
    let poll_item =
        MenuItem::with_id(app, "tray_poll", "🔄 Şimdi Zoom & Git Oku", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "tray_quit", "Çıkış", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open_item, &toggle_item, &poll_item, &sep, &quit_item])?;
    let icon = Image::from_bytes(TRAY_ACTIVE_PNG)?;

    let tray = TrayIconBuilder::with_id("mesai-tray")
        .icon(icon)
        .tooltip("MesAI (DevTrack AI) — Aktif Takip")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_open" => show_main_window(app),
            "tray_toggle" => {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    sidecar::notify_sidecar(&app_clone, "host:tray:toggleTracking").await;
                });
            }
            "tray_poll" => {
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    sidecar::notify_sidecar(&app_clone, "host:tray:pollNow").await;
                });
            }
            "tray_quit" => request_app_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            } else if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // Keep double-click primary, single left-click no-op so menu stays right-click
            }
        })
        .build(app)?;

    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(mut guard) = state.tray.lock() {
            *guard = Some(tray);
        }
        if let Ok(mut guard) = state.toggle_item.lock() {
            *guard = Some(toggle_item);
        }
    }

    Ok(())
}

pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(sidecar::SidecarState::new())
        .manage(TrayState {
            tray: Mutex::new(None),
            toggle_item: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![mesai_rpc]);

    builder = builder
        .setup(|app| {
            let handle = app.handle().clone();
            setup_tray(&handle)?;

            #[cfg(windows)]
            if let Some(win) = handle.get_webview_window("main") {
                if let Ok(hwnd) = win.hwnd() {
                    taskbar::init_window_hooks(&handle, hwnd.0 as isize);
                    taskbar::update_taskbar(hwnd.0 as isize, false);
                }
            }

            let handle_for_sidecar = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = sidecar::start_sidecar(&handle_for_sidecar).await {
                    eprintln!("[mesai] Sidecar başlatma hatası: {err}");
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if !IS_QUITTING.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                WindowEvent::Resized(_) => {
                    if let Ok(max) = window.is_maximized() {
                        let _ = window.emit("mesai:window:maximizeChanged", max);
                    }
                }
                _ => {}
            }
        });

    builder
        .build(tauri::generate_context!())
        .expect("MesAI Tauri uygulaması başlatılamadı")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !IS_QUITTING.load(Ordering::SeqCst) {
                    api.prevent_exit();
                } else {
                    let handle = app_handle.clone();
                    tauri::async_runtime::block_on(async move {
                        sidecar::shutdown_sidecar(&handle).await;
                    });
                }
            }
        });
}
