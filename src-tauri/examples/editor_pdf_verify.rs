//! Acceptance-only runner. No visible window, print panel, production startup,
//! database, or frontend server. Arguments: OUTPUT_DIR [[WIDTH_PTxHEIGHT_PT:]HTML_FILE ...].
#[path = "../src/editor_print.rs"]
#[allow(dead_code)]
mod editor_print;

use base64::Engine as _;
use editor_print::EditorPageSize;

fn main() {
    let mut args = std::env::args_os().skip(1);
    let output = std::path::PathBuf::from(args.next().expect("OUTPUT_DIR is required"));
    std::fs::create_dir_all(&output).expect("create verification directory");
    let mut cases = vec![
        ("a4".to_string(), "<!doctype html><style>@page{size:A4;margin:0}body{margin:0}.page{width:210mm;height:297mm;break-after:page}</style><div class=page>A4 first native text</div><div class=page>A4 second native text</div>".to_string(), Some(EditorPageSize{width_pt:210.0/25.4*72.0,height_pt:297.0/25.4*72.0})),
        ("wide".to_string(), "<!doctype html><style>@page{size:960px 540px;margin:0}body{margin:0}.page{width:960px;height:540px;break-after:page}</style><div class=page>16:9 native text</div>".to_string(), Some(EditorPageSize{width_pt:720.0,height_pt:405.0})),
    ];
    for argument in args {
        let argument = argument.to_str().expect("UTF-8 fixture argument");
        let (path, page_size) = match argument.split_once(':') {
            Some((size, path)) => {
                let (width, height) = size.split_once('x').expect("WIDTH_PTxHEIGHT_PT:HTML_FILE");
                (
                    path,
                    Some(EditorPageSize {
                        width_pt: width.parse().expect("width"),
                        height_pt: height.parse().expect("height"),
                    }),
                )
            }
            None => (argument, None),
        };
        let name = format!("fixture-{}", cases.len());
        cases.push((
            name,
            std::fs::read_to_string(path).expect("read HTML fixture"),
            page_size,
        ));
    }
    tauri::Builder::default()
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Prohibited);
            let main = tauri::WebviewWindowBuilder::new(
                &*app,
                "main",
                tauri::WebviewUrl::External("about:blank".parse()?),
            )
            .visible(false)
            .focused(false)
            .build()?;
            let caller = main.as_ref().window();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut failed = false;
                for (name, html, page_size) in cases {
                    let result = editor_print::desktop_render_editor_pdf(
                        handle.clone(),
                        caller.clone(),
                        editor_print::EditorPrintInput {
                            html,
                            title: Some(name.clone()),
                            page_size,
                        },
                    )
                    .await
                    .and_then(|data| {
                        let bytes = base64::engine::general_purpose::STANDARD
                            .decode(data)
                            .map_err(|e| e.to_string())?;
                        std::fs::write(output.join(format!("{name}.pdf")), &bytes)
                            .map_err(|e| e.to_string())?;
                        Ok(bytes.len())
                    });
                    match result {
                        Ok(bytes) => println!("{name}: {bytes} bytes"),
                        Err(error) => {
                            eprintln!("{name}: {error}");
                            failed = true;
                            break;
                        }
                    }
                }
                handle.exit(i32::from(failed));
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("run hidden native PDF acceptance");
}
