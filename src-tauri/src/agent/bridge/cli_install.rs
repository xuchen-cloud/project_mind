//! User-owned CLI installation. Only an installation receipt may authorize
//! replacing or removing the command and managed PATH entry.
use crate::agent::errors::{AgentError, AgentResult, ErrorCode};
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use sha2::{Digest, Sha256};
use std::{env, fs, path::{Path, PathBuf}};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CliInstallationStatus {
    pub(crate) source_path: Option<String>,
    pub(crate) command_path: String,
    pub(crate) profile_path: Option<String>,
    pub(crate) installed: bool,
    pub(crate) path_configured: bool,
    pub(crate) needs_update: bool,
    pub(crate) conflict: Option<String>,
    pub(crate) manual_instruction: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    version: u8,
    source_path: String,
    command_path: String,
    installed_hash: String,
    profile_path: Option<String>,
    profile_kind: Option<ProfileKind>,
    path_added: bool,
    #[serde(default)]
    path_originally_missing: bool,
    #[serde(default)]
    profile_separator_added: bool,
    #[serde(default)]
    profile_created: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ProfileKind { Bash, Zsh, Fish, Windows }

#[derive(Debug, Clone)]
struct InstallPaths {
    local_dir: PathBuf,
    home: PathBuf,
    source: PathBuf,
    shell: Option<String>,
    zdotdir: Option<PathBuf>,
    path: std::ffi::OsString,
}

fn err(code: ErrorCode, message: &'static str) -> AgentError { AgentError::new(code, message) }
fn io(_: impl std::fmt::Display) -> AgentError { err(ErrorCode::IoFailed, "Cannot change CLI installation") }
fn conflict(message: &'static str) -> AgentError { err(ErrorCode::RevisionConflict, message) }
fn display(path: &Path) -> String { path.to_string_lossy().into_owned() }
fn receipt_path(paths: &InstallPaths) -> PathBuf { paths.local_dir.join("cli-installation.json") }

fn real_paths(local_dir: &Path) -> AgentResult<InstallPaths> {
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| err(ErrorCode::RuntimeUnavailable,"Cannot find the current user's home directory"))?;
    let source = env::current_exe().map_err(io)?.parent()
        .ok_or_else(|| err(ErrorCode::RuntimeUnavailable,"Cannot find the bundled CLI"))?
        .join(if cfg!(windows) { "mind.exe" } else { "mind" });
    Ok(InstallPaths {
        local_dir:local_dir.to_path_buf(),home,source,
        shell:env::var("SHELL").ok(),
        zdotdir:env::var_os("ZDOTDIR").map(PathBuf::from),
        path:env::var_os("PATH").unwrap_or_default(),
    })
}

fn read_receipt(paths: &InstallPaths) -> AgentResult<Option<Receipt>> {
    let raw = match fs::read(receipt_path(paths)) {
        Ok(raw) => raw,
        Err(error) if error.kind()==std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io(error)),
    };
    let receipt:Receipt=serde_json::from_slice(&raw).map_err(|_| conflict("CLI installation receipt was changed"))?;
    if receipt.version!=1 { return Err(conflict("CLI installation receipt version is unsupported")); }
    Ok(Some(receipt))
}
fn write_receipt(paths: &InstallPaths, receipt: &Receipt) -> AgentResult<()> {
    fs::create_dir_all(&paths.local_dir).map_err(io)?;
    let mut temporary = tempfile::NamedTempFile::new_in(&paths.local_dir).map_err(io)?;
    serde_json::to_writer(temporary.as_file_mut(), receipt).map_err(io)?;
    temporary.as_file().sync_all().map_err(io)?;
    temporary.persist(receipt_path(paths)).map_err(io)?;
    Ok(())
}
fn source_exists(paths: &InstallPaths) -> AgentResult<bool> {
    match fs::metadata(&paths.source) {
        Ok(metadata) => Ok(metadata.is_file()),
        Err(error) if error.kind()==std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io(error)),
    }
}
#[cfg(windows)]
fn hash_file(path: &Path) -> AgentResult<String> {
    let mut file=fs::File::open(path).map_err(io)?;
    let mut digest=Sha256::new();
    let mut buffer=[0u8;64*1024];
    loop {
        let length=std::io::Read::read(&mut file,&mut buffer).map_err(io)?;
        if length==0 { break; }
        digest.update(&buffer[..length]);
    }
    Ok(format!("{:x}",digest.finalize()))
}
#[cfg(windows)]
fn source_hash(paths:&InstallPaths)->AgentResult<Option<String>> {
    match fs::metadata(&paths.source) {
        Ok(metadata) if metadata.is_file()=>Ok(Some(hash_file(&paths.source)?)),
        Ok(_)=>Ok(None),
        Err(error) if error.kind()==std::io::ErrorKind::NotFound=>Ok(None),
        Err(error)=>Err(io(error)),
    }
}
fn in_path(path: &std::ffi::OsStr, directory: &Path) -> bool {
    env::split_paths(path).any(|entry| entry==directory)
}
fn windows_path_key(value:&str)->String {
    value.trim().trim_matches('"').replace('/',"\\").trim_end_matches('\\').to_ascii_lowercase()
}
fn windows_path_contains(value:&str,entry:&str)->bool {
    let expected=windows_path_key(entry);
    value.split(';').any(|part| !part.trim().is_empty() && windows_path_key(part)==expected)
}
fn windows_path_add(value:&str,entry:&str)->String {
    if windows_path_contains(value,entry) { return value.into(); }
    if value.is_empty() { entry.into() }
    else { format!("{value};{entry}") }
}
fn windows_path_remove_one(value:&str,entry:&str)->String {
    let mut parts=value.split(';').collect::<Vec<_>>();
    let expected=windows_path_key(entry);
    if let Some(index)=parts.iter().rposition(|part| !part.trim().is_empty() && windows_path_key(part)==expected) {
        parts.remove(index);
    }
    parts.join(";")
}

#[cfg(unix)]
fn command_path(paths:&InstallPaths)->PathBuf { paths.home.join(".local/bin/mind") }
#[cfg(windows)]
fn command_path(paths:&InstallPaths)->PathBuf { paths.local_dir.join("cli/mind.exe") }

#[cfg(unix)]
fn preferred_profile(paths:&InstallPaths)->Option<(PathBuf,ProfileKind)> {
    let shell=paths.shell.as_deref().and_then(|value|Path::new(value).file_name()).and_then(|value|value.to_str())?;
    match shell {
        "bash"=>Some((paths.home.join(if cfg!(target_os="macos") { ".bash_profile" } else { ".bashrc" }),ProfileKind::Bash)),
        "zsh"=>Some((paths.zdotdir.as_ref().unwrap_or(&paths.home).join(".zshrc"),ProfileKind::Zsh)),
        "fish"=>Some((paths.home.join(".config/fish/conf.d/project-mind-mind.fish"),ProfileKind::Fish)),
        _=>None,
    }
}
#[cfg(windows)]
fn preferred_profile(_: &InstallPaths)->Option<(PathBuf,ProfileKind)> { Some((PathBuf::from("HKCU\\Environment\\Path"),ProfileKind::Windows)) }

#[cfg(unix)]
const START:&str="# >>> Project Mind mind CLI >>>";
#[cfg(unix)]
const END:&str="# <<< Project Mind mind CLI <<<";
#[cfg(unix)]
fn shell_quote(path:&Path)->String { format!("'{}'",display(path).replace('\'',"'\\''")) }
#[cfg(unix)]
fn managed_block(directory:&Path,kind:ProfileKind)->String {
    let command=if kind==ProfileKind::Fish {
        format!("fish_add_path --path --prepend {}",shell_quote(directory))
    } else {
        format!("export PATH={}:\"$PATH\"",shell_quote(directory))
    };
    format!("{START}\n{command}\n{END}\n")
}
#[cfg(unix)]
fn profile_bytes(path:&Path)->AgentResult<Option<String>> {
    match fs::read(path) {
        Ok(bytes)=>String::from_utf8(bytes).map(Some).map_err(|_|conflict("CLI shell profile is not UTF-8")),
        Err(error) if error.kind()==std::io::ErrorKind::NotFound=>Ok(None),
        Err(error)=>Err(io(error)),
    }
}
#[cfg(unix)]
fn block_range(content:&str,expected:&str)->AgentResult<Option<std::ops::Range<usize>>> {
    let first=content.find(START);
    let last=content.find(END);
    match (first,last) {
        (None,None)=>Ok(None),
        (Some(start),Some(_)) if content[start..].starts_with(expected)
            && content[start+expected.len()..].find(START).is_none()
            && content[start+expected.len()..].find(END).is_none()=>Ok(Some(start..start+expected.len())),
        _=>Err(conflict("Managed CLI PATH block was changed")),
    }
}
#[cfg(unix)]
fn write_profile(path:&Path,content:&str)->AgentResult<()> {
    let destination = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => fs::canonicalize(path).map_err(io)?,
        Ok(_) => path.to_path_buf(),
        Err(error) if error.kind()==std::io::ErrorKind::NotFound => path.to_path_buf(),
        Err(error) => return Err(io(error)),
    };
    let parent=destination.parent().ok_or_else(||io("profile parent"))?;
    fs::create_dir_all(parent).map_err(io)?;
    let mut temporary=tempfile::NamedTempFile::new_in(parent).map_err(io)?;
    if let Ok(metadata)=fs::metadata(&destination) { temporary.as_file().set_permissions(metadata.permissions()).map_err(io)?; }
    std::io::Write::write_all(temporary.as_file_mut(), content.as_bytes()).map_err(io)?;
    temporary.as_file().sync_all().map_err(io)?;
    temporary.persist(destination).map_err(io)?;
    Ok(())
}

#[cfg(unix)]
fn status_with(paths:&InstallPaths)->AgentResult<CliInstallationStatus> {
    let command=command_path(paths);
    let receipt=read_receipt(paths)?;
    let preferred=preferred_profile(paths);
    let profile=receipt.as_ref().and_then(|receipt|receipt.profile_path.as_ref().map(PathBuf::from))
        .or_else(||preferred.as_ref().map(|item|item.0.clone()));
    let mut state=CliInstallationStatus {
        source_path:source_exists(paths)?.then(||display(&paths.source)),
        command_path:display(&command),profile_path:profile.as_deref().map(display),
        installed:false,path_configured:in_path(&paths.path,command.parent().unwrap()),
        needs_update:false,conflict:None,manual_instruction:None,
    };
    if let Some(receipt)=receipt.as_ref() {
        if receipt.command_path!=state.command_path { state.conflict=Some("CLI installation receipt points to another command".into()); }
        match fs::symlink_metadata(&command) {
            Ok(metadata) if metadata.file_type().is_symlink()=>{
                let target=fs::read_link(&command).map_err(io)?;
                if display(&target)==receipt.source_path || target==paths.source { state.installed=true; }
                else { state.conflict=Some("Installed CLI link was changed".into()); }
            }
            Ok(_)=>state.conflict=Some("Installed CLI path is no longer our link".into()),
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>{},
            Err(error)=>return Err(io(error)),
        }
        if receipt.path_added {
            let path=receipt.profile_path.as_ref().map(PathBuf::from).ok_or_else(||conflict("CLI PATH receipt is incomplete"))?;
            let kind=receipt.profile_kind.ok_or_else(||conflict("CLI PATH receipt is incomplete"))?;
            let content=profile_bytes(&path)?.unwrap_or_default();
            let expected=managed_block(command.parent().unwrap(),kind);
            match block_range(&content,&expected) {
                Ok(Some(_))=>state.path_configured=true,
                Ok(None)=>{state.needs_update=true; state.path_configured=false;},
                Err(_)=>state.conflict=Some("Managed CLI PATH block was changed".into()),
            }
        }
        if receipt.source_path!=display(&paths.source) || !state.installed { state.needs_update=true; }
    } else if fs::symlink_metadata(&command).is_ok() {
        state.conflict=Some("CLI command exists but is not owned by this installation".into());
    }
    if receipt.is_none() {
        if let Some((path,kind))=preferred.as_ref() {
            let content=profile_bytes(path)?.unwrap_or_default();
            if content.contains(START) || content.contains(END) {
                state.conflict=Some("CLI PATH block exists without an installation receipt".into());
            }
            if kind==&ProfileKind::Fish && path.exists() {
                state.conflict=Some("CLI fish profile exists but is not owned by this installation".into());
            }
        }
    }
    if !state.path_configured && profile.is_none() {
        state.manual_instruction=Some(format!("Add {} to your shell PATH manually",display(command.parent().unwrap())));
    }
    Ok(state)
}

#[cfg(unix)]
fn install_with(paths:&InstallPaths)->AgentResult<CliInstallationStatus> {
    let state=status_with(paths)?;
    if state.conflict.is_some() { return Err(conflict("CLI command or PATH settings were changed outside Project Mind")); }
    if !source_exists(paths)? { return Err(err(ErrorCode::RuntimeUnavailable,"Bundled mind CLI is unavailable")); }
    let command=command_path(paths);
    let mut receipt=read_receipt(paths)?.unwrap_or(Receipt {
        version:1,source_path:display(&paths.source),command_path:display(&command),
        installed_hash:String::new(),profile_path:None,profile_kind:None,path_added:false,path_originally_missing:false,
        profile_separator_added:false,profile_created:false,
    });
    // The receipt is written first so a later filesystem failure is repairable.
    write_receipt(paths,&receipt)?;
    fs::create_dir_all(command.parent().unwrap()).map_err(io)?;
    if state.needs_update || !state.installed {
        if fs::symlink_metadata(&command).is_ok() { fs::remove_file(&command).map_err(io)?; }
        std::os::unix::fs::symlink(&paths.source,&command).map_err(io)?;
    }
    if !state.path_configured {
        let profile = receipt.profile_path.as_ref().zip(receipt.profile_kind).map(|(path,kind)|(PathBuf::from(path),kind))
            .or_else(||preferred_profile(paths));
        if let Some((profile,kind))=profile {
            let existing=profile_bytes(&profile)?;
            let mut content=existing.clone().unwrap_or_default();
            let block=managed_block(command.parent().unwrap(),kind);
            if block_range(&content,&block)?.is_none() {
                receipt.profile_created = existing.is_none();
                receipt.profile_separator_added = !content.is_empty() && !content.ends_with('\n');
                receipt.profile_path=Some(display(&profile));
                receipt.profile_kind=Some(kind);
                receipt.path_added=true;
                write_receipt(paths,&receipt)?;
                if receipt.profile_separator_added { content.push('\n'); }
                content.push_str(&block);
                write_profile(&profile,&content)?;
            }
        }
    }
    receipt.source_path=display(&paths.source);
    write_receipt(paths,&receipt)?;
    let done=status_with(paths)?;
    if done.conflict.is_some() || !done.installed { return Err(err(ErrorCode::IoFailed,"CLI installation did not complete")); }
    Ok(done)
}

#[cfg(unix)]
fn uninstall_with(paths:&InstallPaths)->AgentResult<CliInstallationStatus> {
    let state=status_with(paths)?;
    if state.conflict.is_some() { return Err(conflict("CLI command or PATH settings were changed outside Project Mind")); }
    let Some(receipt)=read_receipt(paths)? else { return Ok(state); };
    let command=command_path(paths);
    if fs::symlink_metadata(&command).is_ok() { fs::remove_file(&command).map_err(io)?; }
    if receipt.path_added {
        let profile=PathBuf::from(receipt.profile_path.as_ref().ok_or_else(||conflict("CLI PATH receipt is incomplete"))?);
        let kind=receipt.profile_kind.ok_or_else(||conflict("CLI PATH receipt is incomplete"))?;
        if let Some(content)=profile_bytes(&profile)? {
            if let Some(range)=block_range(&content,&managed_block(command.parent().unwrap(),kind))? {
                let mut updated=content;
                let start=if receipt.profile_separator_added && range.start>0 && updated.as_bytes()[range.start-1]==b'\n' { range.start-1 } else { range.start };
                updated.replace_range(start..range.end,"");
                if receipt.profile_created && updated.is_empty() { fs::remove_file(&profile).map_err(io)?; }
                else { write_profile(&profile,&updated)?; }
            }
        }
    }
    fs::remove_file(receipt_path(paths)).map_err(io)?;
    status_with(paths)
}

#[cfg(windows)]
#[path = "cli_install_windows.rs"]
mod windows;

pub(crate) fn status(local_dir:&Path)->AgentResult<CliInstallationStatus> {
    let paths=real_paths(local_dir)?;
    #[cfg(unix)] { status_with(&paths) }
    #[cfg(windows)] { windows::status_with(&paths) }
}
pub(crate) fn install(local_dir:&Path)->AgentResult<CliInstallationStatus> {
    let paths=real_paths(local_dir)?;
    #[cfg(unix)] { install_with(&paths) }
    #[cfg(windows)] { windows::install_with(&paths) }
}
pub(crate) fn uninstall(local_dir:&Path)->AgentResult<CliInstallationStatus> {
    let paths=real_paths(local_dir)?;
    #[cfg(unix)] { uninstall_with(&paths) }
    #[cfg(windows)] { windows::uninstall_with(&paths) }
}

#[cfg(test)]
#[path = "cli_install_tests.rs"]
mod tests;
