#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    // The bundled executable is also the native CPU utility. Dispatch before
    // Tauri initializes so helper launches never create application windows.
    if let Some(code) = project_mind_alpha_lib::dsh_process::helper_main() {
        std::process::exit(code);
    }
    if let Some(code) = project_mind_alpha_lib::voice::diarization_process::helper_main() {
        std::process::exit(code);
    }
    project_mind_alpha_lib::run();
}
