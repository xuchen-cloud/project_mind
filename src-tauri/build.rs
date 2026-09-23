fn main() {
    if std::env::var_os("CARGO_CFG_TARGET_OS").is_some_and(|target| target == "macos") {
        add_swift_runtime_link_path();
    }
    tauri_build::build()
}

fn add_swift_runtime_link_path() {
    use std::{path::Path, process::Command};

    let Ok(output) = Command::new("xcrun").args(["--find", "swiftc"]).output() else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let Ok(swiftc) = std::str::from_utf8(&output.stdout) else {
        return;
    };
    let Some(toolchain_usr) = Path::new(swiftc.trim()).parent().and_then(Path::parent) else {
        return;
    };
    let runtime = toolchain_usr.join("lib/swift/macosx");
    if runtime.is_dir() {
        println!("cargo:rustc-link-search=native={}", runtime.display());
        // Swift executables use this stable system rpath; the actual runtime
        // may live in the dyld shared cache rather than as a visible file.
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}
