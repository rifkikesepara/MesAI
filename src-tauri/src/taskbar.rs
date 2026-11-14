#[cfg(windows)]
mod win_impl {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use tauri::AppHandle;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject, HBITMAP};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows::Win32::UI::Shell::{
        DefSubclassProc, ITaskbarList3, SetWindowSubclass, TaskbarList, THBF_ENABLED, THB_FLAGS,
        THB_ICON, THB_TOOLTIP, THUMBBUTTON,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateIconIndirect, RegisterWindowMessageW, HICON, ICONINFO, PBT_APMRESUMEAUTOMATIC,
        PBT_APMRESUMESUSPEND, PBT_APMSUSPEND, WM_COMMAND, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE,
        WTS_SESSION_LOCK, WTS_SESSION_UNLOCK,
    };

    const OVERLAY_ACTIVE_PNG: &[u8] = include_bytes!("../../assets/overlay-active.png");
    const OVERLAY_PAUSED_PNG: &[u8] = include_bytes!("../../assets/overlay-paused.png");
    const THUMBAR_PLAY_PNG: &[u8] = include_bytes!("../../assets/thumbar-play.png");
    const THUMBAR_PAUSE_PNG: &[u8] = include_bytes!("../../assets/thumbar-pause.png");
    const THUMBAR_SYNC_PNG: &[u8] = include_bytes!("../../assets/thumbar-sync.png");

    const ID_THUMBAR_PLAY_PAUSE: u32 = 40001;
    const ID_THUMBAR_SYNC: u32 = 40002;
    const SUBCLASS_ID: usize = 0x4D45_5341;

    struct CachedIcons {
        overlay_active: HICON,
        overlay_paused: HICON,
        thumbar_play: HICON,
        thumbar_pause: HICON,
        thumbar_sync: HICON,
    }

    unsafe impl Send for CachedIcons {}
    unsafe impl Sync for CachedIcons {}

    static ICONS: OnceLock<CachedIcons> = OnceLock::new();
    static THUMBAR_ADDED: AtomicBool = AtomicBool::new(false);
    static SUBCLASS_INSTALLED: AtomicBool = AtomicBool::new(false);
    static LAST_PAUSED: AtomicBool = AtomicBool::new(false);
    static TASKBAR_MSG_ID: OnceLock<u32> = OnceLock::new();
    static APP_HANDLE_STORE: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();

    fn png_to_hicon(bytes: &[u8]) -> HICON {
        let img = match image::load_from_memory(bytes) {
            Ok(i) => i.to_rgba8(),
            Err(_) => return HICON::default(),
        };
        let (w, h) = img.dimensions();
        let mut bgra = img.into_raw();
        for chunk in bgra.chunks_exact_mut(4) {
            chunk.swap(0, 2); // RGBA -> BGRA
        }

        let mask_stride = ((w + 31) / 32) * 4;
        let mask_bytes = vec![0u8; (mask_stride * h) as usize];

        unsafe {
            let hbm_color: HBITMAP = CreateBitmap(
                w as i32,
                h as i32,
                1,
                32,
                Some(bgra.as_ptr() as *const core::ffi::c_void),
            );
            let hbm_mask: HBITMAP = CreateBitmap(
                w as i32,
                h as i32,
                1,
                1,
                Some(mask_bytes.as_ptr() as *const core::ffi::c_void),
            );

            let ii = ICONINFO {
                fIcon: true.into(),
                xHotspot: 0,
                yHotspot: 0,
                hbmMask: hbm_mask,
                hbmColor: hbm_color,
            };

            let icon = CreateIconIndirect(&ii).unwrap_or_default();
            let _ = DeleteObject(hbm_color);
            let _ = DeleteObject(hbm_mask);
            icon
        }
    }

    fn get_icons() -> &'static CachedIcons {
        ICONS.get_or_init(|| CachedIcons {
            overlay_active: png_to_hicon(OVERLAY_ACTIVE_PNG),
            overlay_paused: png_to_hicon(OVERLAY_PAUSED_PNG),
            thumbar_play: png_to_hicon(THUMBAR_PLAY_PNG),
            thumbar_pause: png_to_hicon(THUMBAR_PAUSE_PNG),
            thumbar_sync: png_to_hicon(THUMBAR_SYNC_PNG),
        })
    }

    fn copy_tooltip(buf: &mut [u16; 260], text: &str) {
        buf.fill(0);
        for (i, ch) in text.encode_utf16().take(259).enumerate() {
            buf[i] = ch;
        }
    }

    fn wide_null(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn create_taskbar_list() -> Option<ITaskbarList3> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let tb: ITaskbarList3 =
                CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER).ok()?;
            tb.HrInit().ok()?;
            Some(tb)
        }
    }

    fn apply_taskbar_on_hwnd(hwnd: HWND, is_paused: bool) {
        let Some(tb) = create_taskbar_list() else {
            return;
        };
        let icons = get_icons();

        let overlay_icon = if is_paused {
            icons.overlay_paused
        } else {
            icons.overlay_active
        };
        let desc = if is_paused {
            "MesAI — Takip Duraklatıldı"
        } else {
            "MesAI — Takip Aktif"
        };
        let desc_w = wide_null(desc);

        unsafe {
            let _ = tb.SetOverlayIcon(hwnd, overlay_icon, PCWSTR(desc_w.as_ptr()));
        }

        let mut btn_play_pause = THUMBBUTTON::default();
        btn_play_pause.dwMask = THB_ICON | THB_TOOLTIP | THB_FLAGS;
        btn_play_pause.iId = ID_THUMBAR_PLAY_PAUSE;
        btn_play_pause.hIcon = if is_paused {
            icons.thumbar_play
        } else {
            icons.thumbar_pause
        };
        btn_play_pause.dwFlags = THBF_ENABLED;
        copy_tooltip(
            &mut btn_play_pause.szTip,
            if is_paused {
                "Takibi Başlat / Devam Ettir"
            } else {
                "Takibi Duraklat"
            },
        );

        let mut btn_sync = THUMBBUTTON::default();
        btn_sync.dwMask = THB_ICON | THB_TOOLTIP | THB_FLAGS;
        btn_sync.iId = ID_THUMBAR_SYNC;
        btn_sync.hIcon = icons.thumbar_sync;
        btn_sync.dwFlags = THBF_ENABLED;
        copy_tooltip(&mut btn_sync.szTip, "Şimdi Tara (Zoom & Git)");

        let buttons = [btn_play_pause, btn_sync];
        unsafe {
            if !THUMBAR_ADDED.swap(true, Ordering::SeqCst) {
                if tb.ThumbBarAddButtons(hwnd, &buttons).is_err() {
                    let _ = tb.ThumbBarUpdateButtons(hwnd, &buttons);
                }
            } else if tb.ThumbBarUpdateButtons(hwnd, &buttons).is_err() {
                let _ = tb.ThumbBarAddButtons(hwnd, &buttons);
            }
        }
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _uid_subclass: usize,
        _dw_ref_data: usize,
    ) -> LRESULT {
        let taskbar_created_msg = *TASKBAR_MSG_ID.get_or_init(|| {
            let name = wide_null("TaskbarButtonCreated");
            RegisterWindowMessageW(PCWSTR(name.as_ptr()))
        });

        if msg == taskbar_created_msg && taskbar_created_msg != 0 {
            THUMBAR_ADDED.store(false, Ordering::SeqCst);
            apply_taskbar_on_hwnd(hwnd, LAST_PAUSED.load(Ordering::SeqCst));
        } else if msg == WM_COMMAND {
            let cmd_id = (wparam.0 & 0xFFFF) as u32;
            if cmd_id == ID_THUMBAR_PLAY_PAUSE {
                dispatch_sidecar_notify("host:tray:toggleTracking");
                return LRESULT(0);
            } else if cmd_id == ID_THUMBAR_SYNC {
                dispatch_sidecar_notify("host:tray:pollNow");
                return LRESULT(0);
            }
        } else if msg == WM_POWERBROADCAST {
            let event = wparam.0 as u32;
            if event == PBT_APMSUSPEND {
                dispatch_sidecar_notify("host:power:suspend");
            } else if event == PBT_APMRESUMEAUTOMATIC || event == PBT_APMRESUMESUSPEND {
                dispatch_sidecar_notify("host:power:resume");
            }
        } else if msg == WM_WTSSESSION_CHANGE {
            let event = wparam.0 as u32;
            if event == WTS_SESSION_LOCK {
                dispatch_sidecar_notify("host:power:suspend");
            } else if event == WTS_SESSION_UNLOCK {
                dispatch_sidecar_notify("host:power:resume");
            }
        }

        // Also keep PWSTR import referenced if needed
        let _ = PWSTR::null();
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    fn dispatch_sidecar_notify(method: &'static str) {
        if let Some(lock) = APP_HANDLE_STORE.get() {
            if let Ok(guard) = lock.lock() {
                if let Some(app) = guard.as_ref() {
                    let app_clone = app.clone();
                    tauri::async_runtime::spawn(async move {
                        crate::sidecar::notify_sidecar(&app_clone, method).await;
                    });
                }
            }
        }
    }

    pub fn init_window_hooks(app: &AppHandle, hwnd_raw: isize) {
        let store = APP_HANDLE_STORE.get_or_init(|| Mutex::new(None));
        if let Ok(mut guard) = store.lock() {
            *guard = Some(app.clone());
        }

        let _ = TASKBAR_MSG_ID.get_or_init(|| unsafe {
            let name = wide_null("TaskbarButtonCreated");
            RegisterWindowMessageW(PCWSTR(name.as_ptr()))
        });

        if !SUBCLASS_INSTALLED.swap(true, Ordering::SeqCst) {
            let hwnd = HWND(hwnd_raw as *mut core::ffi::c_void);
            unsafe {
                let _ = SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0);
                let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
            }
        }
    }

    pub fn update_taskbar(hwnd_raw: isize, is_paused: bool) {
        LAST_PAUSED.store(is_paused, Ordering::SeqCst);
        let hwnd = HWND(hwnd_raw as *mut core::ffi::c_void);
        apply_taskbar_on_hwnd(hwnd, is_paused);
    }
}

#[cfg(windows)]
pub use win_impl::{init_window_hooks, update_taskbar};

#[cfg(not(windows))]
pub fn init_window_hooks(_app: &tauri::AppHandle, _hwnd_raw: isize) {}

#[cfg(not(windows))]
pub fn update_taskbar(_hwnd_raw: isize, _is_paused: bool) {}
