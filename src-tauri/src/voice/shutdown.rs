//! A reversible voice admission fence while application teardown awaits I/O.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[derive(Default)]
pub(crate) struct ClosingFlag(AtomicBool);

pub(crate) struct ClosingLease(Arc<ClosingFlag>);

impl ClosingFlag {
    /// The caller reserves while holding the capture owner mutex.
    pub(crate) fn reserve(self: &Arc<Self>) -> Option<ClosingLease> {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| ClosingLease(self.clone()))
    }

    pub(crate) fn is_closing(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

impl Drop for ClosingLease {
    fn drop(&mut self) {
        self.0 .0.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_teardown_rejects_new_admission_and_failure_reopens_it() {
        let flag = Arc::new(ClosingFlag::default());
        let lease = flag.reserve().unwrap();
        let (finish, waiting) = std::sync::mpsc::channel();
        let teardown = std::thread::spawn(move || {
            waiting.recv().unwrap(); // asynchronous shutdown returns an error
            drop(lease);
        });
        let closed_during_teardown = flag.is_closing();
        finish.send(()).unwrap();
        teardown.join().unwrap();
        assert!(
            closed_during_teardown,
            "start was admitted while teardown awaited"
        );
        assert!(
            !flag.is_closing(),
            "failed exit must reopen voice admission"
        );
        assert!(
            flag.reserve().is_some(),
            "user can try again after a failed exit"
        );
    }

    #[test]
    fn concurrent_exit_cannot_release_another_exit_lease() {
        let flag = Arc::new(ClosingFlag::default());
        let first = flag.reserve().unwrap();
        let second = flag.reserve();
        assert!(second.is_none());
        assert!(flag.is_closing());
        drop(first);
        assert!(!flag.is_closing());
    }
}
