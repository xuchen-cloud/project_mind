//! A workspace transition cancels an unfinished assistant boot, without
//! interrupting an already admitted session or waiting for its ready timeout.
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::watch;

const CANCELLED: &str = "工作区正在切换，助手启动已取消";

pub(super) struct BootControl {
    transitions: AtomicUsize,
    cancelled: watch::Sender<u64>,
}

impl Default for BootControl {
    fn default() -> Self {
        Self { transitions: AtomicUsize::new(0), cancelled: watch::channel(0).0 }
    }
}

impl BootControl {
    pub(super) fn transition(&self) -> Transition<'_> {
        self.transitions.fetch_add(1, Ordering::SeqCst);
        self.cancel();
        Transition(self)
    }

    pub(super) fn cancel(&self) {
        self.cancelled.send_modify(|generation| *generation = generation.wrapping_add(1));
    }

    pub(super) async fn run<T>(&self, boot: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
        let mut cancelled = self.cancelled.subscribe();
        if self.transitions.load(Ordering::SeqCst) != 0 { return Err(CANCELLED.into()); }
        tokio::select! {
            biased;
            _ = cancelled.changed() => Err(CANCELLED.into()),
            result = boot => result,
        }
    }
}

pub(super) struct Transition<'a>(&'a BootControl);
impl Drop for Transition<'_> {
    fn drop(&mut self) { self.0.transitions.fetch_sub(1, Ordering::SeqCst); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn transition_cancels_inflight_boot_and_blocks_queued_boots() {
        let control = Arc::new(BootControl::default());
        let (started, ready) = oneshot::channel();
        let (dropped, cleanup) = oneshot::channel();
        struct OnDrop(Option<oneshot::Sender<()>>);
        impl Drop for OnDrop { fn drop(&mut self) { let _ = self.0.take().unwrap().send(()); } }
        let worker = control.clone();
        let task = tokio::spawn(async move {
            worker.run(async move {
                let _resource = OnDrop(Some(dropped));
                started.send(()).unwrap();
                std::future::pending::<Result<(), String>>().await
            }).await
        });
        ready.await.unwrap();
        let transition = control.transition();
        assert_eq!(tokio::time::timeout(std::time::Duration::from_secs(1), task).await.unwrap().unwrap(), Err(CANCELLED.into()));
        cleanup.await.unwrap();
        let queued = control.run(async { panic!("queued boot must not start during transition"); #[allow(unreachable_code)] Ok(()) }).await;
        assert_eq!(queued, Err(CANCELLED.into()));
        let another = control.transition();
        drop(transition);
        assert_eq!(control.run(async { Ok(()) }).await, Err(CANCELLED.into()));
        drop(another);
        assert_eq!(control.run(async { Ok(()) }).await, Ok(()));
    }
}
