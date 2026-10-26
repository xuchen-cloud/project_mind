//! A native inference helper must end when its owning application disappears.
use std::io;

pub(crate) fn watch_parent() -> io::Result<()> {
    // This reader blocks in the OS pipe. EOF also arrives after parent SIGKILL
    // or crash, so synchronous native inference cannot outlive its owner.
    // Do not join this detached thread on a normal helper return: main exits
    // the helper process and releases the blocked reader with it.
    std::thread::Builder::new()
        .name("voice-diarization-parent".into())
        .spawn(|| {
            use io::Read;
            let stdin = io::stdin();
            let mut input = stdin.lock();
            let mut byte = [0];
            loop {
                match input.read(&mut byte) {
                    Ok(0) => std::process::exit(1),
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(_) => std::process::exit(1),
                }
            }
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Read,
        path::Path,
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };

    const DIRECTORY: &str = "PROJECT_MIND_DIARIZATION_PARENT_TEST_DIRECTORY";

    fn fixture_command(name: &str, directory: &Path) -> Command {
        // Strip the crate name: this works in both cargo's library test binary
        // and a standalone `rustc --test diarization_parent.rs` binary.
        let module = module_path!().split_once("::").unwrap().1;
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", &format!("{module}::{name}"), "--nocapture"])
            .env(DIRECTORY, directory)
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
    }

    #[test]
    fn helper_fixture() {
        let Some(directory) = std::env::var_os(DIRECTORY) else {
            return;
        };
        watch_parent().unwrap();
        std::fs::write(Path::new(&directory).join("helper-ready"), b"ready").unwrap();
        // A finite safety deadline cleans up even when running the red test
        // without the parent watcher. No device, model or external request.
        std::thread::sleep(Duration::from_secs(5));
    }

    #[test]
    fn parent_fixture() {
        let Some(directory) = std::env::var_os(DIRECTORY) else {
            return;
        };
        let mut command = fixture_command("helper_fixture", Path::new(&directory));
        command.stdin(Stdio::piped()).stdout(Stdio::inherit());
        // Keep Child.stdin owned throughout the parent's entire lifetime.
        let _helper = command.spawn().unwrap();
        std::fs::write(Path::new(&directory).join("parent-ready"), b"ready").unwrap();
        std::thread::sleep(Duration::from_secs(10));
    }

    struct Parent(Child);
    impl Drop for Parent {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn killing_parent_ends_helper_without_polling_process_tables() {
        let directory = std::env::temp_dir().join(format!(
            "mind-voice-parent-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let mut command = fixture_command("parent_fixture", &directory);
        command.stdin(Stdio::null()).stdout(Stdio::piped());
        let mut parent = Parent(command.spawn().unwrap());
        let mut output = parent.0.stdout.take().unwrap();
        let (eof, received) = std::sync::mpsc::channel();
        // The helper inherits this pipe's write end. Once the parent is killed,
        // EOF proves that the helper has also exited; no `ps` polling is needed.
        let observer = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            output.read_to_end(&mut bytes).unwrap();
            let _ = eof.send(());
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while !(directory.join("parent-ready").exists() && directory.join("helper-ready").exists())
        {
            assert!(
                Instant::now() < deadline,
                "parent/helper fixture did not start"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let started = Instant::now();
        parent.0.kill().unwrap();
        parent.0.wait().unwrap();
        let stopped = received.recv_timeout(Duration::from_secs(2)).is_ok();
        observer.join().unwrap(); // red fixture self-cleans at five seconds
        let _ = std::fs::remove_dir_all(&directory);
        assert!(stopped, "helper survived its owning parent's forced exit");
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
