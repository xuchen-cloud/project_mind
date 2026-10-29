//! Project Mind local command line client.
use project_mind_alpha_lib::agent::bridge::cli;
use std::io::{self, IsTerminal, Write};
use std::{sync::mpsc, thread, time::Duration};

// A single terminal diagnostic while the first native response is pending.
// A channel cancels the delay immediately when content or a final result arrives.
struct WaitingNotice(Option<(mpsc::Sender<()>, thread::JoinHandle<()>)>);
impl WaitingNotice {
    fn start(args: &[String]) -> Self {
        if !io::stderr().is_terminal() || !notice_allowed(args) {
            return Self(None);
        }
        let (send, receive) = mpsc::channel();
        let worker = thread::spawn(move || {
            if matches!(
                receive.recv_timeout(Duration::from_secs(2)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                eprintln!("Waiting for Project Mind to finish processing…");
            }
        });
        Self(Some((send, worker)))
    }
    fn cancel(&mut self) {
        if let Some((send, worker)) = self.0.take() {
            let _ = send.send(());
            let _ = worker.join();
        }
    }
}
impl Drop for WaitingNotice {
    fn drop(&mut self) {
        self.cancel();
    }
}

fn notice_allowed(args: &[String]) -> bool {
    // grep owns its diagnostics and quiet semantics, including combined short flags.
    args.first().is_none_or(|arg| arg != "grep")
        && !args
            .iter()
            .any(|arg| matches!(arg.as_str(), "--json" | "--format=json" | "--quiet" | "-q"))
        && !args
            .windows(2)
            .any(|pair| pair[0] == "--format" && pair[1] == "json")
}

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.get(0).is_some_and(|arg| arg == "mcp") && args.get(1).is_some_and(|arg| arg == "serve")
    {
        std::process::exit(cli::run_mcp(&args[2..]));
    }
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    let mut broken_pipe = false;
    let mut notice = WaitingNotice::start(&args);
    let result = cli::run_streamed(&args, &mut |chunk| {
        if !chunk.is_empty() {
            notice.cancel();
        }
        stdout
            .write_all(chunk.as_bytes())
            .and_then(|_| stdout.flush())
            .map_err(|error| {
                broken_pipe = error.kind() == io::ErrorKind::BrokenPipe;
                project_mind_alpha_lib::agent::errors::AgentError::new(
                    project_mind_alpha_lib::agent::errors::ErrorCode::IoFailed,
                    format!("Cannot write stdout: {error}"),
                )
            })
    });
    notice.cancel();
    if broken_pipe {
        std::process::exit(0);
    }
    if !result.stdout.is_empty() {
        if let Err(error) = stdout
            .write_all(result.stdout.as_bytes())
            .and_then(|_| stdout.flush())
        {
            if error.kind() == io::ErrorKind::BrokenPipe {
                std::process::exit(0);
            }
            eprintln!("Cannot write stdout: {error}");
            std::process::exit(6);
        }
    }
    if !result.stderr.is_empty() {
        let _ = io::stderr().write_all(result.stderr.as_bytes());
    }
    std::process::exit(result.exit_code);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quiet_protocol_and_grep_never_receive_waiting_diagnostics() {
        for words in [
            vec!["grep", "-Finq", "abc"],
            vec!["record", "get", "1", "--json"],
            vec!["contact", "list", "--format=json"],
            vec!["record", "get", "1", "--format", "json"],
        ] {
            assert!(!notice_allowed(
                &words.into_iter().map(str::to_owned).collect::<Vec<_>>()
            ));
        }
        assert!(notice_allowed(&["record".into(), "get".into(), "1".into()]));
    }
    #[test]
    fn notice_cancellation_wakes_worker_and_is_repeatable() {
        let (send, receive) = mpsc::channel();
        let worker =
            thread::spawn(move || assert!(receive.recv_timeout(Duration::from_secs(10)).is_ok()));
        let mut notice = WaitingNotice(Some((send, worker)));
        notice.cancel();
        notice.cancel();
    }
}
