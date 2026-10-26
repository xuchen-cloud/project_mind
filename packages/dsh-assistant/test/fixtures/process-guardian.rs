#[path="../../../../src-tauri/src/dsh_process_unix.rs"] mod owned;
fn main() {
    if let Some(code) = owned::helper_main() { std::process::exit(code); }
    let mut args = std::env::args_os().skip(1);
    let mut original = std::process::Command::new(args.next().expect("command"));
    original.args(args);
    let mut guard = owned::Guardian::start(&std::env::current_exe().unwrap()).unwrap();
    let status = guard.wrap(&original).status().unwrap();
    guard.finish().unwrap();
    std::process::exit(status.code().unwrap_or(1));
}
