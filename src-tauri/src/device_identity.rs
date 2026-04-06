use std::process::Command;

use anyhow::{anyhow, Context, Result};

pub fn current_device_material() -> Result<String> {
    #[cfg(target_os = "macos")]
    {
        return macos_platform_uuid();
    }

    #[cfg(target_os = "windows")]
    {
        return windows_machine_guid();
    }

    #[allow(unreachable_code)]
    Err(anyhow!(
        "AI key encryption is only supported on macOS and Windows in this release"
    ))
}

#[cfg(target_os = "macos")]
fn macos_platform_uuid() -> Result<String> {
    let output = Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .context("failed to execute ioreg")?;

    if !output.status.success() {
        return Err(anyhow!("failed to read IOPlatformUUID from ioreg"));
    }

    let stdout = String::from_utf8(output.stdout).context("ioreg output was not valid UTF-8")?;
    for line in stdout.lines() {
        if let Some((_, remainder)) = line.split_once("\"IOPlatformUUID\" = ") {
            let value = remainder.trim().trim_matches('"');
            if !value.is_empty() {
                return Ok(value.to_string());
            }
        }
    }

    Err(anyhow!("IOPlatformUUID was not available on this device"))
}

#[cfg(target_os = "windows")]
fn windows_machine_guid() -> Result<String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;

    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let crypto = hklm
        .open_subkey("SOFTWARE\\Microsoft\\Cryptography")
        .context("failed to open Cryptography registry hive")?;
    let guid: String = crypto
        .get_value("MachineGuid")
        .context("failed to read MachineGuid")?;

    let trimmed = guid.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("MachineGuid was empty"));
    }

    Ok(trimmed.to_string())
}
