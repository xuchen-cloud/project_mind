//! Test transport only. Range parsing, file reads, scope checks and response
//! headers below come from the installed, unmodified Tauri asset.rs.
use std::{io::{Read, Write}, net::{TcpListener, TcpStream}, path::PathBuf};
mod path { pub use tauri::path::SafePathBuf; }
mod scope { pub use tauri::scope::*; }
mod async_runtime {
    use std::future::Future;
    pub use tauri::async_runtime::block_on;
    include!(env!("VOICE_TAURI_SAFE_BLOCK_ON"));
}
mod webview {
    pub type UriSchemeProtocolHandler = Box<dyn Fn(&str, http::Request<Vec<u8>>, tauri::UriSchemeResponder) + Send + Sync>;
}
#[allow(dead_code)]
mod actual_asset {
    include!(env!("VOICE_TAURI_ASSET_SOURCE"));
    pub fn respond(request: http::Request<Vec<u8>>, scope: &tauri::scope::fs::Scope)
        -> Result<http::Response<std::borrow::Cow<'static, [u8]>>, Box<dyn std::error::Error>> {
        get_response(request, scope, "http://tauri.localhost")
    }
}
fn connection(mut stream: TcpStream, scope: tauri::scope::fs::Scope, root: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let mut input = Vec::new();
    let mut byte = [0];
    while !input.ends_with(b"\r\n\r\n") {
        if input.len() >= 16_384 { return Err("HTTP request too large".into()); }
        if stream.read(&mut byte)? == 0 { return Ok(()); }
        input.push(byte[0]);
    }
    let request = std::str::from_utf8(&input)?;
    let mut lines = request.split("\r\n");
    let mut first = lines.next().ok_or("missing request line")?.split_whitespace();
    let method = first.next().ok_or("missing method")?;
    let path = first.next().ok_or("missing path")?;
    let range = lines.filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("range")).map(|(_, value)| value.trim());
    let response = if let Some(encoded) = path.strip_prefix("/asset/") {
        let mut builder = http::Request::builder().method(method).uri(format!("asset://localhost/{encoded}"));
        if let Some(range) = range { builder = builder.header("Range", range); }
        let response = actual_asset::respond(builder.body(Vec::new())?, &scope)?;
        println!("{}", serde_json::json!({"kind":"asset", "path":encoded, "range":range,
            "status":response.status().as_u16(), "contentRange":response.headers().get("content-range").and_then(|h|h.to_str().ok()),
            "bytes":response.body().len()}));
        response
    } else {
        let (name, mime) = match path {
            "/" => ("index.html", "text/html"),
            "/voice-player.js" => ("voice-player.js", "text/javascript"),
            "/browser.mjs" => ("browser.mjs", "text/javascript"),
            _ => return Err("unknown test route".into()),
        };
        http::Response::builder().header("Content-Type", mime).body(std::borrow::Cow::Owned(std::fs::read(root.join(name))?))?
    };
    write!(stream, "HTTP/1.1 {} {}\r\n", response.status().as_u16(), response.status().canonical_reason().unwrap_or(""))?;
    for (name, value) in response.headers() { write!(stream, "{}: {}\r\n", name, value.to_str()?)?; }
    if !response.headers().contains_key("content-length") { write!(stream, "Content-Length: {}\r\n", response.body().len())?; }
    write!(stream, "Connection: close\r\n\r\n")?;
    stream.write_all(response.body())?;
    Ok(())
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(std::env::args().nth(1).ok_or("fixture root required")?);
    // MockRuntime only supplies Tauri's App/Scope container; no Webview is built.
    let app = tauri::test::mock_app();
    let scope = tauri::scope::fs::Scope::new(&app, &tauri::utils::config::FsScope::Scope {
        allow: vec![], deny: vec![], require_literal_leading_dot: Some(true),
    })?;
    for file in std::fs::read_dir(root.join(".project-mind/voice"))? {
        let file = file?;
        if file.path().extension().is_some_and(|extension| extension == "wav") { scope.allow_file(file.path())?; }
    }
    let listener = TcpListener::bind("127.0.0.1:0")?;
    println!("{}", serde_json::json!({"kind":"ready", "url":format!("http://{}",listener.local_addr()?)}));
    for stream in listener.incoming() {
        let scope = scope.clone(); let root = root.clone(); let stream = stream?;
        std::thread::spawn(move || { if let Err(error) = connection(stream, scope, root) { eprintln!("asset transport: {error}"); } });
    }
    Ok(())
}
