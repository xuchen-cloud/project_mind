//! Project Mind local command line client.
use project_mind_alpha_lib::agent::bridge::cli;
use std::io::{self, Write};

fn main() {
    let result = cli::run(&std::env::args().skip(1).collect::<Vec<_>>());
    if !result.stdout.is_empty() {
        let _ = io::stdout().write_all(result.stdout.as_bytes());
    }
    if !result.stderr.is_empty() {
        let _ = io::stderr().write_all(result.stderr.as_bytes());
    }
    std::process::exit(result.exit_code);
}
