//! Project Mind local command line client.
use project_mind_alpha_lib::agent::bridge::cli;
use std::io::{self, Write};

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.get(0).is_some_and(|arg| arg == "mcp") && args.get(1).is_some_and(|arg| arg == "serve")
    {
        std::process::exit(cli::run_mcp(&args[2..]));
    }
    let result = cli::run(&args);
    if !result.stdout.is_empty() {
        let _ = io::stdout().write_all(result.stdout.as_bytes());
    }
    if !result.stderr.is_empty() {
        let _ = io::stderr().write_all(result.stderr.as_bytes());
    }
    std::process::exit(result.exit_code);
}
