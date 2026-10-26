//! A kill-on-close Job is also released when Node exits before the app does.
use std::{
    ffi::c_void,
    sync::{Arc, Mutex},
};
use tokio::process::Child;
type Handle = *mut c_void;
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> Handle;
    fn DuplicateHandle(
        source: Handle,
        handle: Handle,
        target: Handle,
        duplicate: *mut Handle,
        access: u32,
        inherit: i32,
        options: u32,
    ) -> i32;
    fn WaitForSingleObject(handle: Handle, millis: u32) -> u32;
    fn CloseHandle(handle: Handle) -> i32;
}
pub(super) struct JobLease(Arc<Mutex<Option<crate::office_process::ProcessTree>>>);
impl JobLease {
    pub(super) fn attach(child: &Child) -> Result<Self, String> {
        let job = crate::office_process::ProcessTree::attach(child)
            .map_err(|error| format!("无法保护助手进程：{error}"))?;
        let process = child.raw_handle().ok_or("无法取得助手进程句柄")?;
        let mut duplicate = std::ptr::null_mut();
        let current = unsafe { GetCurrentProcess() };
        if unsafe { DuplicateHandle(current, process as Handle, current, &mut duplicate, 0, 0, 2) }
            == 0
        {
            return Err("无法监视助手进程退出".into());
        }
        let lease = Self(Arc::new(Mutex::new(Some(job))));
        let state = lease.0.clone();
        let process = duplicate as usize;
        if std::thread::Builder::new()
            .name("dsh-job-exit".into())
            .spawn(move || {
                // A duplicated kernel handle pins identity across PID reuse and
                // remains valid after Tokio reaps/closes its own process handle.
                unsafe {
                    WaitForSingleObject(process as Handle, u32::MAX);
                }
                state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take();
                unsafe {
                    CloseHandle(process as Handle);
                }
            })
            .is_err()
        {
            unsafe {
                CloseHandle(duplicate);
            }
            return Err("无法启动助手退出监视".into());
        }
        Ok(lease)
    }
}
impl Drop for JobLease {
    fn drop(&mut self) {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
    }
}
