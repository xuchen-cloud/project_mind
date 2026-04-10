use std::{env, path::PathBuf, process};

use serde::Serialize;

use project_mind_alpha_lib::{
    default_app_database_path, default_demo_workspace_root, seed_demo_database_at, DemoSeedResult,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeedCommandOutput {
    db_path: String,
    summary: DemoSeedResult,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    let mut args = env::args().skip(1);
    let mut db_path: Option<PathBuf> = None;
    let mut workspace_root: Option<PathBuf> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db-path" => {
                let value = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--db-path requires a value"))?;
                db_path = Some(PathBuf::from(value));
            }
            "--workspace-root" => {
                let value = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("--workspace-root requires a value"))?;
                workspace_root = Some(PathBuf::from(value));
            }
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

    let db_path = db_path.unwrap_or(default_app_database_path()?);
    let workspace_root = workspace_root.unwrap_or(default_demo_workspace_root()?);
    let summary = seed_demo_database_at(&db_path, &workspace_root)?;

    let output = SeedCommandOutput {
        db_path: db_path.to_string_lossy().to_string(),
        summary,
    };
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

fn print_usage() {
    println!(
        "Usage: cargo run --manifest-path src-tauri/Cargo.toml --bin seed_demo_data [--db-path <path>] [--workspace-root <path>]"
    );
}
