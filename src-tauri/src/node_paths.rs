//! Paths passed to Node's permission matcher must use Win32 spelling.
use std::path::{Path, PathBuf};

pub(crate) fn permission_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::{
            ffi::OsString,
            path::{Component, Prefix},
        };
        let mut components = path.components();
        let root = match components.next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::VerbatimDisk(drive) => PathBuf::from(format!("{}:", drive as char)),
                Prefix::VerbatimUNC(server, share) => {
                    let mut root = OsString::from(r"\\");
                    root.push(server);
                    root.push(r"\");
                    root.push(share);
                    PathBuf::from(root)
                }
                _ => return path.to_owned(),
            },
            _ => return path.to_owned(),
        };
        let mut result = root;
        for component in components {
            // An UNC prefix already contains its root; pushing RootDir would
            // discard the server/share on Windows.
            if matches!(component, Component::RootDir) {
                if matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::VerbatimDisk(_)))
                {
                    result.push(r"\");
                }
            } else {
                result.push(component.as_os_str());
            }
        }
        return result;
    }
    #[cfg(not(windows))]
    path.to_owned()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn permission_spelling_preserves_disk_and_unc_roots() {
        for (input, expected) in [
            (r"\\?\C:\test\src", r"C:\test\src"),
            (r"\\?\C:\", r"C:\"),
            (r"\\?\UNC\server\share\src", r"\\server\share\src"),
            (r"\\?\UNC\server\share\", r"\\server\share"),
            (r"C:\test\src", r"C:\test\src"),
            (r"\\server\share\src", r"\\server\share\src"),
        ] {
            assert_eq!(permission_path(Path::new(input)), PathBuf::from(expected));
        }
    }

    #[test]
    #[ignore = "requires staged fixed Node 24.21.0 and record worker resources"]
    fn fixed_node_permissions_allow_worker_and_reject_outside_file() {
        use std::{
            io::Write,
            os::windows::process::CommandExt,
            process::{Command, Stdio},
        };
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/agent-host");
        let node = root.join("node.exe").canonicalize().unwrap();
        let source = root.join("src").canonicalize().unwrap();
        let distribution = root.join("dist").canonicalize().unwrap();
        let mut child = Command::new(&node)
            .creation_flags(0x08000000)
            .arg("--permission")
            .arg("--import=data:text/javascript,if(process.versions.node!==%2724.21.0%27)throw%20new%20Error(%27Unsupported%20utility%20runtime%27)")
            .arg(format!("--allow-fs-read={}", permission_path(&source).display()))
            .arg(format!("--allow-fs-read={}", permission_path(&distribution).display()))
            .arg(source.join("record-worker-entry.mjs"))
            .env_clear().env("SystemRoot", std::env::var_os("SystemRoot").unwrap())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"{\"requestId\":\"permission-regression\",\"method\":\"record.schema\"}\n")
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("\"ok\":true"));
        let output = Command::new(node)
            .creation_flags(0x08000000)
            .arg("--permission")
            .arg(format!(
                "--allow-fs-read={}",
                permission_path(&source).display()
            ))
            .arg("--input-type=module")
            .arg("--eval")
            .arg("import fs from 'node:fs';fs.readFileSync(process.argv[1])")
            .arg(root.join("runtime.json"))
            .env_clear()
            .env("SystemRoot", std::env::var_os("SystemRoot").unwrap())
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("ERR_ACCESS_DENIED"));
    }
}
