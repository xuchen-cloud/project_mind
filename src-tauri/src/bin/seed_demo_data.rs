use std::{env, path::PathBuf, process};

use serde::Serialize;

use project_mind_alpha_lib::{default_demo_workspace_root, seed_demo_workspace_at};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeedCommandOutput {
    workspace_root: String,
    metadata_path: String,
    summary: project_mind_alpha_lib::DemoSeedResult,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    let mut args = env::args().skip(1);
    let mut workspace_root: Option<PathBuf> = None;
    let mut password: Option<String> = None;
    let mut force = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--workspace-root" => {
                let value = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--workspace-root requires a value"))?;
                workspace_root = Some(PathBuf::from(value));
            }
            "--password" => {
                password = Some(
                    args.next()
                        .ok_or_else(|| anyhow::anyhow!("--password requires a value"))?,
                );
            }
            "--force" => force = true,
            "--help" | "-h" => {
                print_usage();
                return Ok(());
            }
            other => {
                return Err(anyhow::anyhow!(
                    "unrecognized argument: {other}\n\nUse --help to see supported options."
                ));
            }
        }
    }

    let workspace_root = workspace_root.unwrap_or(default_demo_workspace_root()?);
    let password = password
        .ok_or_else(|| anyhow::anyhow!("--password is required for demo workspace seed"))?;
    let seeded = seed_demo_workspace_at(&workspace_root, &password, force)?;

    println!(
        "{}",
        serde_json::to_string_pretty(&SeedCommandOutput {
            workspace_root: seeded.workspace_root,
            metadata_path: seeded.metadata_path,
            summary: seeded.summary,
        })?
    );
    Ok(())
}

fn print_usage() {
    println!(
        "Usage: cargo run --manifest-path src-tauri/Cargo.toml --bin seed_demo_data [--workspace-root <path>] --password <value> [--force]"
    );
}
