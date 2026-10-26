//! Fast ticks belong to live capture; idle work wakes on an explicit mutation.
use std::sync::{Condvar, Mutex};
use std::time::Duration;

pub(crate) const ACTIVE_INTERVAL: Duration = Duration::from_millis(250);
pub(crate) const IDLE_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Wake {
    generation: Mutex<u64>,
    changed: Condvar,
}

impl Wake {
    fn notify(&self) {
        let mut generation = self
            .generation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *generation = generation.wrapping_add(1);
        self.changed.notify_one();
    }

    fn wait(&self, observed: &mut u64, interval: Duration) {
        let generation = self
            .generation
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (generation, _) = self
            .changed
            .wait_timeout_while(generation, interval, |value| *value == *observed)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *observed = *generation;
    }
}

static WAKE: std::sync::LazyLock<Wake> = std::sync::LazyLock::new(Wake::default);

pub(crate) fn wake() {
    WAKE.notify();
}
pub(crate) fn wait(observed: &mut u64, interval: Duration) {
    WAKE.wait(observed, interval);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn work_queued_before_wait_is_not_lost() {
        let wake = Wake::default();
        let mut observed = 0;
        wake.notify();
        let start = std::time::Instant::now();
        wake.wait(&mut observed, IDLE_INTERVAL);
        assert!(start.elapsed() < Duration::from_secs(1));
        assert_eq!(observed, 1);
    }
    #[test]
    fn new_job_wakes_an_idle_supervisor() {
        let wake = Wake::default();
        std::thread::scope(|scope| {
            let start = std::time::Instant::now();
            let sender = &wake;
            let send = scope.spawn(move || {
                std::thread::sleep(Duration::from_millis(10));
                sender.notify();
            });
            wake.wait(&mut 0, IDLE_INTERVAL);
            assert!(start.elapsed() < Duration::from_secs(1));
            send.join().unwrap();
        });
    }
}
