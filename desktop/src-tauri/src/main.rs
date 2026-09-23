// Оболочка: запускает упакованный server.py (PyInstaller) на свободном порту и открывает его в окне.
// Фронт и API раздаёт сам сервер, поэтому IPC и плагины Tauri не нужны.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::webview::DownloadEvent;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

struct Server(Mutex<Option<Child>>);

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let port = TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
            let data = app.path().app_data_dir()?;
            fs::create_dir_all(&data)?;
            let root = app.path().resource_dir()?.join("server");
            let exe = root.join(if cfg!(windows) { "cockpit-server.exe" } else { "cockpit-server" });
            let log = File::create(data.join("server.log"))?;

            let mut cmd = Command::new(exe);
            cmd.current_dir(root.join("_internal")) // модули читают data/ и csv относительно cwd
                .env("PORT", port.to_string())
                .env("DATABASE_URL", format!("sqlite:///{}", data.join("cockpit.db").display()))
                .env("UPLOAD_DIR", data.join("uploads"))
                .env("ENV_FILE", data.join(".env"))
                .env("AUTH_DEMO", "1") // сервер только на 127.0.0.1; свои пользователи — AUTH_USERS в .env
                .stdout(log.try_clone()?)
                .stderr(log);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            }
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                cmd.process_group(0); // своя группа: при выходе гасим и воркеры лаборатории
            }
            app.manage(Server(Mutex::new(Some(cmd.spawn()?))));

            let downloads = app.path().download_dir()?;
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Campaign Cockpit")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .on_download(move |_, event| {
                    // CSV плана — Blob + <a download>; без обработчика webview его молча игнорирует
                    if let DownloadEvent::Requested { destination, .. } = event {
                        let name = destination.file_name().map(|n| n.to_owned()).unwrap_or_else(|| "plan.csv".into());
                        *destination = downloads.join(name);
                    }
                    true
                })
                .build()?;

            std::thread::spawn(move || {
                // ponytail: ждём порт без таймаута; если сервер упал — причина в server.log (путь на заставке)
                while TcpStream::connect(("127.0.0.1", port)).is_err() {
                    std::thread::sleep(Duration::from_millis(300));
                }
                let _ = win.navigate(format!("http://127.0.0.1:{port}/").parse().unwrap());
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("не удалось запустить приложение");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = handle.state::<Server>().0.lock().unwrap().take() {
                kill_tree(child.id());
                let _ = child.kill();
            }
        }
    });
}

// child.kill() убивает только сервер, а воркеры ProcessPool лаборатории остались бы сиротами
fn kill_tree(pid: u32) {
    #[cfg(unix)]
    let _ = Command::new("kill").args(["-9", &format!("-{pid}")]).status();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).creation_flags(0x0800_0000).status();
    }
}
