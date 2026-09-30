//! Offline discovery entry point. AI-09 adds authenticated bridge and MCP stdio.
use project_mind_alpha_lib::agent::{
    capabilities::capabilities,
    errors::{AgentError, ApiResponse, ErrorCode},
};

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let request_id = "cli-discovery".to_string();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["--version"] => println!("mind {}", env!("CARGO_PKG_VERSION")),
        [] | ["--help"] | ["help"] => println!(
            "mind — AI framework scaffold\n\nUsage:\n  mind --version\n  mind capabilities --json\n\nWorkspace bridge and MCP execution are not available yet (AI-09)."),
        ["capabilities", "--json"] => println!("{}", serde_json::to_string(
            &ApiResponse::from_result(request_id, Ok(capabilities()))).unwrap()),
        ["mcp", "serve", ..] => {
            // No non-JSON-RPC output on MCP stdout, even when unavailable.
            eprintln!("RUNTIME_UNAVAILABLE: MCP transport is not implemented (AI-09)");
            std::process::exit(3);
        }
        _ => {
            let response: ApiResponse<()> = ApiResponse::from_result(request_id,
                Err(AgentError::new(ErrorCode::InvalidArgument, "Unsupported scaffold command; see mind --help")));
            println!("{}", serde_json::to_string(&response).unwrap());
            std::process::exit(2);
        }
    }
}
