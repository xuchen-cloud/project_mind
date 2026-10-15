//! Office worker children share its bounded lifetime, including cancellation.
use crate::agent::errors::{AgentError, AgentResult, ErrorCode};
use tokio::process::{Child, Command};

pub(crate) fn configure(command: &mut Command) {
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    let _ = command;
}
#[cfg(unix)]
pub(crate) struct ProcessTree(i32);
#[cfg(unix)]
impl ProcessTree {
    pub(crate) fn attach(child: &Child) -> AgentResult<Self> {
        child.id().map(|pid| Self(pid as i32)).ok_or_else(|| {
            AgentError::new(ErrorCode::IoFailed, "Office process identity unavailable")
        })
    }
}
#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe extern "C" {
            fn kill(pid: i32, signal: i32) -> i32;
        }
        // A new process group contains only this fixed worker and its sidecar.
        unsafe {
            kill(-self.0, 9);
        }
    }
}
#[cfg(windows)]
mod windows {
    use super::*;
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working: usize,
        max_working: usize,
        active_processes: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process: usize,
        peak_job: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            information: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    pub(crate) struct ProcessTree(Handle);
    // The opaque job handle is owned and closed once; it is never dereferenced.
    unsafe impl Send for ProcessTree {}
    impl ProcessTree {
        pub(crate) fn attach(child: &Child) -> AgentResult<Self> {
            let error = || {
                AgentError::new(
                    ErrorCode::RuntimeUnavailable,
                    "Cannot bound Office sidecar lifetime",
                )
            };
            let process = child.raw_handle().ok_or_else(error)?;
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() {
                return Err(error());
            }
            let guard = Self(job);
            let limits = ExtendedLimits {
                basic: BasicLimits {
                    flags: 0x2000,
                    ..Default::default()
                },
                ..Default::default()
            };
            if unsafe {
                SetInformationJobObject(
                    job,
                    9,
                    &limits as *const _ as *const c_void,
                    std::mem::size_of::<ExtendedLimits>() as u32,
                )
            } == 0
                || unsafe { AssignProcessToJobObject(job, process as Handle) } == 0
            {
                return Err(error());
            }
            Ok(guard)
        }
    }
    impl Drop for ProcessTree {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
#[cfg(windows)]
pub(crate) use windows::ProcessTree;
