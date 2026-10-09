use super::*;

#[cfg(unix)]
fn fixture(shell:&str)->(tempfile::TempDir,InstallPaths) {
    let root=tempfile::tempdir().unwrap();
    let home=root.path().join("home");
    let bundle=root.path().join("bundle");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&bundle).unwrap();
    let source=bundle.join("mind");
    fs::write(&source,b"cli-v1").unwrap();
    let paths=InstallPaths {
        local_dir:root.path().join("app-data"),home,source,
        shell:Some(shell.into()),zdotdir:None,path:std::ffi::OsString::new(),
    };
    (root,paths)
}

#[cfg(unix)]
#[test]
fn bash_install_update_uninstall_preserves_user_profile() {
    let (_root,paths)=fixture("/bin/bash");
    let profile=preferred_profile(&paths).unwrap().0;
    fs::write(&profile,"# user line\n").unwrap();
    let before=status_with(&paths).unwrap();
    assert!(!before.installed);
    assert_eq!(before.profile_path.as_deref(),Some(display(&profile).as_str()));
    let installed=install_with(&paths).unwrap();
    assert!(installed.installed && installed.path_configured);
    assert_eq!(fs::read_link(command_path(&paths)).unwrap(),paths.source);
    assert!(fs::read_to_string(&profile).unwrap().starts_with("# user line\n"));
    let again=install_with(&paths).unwrap();
    assert!(again.installed && !again.needs_update);
    fs::write(&paths.source,b"cli-v2").unwrap();
    assert!(install_with(&paths).unwrap().installed);
    fs::remove_file(&paths.source).unwrap();
    let removed=uninstall_with(&paths).unwrap();
    assert!(!removed.installed);
    assert!(!command_path(&paths).exists());
    assert_eq!(fs::read_to_string(&profile).unwrap(),"# user line\n");
    assert!(!receipt_path(&paths).exists());
    fs::write(&paths.source,b"cli-v3").unwrap();
    let reinstalled=install_with(&paths).unwrap();
    assert!(reinstalled.installed && reinstalled.path_configured);
    assert!(!reinstalled.needs_update);
    assert!(!uninstall_with(&paths).unwrap().installed);
    assert_eq!(fs::read_to_string(&profile).unwrap(),"# user line\n");
}

#[cfg(unix)]
#[test]
fn no_final_newline_is_restored_and_new_profile_is_removed() {
    let (_root,paths)=fixture("/bin/bash");
    let profile=preferred_profile(&paths).unwrap().0;
    fs::write(&profile,"# 用户配置 without final newline").unwrap();
    install_with(&paths).unwrap();
    assert!(fs::read_to_string(&profile).unwrap().contains("\n# >>> Project Mind mind CLI >>>"));
    uninstall_with(&paths).unwrap();
    assert_eq!(fs::read_to_string(&profile).unwrap(),"# 用户配置 without final newline");

    fs::remove_file(&profile).unwrap();
    install_with(&paths).unwrap();
    assert!(profile.exists());
    uninstall_with(&paths).unwrap();
    assert!(!profile.exists());
}

#[cfg(unix)]
#[test]
fn symlink_profile_keeps_link_target_and_permissions() {
    use std::os::unix::fs::{symlink,PermissionsExt};
    let (root,paths)=fixture("/bin/bash");
    let profile=preferred_profile(&paths).unwrap().0;
    let target=root.path().join("profile target");
    fs::write(&target,"export USER_SETTING=yes\n").unwrap();
    fs::set_permissions(&target,fs::Permissions::from_mode(0o600)).unwrap();
    symlink(&target,&profile).unwrap();
    install_with(&paths).unwrap();
    assert!(fs::symlink_metadata(&profile).unwrap().file_type().is_symlink());
    assert!(fs::read_to_string(&target).unwrap().contains("Project Mind mind CLI"));
    assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777,0o600);
    uninstall_with(&paths).unwrap();
    assert!(fs::symlink_metadata(&profile).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_to_string(&target).unwrap(),"export USER_SETTING=yes\n");
    assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777,0o600);
}

#[cfg(unix)]
#[test]
fn bash_profile_with_unicode_spaces_and_quotes_sets_live_path() {
    use std::os::unix::fs::PermissionsExt;
    let (root,mut paths)=fixture("/bin/bash");
    paths.home=root.path().join("用户 space ' quote");
    fs::create_dir_all(&paths.home).unwrap();
    fs::write(&paths.source,"#!/bin/sh\nprintf 'mind-from-bundle'").unwrap();
    fs::set_permissions(&paths.source,fs::Permissions::from_mode(0o755)).unwrap();
    let profile=preferred_profile(&paths).unwrap().0;
    install_with(&paths).unwrap();
    let output=std::process::Command::new("bash")
        .args(["--noprofile","--norc","-c","source \"$1\"; mind","bash"])
        .arg(&profile)
        .env("PATH","/usr/bin:/bin")
        .output().unwrap();
    assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    assert_eq!(output.stdout.as_slice(),b"mind-from-bundle");
    uninstall_with(&paths).unwrap();
}

#[cfg(unix)]
#[test]
fn foreign_command_or_changed_managed_block_is_never_overwritten() {
    let (_root,paths)=fixture("/bin/bash");
    let command=command_path(&paths);
    fs::create_dir_all(command.parent().unwrap()).unwrap();
    fs::write(&command,b"user command").unwrap();
    assert!(status_with(&paths).unwrap().conflict.is_some());
    assert_eq!(install_with(&paths).unwrap_err().code,ErrorCode::RevisionConflict);
    assert_eq!(fs::read(&command).unwrap(),b"user command");
    fs::remove_file(&command).unwrap();
    install_with(&paths).unwrap();
    let profile=preferred_profile(&paths).unwrap().0;
    let modified=fs::read_to_string(&profile).unwrap().replace("export PATH=","# changed PATH=");
    fs::write(&profile,&modified).unwrap();
    assert!(status_with(&paths).unwrap().conflict.is_some());
    assert_eq!(uninstall_with(&paths).unwrap_err().code,ErrorCode::RevisionConflict);
    assert_eq!(fs::read_to_string(&profile).unwrap(),modified);
    assert!(fs::symlink_metadata(&command).unwrap().file_type().is_symlink());
}

#[cfg(unix)]
#[test]
fn existing_path_unknown_shell_zdotdir_and_fish_are_explicit() {
    let (_root,mut paths)=fixture("/unknown/nushell");
    let before=status_with(&paths).unwrap();
    assert!(before.profile_path.is_none());
    assert!(before.manual_instruction.is_some());
    let installed=install_with(&paths).unwrap();
    assert!(installed.installed && installed.manual_instruction.is_some());
    fs::remove_file(&paths.source).unwrap();
    assert!(!uninstall_with(&paths).unwrap().installed);

    fs::write(&paths.source,b"cli").unwrap();
    paths.shell=Some("/bin/zsh".into());
    paths.zdotdir=Some(paths.home.join("custom-zdot"));
    assert_eq!(preferred_profile(&paths).unwrap().0,paths.home.join("custom-zdot/.zshrc"));
    paths.path=env::join_paths([command_path(&paths).parent().unwrap()]).unwrap();
    let zsh=install_with(&paths).unwrap();
    assert!(zsh.path_configured);
    assert!(!paths.home.join("custom-zdot/.zshrc").exists());
    uninstall_with(&paths).unwrap();

    paths.path=std::ffi::OsString::new();
    paths.shell=Some("/usr/bin/fish".into());
    let fish=install_with(&paths).unwrap();
    let profile=paths.home.join(".config/fish/conf.d/project-mind-mind.fish");
    assert_eq!(fish.profile_path.as_deref(),Some(display(&profile).as_str()));
    assert!(fs::read_to_string(&profile).unwrap().contains("fish_add_path --path --prepend "));
    uninstall_with(&paths).unwrap();
    assert!(!profile.exists());
}

#[test]
fn windows_path_helpers_preserve_user_segments_and_remove_only_one_added_entry() {
    let original=r"C:\User Bin;;%SystemRoot%\System32;";
    let entry=r"C:\Project Mind\cli";
    let added=windows_path_add(original,entry);
    assert_eq!(added,format!("{original};{entry}"));
    assert!(windows_path_contains(&added,r"c:/project mind/cli/"));
    assert_eq!(windows_path_add(&added,entry),added);
    assert_eq!(windows_path_remove_one(&added,entry),original);
    assert_eq!(windows_path_remove_one(original,entry),original);
    let duplicate=format!("{original};{entry};{entry}");
    assert_eq!(windows_path_remove_one(&duplicate,entry),format!("{original};{entry}"));
    assert_eq!(windows_path_add("",entry),entry);
    assert_eq!(windows_path_remove_one(entry,entry),"");
}
