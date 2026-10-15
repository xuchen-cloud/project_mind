use super::*;
use winreg::{enums::{HKEY_CURRENT_USER,KEY_READ,REG_EXPAND_SZ,REG_SZ},RegKey,RegValue};

const PROFILE:&str="HKCU\\Environment\\Path";

fn registry_value()->AgentResult<Option<RegValue>> {
    let root=RegKey::predef(HKEY_CURRENT_USER);
    let env=match root.open_subkey_with_flags("Environment",KEY_READ) {
        Ok(env)=>env,
        Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None),
        Err(error)=>return Err(io(error)),
    };
    match env.get_raw_value("Path") {
        Ok(raw)=>Ok(Some(raw)),
        Err(error) if error.kind()==std::io::ErrorKind::NotFound=>Ok(None),
        Err(error)=>Err(io(error)),
    }
}
fn decode_path(raw:&RegValue)->AgentResult<String> {
    if raw.vtype!=REG_SZ && raw.vtype!=REG_EXPAND_SZ || raw.bytes.len()%2!=0 {
        return Err(conflict("User PATH has an unsupported registry value type"));
    }
    let mut units=raw.bytes.chunks_exact(2).map(|pair|u16::from_le_bytes([pair[0],pair[1]])).collect::<Vec<_>>();
    while units.last()==Some(&0) { units.pop(); }
    if units.contains(&0) { return Err(conflict("User PATH contains an embedded NUL")); }
    String::from_utf16(&units).map_err(|_|conflict("User PATH is not valid UTF-16"))
}
fn encode_path(value:&str,original:Option<&RegValue>)->RegValue {
    let mut bytes=Vec::new();
    for unit in value.encode_utf16().chain(std::iter::once(0)) { bytes.extend_from_slice(&unit.to_le_bytes()); }
    RegValue { bytes,vtype:original.map(|raw|raw.vtype.clone()).unwrap_or(REG_EXPAND_SZ) }
}
fn set_path(value:Option<&str>,original:Option<&RegValue>)->AgentResult<()> {
    let root=RegKey::predef(HKEY_CURRENT_USER);
    let (env,_)=root.create_subkey("Environment").map_err(io)?;
    if let Some(value)=value { env.set_raw_value("Path",&encode_path(value,original)).map_err(io)?; }
    else if original.is_some() { env.delete_value("Path").map_err(io)?; }
    broadcast_path()
}
fn broadcast_path()->AgentResult<()> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW,SMTO_ABORTIFHUNG,WM_SETTINGCHANGE};
    let name="Environment".encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();
    let mut result=0usize;
    let sent=unsafe { SendMessageTimeoutW(0xffff as _,WM_SETTINGCHANGE,0,name.as_ptr() as isize,SMTO_ABORTIFHUNG,5000,&mut result) };
    if sent==0 { return Err(io(std::io::Error::last_os_error())); }
    Ok(())
}

pub(super) fn status_with(paths:&InstallPaths)->AgentResult<CliInstallationStatus> {
    let command=command_path(paths);
    let directory=display(command.parent().unwrap());
    let receipt=read_receipt(paths)?;
    let raw=registry_value()?;
    let user_path=raw.as_ref().map(decode_path).transpose()?.unwrap_or_default();
    let registered=windows_path_contains(&user_path,&directory);
    let path_configured=registered
        || windows_path_contains(&paths.path.to_string_lossy(),&directory);
    let source=source_hash(paths)?;
    let mut state=CliInstallationStatus {
        source_path:source.as_ref().map(|_|display(&paths.source)),
        command_path:display(&command),profile_path:Some(PROFILE.into()),
        installed:false,path_configured,needs_update:false,conflict:None,manual_instruction:None,
    };
    if let Some(receipt)=receipt {
        if receipt.command_path!=state.command_path || receipt.profile_path.as_deref()!=Some(PROFILE) {
            state.conflict=Some("CLI installation receipt points elsewhere".into());
        }
        if receipt.path_added {
            state.path_configured=registered;
        }
        match fs::symlink_metadata(&command) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink()=>{
                if { let current=hash_file(&command)?; current==receipt.installed_hash || source.as_ref()==Some(&current) } { state.installed=true; }
                else { state.conflict=Some("Installed CLI was changed".into()); }
            }
            Ok(_)=>state.conflict=Some("Installed CLI path is no longer a file".into()),
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>{},
            Err(error)=>return Err(io(error)),
        }
        if !state.installed || source.as_ref().is_some_and(|hash|*hash!=receipt.installed_hash)
            || receipt.source_path!=display(&paths.source) || receipt.path_added && !registered {
            state.needs_update=true;
        }
    } else if fs::symlink_metadata(&command).is_ok() {
        state.conflict=Some("CLI command exists but is not owned by this installation".into());
    }
    Ok(state)
}

pub(super) fn install_with(paths:&InstallPaths)->AgentResult<CliInstallationStatus> {
    let state=status_with(paths)?;
    if state.conflict.is_some() { return Err(conflict("CLI command or PATH settings were changed outside Project Mind")); }
    let hash=source_hash(paths)?.ok_or_else(||err(ErrorCode::RuntimeUnavailable,"Bundled mind CLI is unavailable"))?;
    let command=command_path(paths);
    let directory=display(command.parent().unwrap());
    let original=registry_value()?;
    let original_path=original.as_ref().map(decode_path).transpose()?.unwrap_or_default();
    let mut receipt=read_receipt(paths)?.unwrap_or(Receipt {
        version:1,source_path:display(&paths.source),command_path:display(&command),
        installed_hash:hash.clone(),
        profile_path:Some(PROFILE.into()),profile_kind:Some(ProfileKind::Windows),
        path_added:false,path_originally_missing:original.is_none(),
        profile_separator_added:false,profile_created:false,
    });
    // Record the claim before mutating the command or registry so a failed
    // install can be resumed without treating its own partial work as foreign.
    if !state.path_configured { receipt.path_added=true; }
    write_receipt(paths,&receipt)?;
    fs::create_dir_all(command.parent().unwrap()).map_err(io)?;
    if state.needs_update || !state.installed {
        let temporary=command.with_extension(format!("exe.tmp-{}",std::process::id()));
        fs::copy(&paths.source,&temporary).map_err(io)?;
        if command.exists() { fs::remove_file(&command).map_err(io)?; }
        fs::rename(&temporary,&command).map_err(io)?;
    }
    if !state.path_configured { set_path(Some(&windows_path_add(&original_path,&directory)),original.as_ref())?; }
    receipt.source_path=display(&paths.source);
    receipt.installed_hash=hash;
    write_receipt(paths,&receipt)?;
    let done=status_with(paths)?;
    if done.conflict.is_some() || !done.installed { return Err(err(ErrorCode::IoFailed,"CLI installation did not complete")); }
    Ok(done)
}

pub(super) fn uninstall_with(paths:&InstallPaths)->AgentResult<CliInstallationStatus> {
    let state=status_with(paths)?;
    if state.conflict.is_some() { return Err(conflict("CLI command or PATH settings were changed outside Project Mind")); }
    let Some(receipt)=read_receipt(paths)? else { return Ok(state); };
    let command=command_path(paths);
    if fs::symlink_metadata(&command).is_ok() { fs::remove_file(&command).map_err(io)?; }
    if receipt.path_added {
        let original=registry_value()?;
        if let Some(raw)=original.as_ref() {
            let current=decode_path(raw)?;
            let updated=windows_path_remove_one(&current,&display(command.parent().unwrap()));
            if updated!=current {
                if updated.is_empty() && receipt.path_originally_missing { set_path(None,original.as_ref())?; }
                else { set_path(Some(&updated),original.as_ref())?; }
            }
        }
    }
    fs::remove_file(receipt_path(paths)).map_err(io)?;
    status_with(paths)
}
