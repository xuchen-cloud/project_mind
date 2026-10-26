//! Native ownership of the DSH host and provider sessions.
#[cfg(unix)]
#[path = "dsh_process_unix.rs"]
mod unix;
#[cfg(windows)]
#[path = "dsh_process_windows.rs"]
mod windows;
#[cfg(unix)]
pub fn helper_main() -> Option<i32> {
    unix::helper_main()
}
#[cfg(not(unix))]
pub fn helper_main() -> Option<i32> {
    None
}

pub(crate) struct Lifetime {
    #[cfg(unix)]
    guardian: Option<unix::Guardian>,
    #[cfg(windows)]
    job: Option<windows::JobLease>,
}
impl Lifetime {
    pub(crate) async fn prepare(command: &mut tokio::process::Command) -> Result<Self, String> {
        #[cfg(unix)]
        {
            let executable = command.as_std().get_envs().find_map(|(key, value)| {
                (key == unix::HELPER_ENV)
                    .then(|| value.map(std::path::PathBuf::from))
                    .flatten()
            });
            let guardian = if let Some(executable) = executable {
                let guardian =
                    tokio::task::spawn_blocking(move || unix::Guardian::start(&executable))
                        .await
                        .map_err(|_| "助手进程保护启动中断")?
                        .map_err(|error| format!("无法保护助手进程：{error}"))?;
                *command = tokio::process::Command::from(guardian.wrap(command.as_std()));
                Some(guardian)
            } else {
                None
            }; // Raw fixture processes have no provider/plugin runtime.
            Ok(Self { guardian })
        }
        #[cfg(windows)]
        {
            let _ = command;
            Ok(Self { job: None })
        }
    }
    pub(crate) fn attach(&mut self, child: &tokio::process::Child) -> Result<(), String> {
        #[cfg(windows)]
        {
            self.job = Some(
                windows::JobLease::attach(child)
                    .map_err(|error| format!("无法保护助手进程：{error}"))?,
            );
        }
        let _ = child;
        Ok(())
    }
    pub(crate) async fn finish(&mut self) -> Result<(), String> {
        #[cfg(unix)]
        if let Some(mut guardian) = self.guardian.take() {
            tokio::task::spawn_blocking(move || guardian.finish())
                .await
                .map_err(|_| "助手进程清理中断")?
                .map_err(|error| format!("助手进程清理失败：{error}"))?;
        }
        #[cfg(windows)]
        {
            self.job.take();
        }
        Ok(())
    }
}
