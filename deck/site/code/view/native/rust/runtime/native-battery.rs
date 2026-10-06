// The battery for a Rust program (device-layer-0014), docked by ../battery.tree as `<global:native-battery>`. No crate:
// the power supplies Linux lists under /sys/class/power_supply, GetSystemPowerStatus from kernel32 on Windows, and
// `pmset -g batt` on a Mac. A machine with no battery (a desktop, a server) answers `unavailable`.
mod native_battery {
    // the level to two places, as the other hosts write it
    fn level(fraction: f64) -> String {
        format!("{:.2}", fraction.clamp(0.0, 1.0))
    }

    // `<level> <state>`, the state charging, full, unplugged or unknown; or unavailable
    pub fn read() -> String {
        read_platform().unwrap_or_else(|| "unavailable".to_string())
    }

    #[cfg(target_os = "linux")]
    fn read_platform() -> Option<String> {
        for entry in std::fs::read_dir("/sys/class/power_supply").ok()?.flatten() {
            let path = entry.path();
            let field = |name: &str| std::fs::read_to_string(path.join(name)).map(|text| text.trim().to_string()).unwrap_or_default();
            if field("type") != "Battery" {
                continue;
            }
            let capacity: f64 = field("capacity").parse().ok()?;
            // the kernel's words: Charging, Discharging, Full, Not charging (plugged in and held short of full), Unknown
            let state = match field("status").as_str() {
                "Charging" => "charging",
                "Full" => "full",
                "Discharging" => "unplugged",
                _ => "unknown",
            };
            return Some(format!("{} {}", level(capacity / 100.0), state));
        }
        None
    }

    #[cfg(windows)]
    fn read_platform() -> Option<String> {
        #[repr(C)]
        #[derive(Default)]
        struct PowerStatus {
            ac_line: u8,
            battery_flag: u8,
            life_percent: u8,
            saver: u8,
            life_time: u32,
            full_life_time: u32,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetSystemPowerStatus(status: *mut PowerStatus) -> i32;
        }
        let mut status = PowerStatus::default();
        // SAFETY: the struct is SYSTEM_POWER_STATUS's layout, and the call only writes it
        if unsafe { GetSystemPowerStatus(&mut status) } == 0 {
            return None;
        }
        // 128 is "no system battery", 255 an unknown flag or percent
        if status.battery_flag == 128 || status.battery_flag == 255 || status.life_percent == 255 {
            return None;
        }
        let state = if status.battery_flag & 8 != 0 {
            "charging"
        } else if status.ac_line == 1 {
            if status.life_percent >= 100 { "full" } else { "unknown" }
        } else if status.ac_line == 0 {
            "unplugged"
        } else {
            "unknown"
        };
        Some(format!("{} {}", level(f64::from(status.life_percent) / 100.0), state))
    }

    #[cfg(target_os = "macos")]
    fn read_platform() -> Option<String> {
        let out = std::process::Command::new("pmset").args(["-g", "batt"]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text.lines().find(|line| line.contains("InternalBattery"))?;
        let percent: f64 = line.split('%').next()?.rsplit(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
        let state = if line.contains("charged") {
            "full"
        } else if line.contains("discharging") {
            "unplugged"
        } else if line.contains("charging") {
            "charging"
        } else {
            "unknown"
        };
        Some(format!("{} {}", level(percent / 100.0), state))
    }

    #[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
    fn read_platform() -> Option<String> {
        None
    }
}
