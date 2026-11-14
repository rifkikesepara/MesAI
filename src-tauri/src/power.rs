use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerIdleState {
    pub on_battery: bool,
    pub idle_seconds: u64,
}

#[cfg(windows)]
pub fn get_power_idle_state() -> PowerIdleState {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows::Win32::System::SystemInformation::GetTickCount64;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut on_battery = false;
    let mut power_status = SYSTEM_POWER_STATUS::default();
    unsafe {
        if GetSystemPowerStatus(&mut power_status).is_ok() {
            // ACLineStatus == 0 means Offline (on battery)
            on_battery = power_status.ACLineStatus == 0;
        }
    }

    let mut idle_seconds = 0u64;
    let mut lii = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    unsafe {
        if GetLastInputInfo(&mut lii).as_bool() {
            let now_ticks = GetTickCount64() as u32;
            let elapsed_ms = now_ticks.wrapping_sub(lii.dwTime);
            idle_seconds = (elapsed_ms / 1000) as u64;
        }
    }

    PowerIdleState {
        on_battery,
        idle_seconds,
    }
}

#[cfg(not(windows))]
pub fn get_power_idle_state() -> PowerIdleState {
    PowerIdleState {
        on_battery: false,
        idle_seconds: 0,
    }
}
