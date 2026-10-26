//! Coalesced wake hints for independent native maintenance workers.
use std::time::Duration;
use tokio::{sync::Notify, time::Instant};

pub(crate) const IDLE_RECHECK: Duration = Duration::from_secs(30);

#[derive(Default)]
pub(crate) struct MaintenanceWake(Notify);

impl MaintenanceWake {
    pub(crate) fn wake(&self) {
        self.0.notify_one();
    }

    pub(crate) async fn wait(&self, delay: Duration) {
        tokio::select! { _ = self.0.notified() => {}, _ = tokio::time::sleep(delay) => {} }
    }

    pub(crate) async fn wait_after(&self, delay: Duration, started: Instant, minimum: Duration) {
        self.wait(delay).await;
        // Coalesce commit bursts without restarting a debounce timer forever.
        // A timer already due never incurs another minimum interval after it.
        tokio::time::sleep_until(started + minimum).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hints_coalesce_and_idle_worker_does_not_repeat_scans() {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async {
                let wake = MaintenanceWake::default();
                let mut scans = 0;
                let worker = async {
                    loop {
                        scans += 1;
                        wake.wait_after(IDLE_RECHECK, Instant::now(), Duration::from_millis(20))
                            .await;
                    }
                };
                assert!(tokio::time::timeout(Duration::from_millis(60), worker)
                    .await
                    .is_err());
                assert_eq!(scans, 1, "an empty worker repeated its storage scan");
                for _ in 0..100 {
                    wake.wake();
                }
                tokio::time::timeout(Duration::from_millis(50), wake.wait(IDLE_RECHECK))
                    .await
                    .unwrap();
                assert!(
                    tokio::time::timeout(Duration::from_millis(50), wake.wait(IDLE_RECHECK))
                        .await
                        .is_err()
                );
            });
    }

    #[test]
    fn notification_burst_preserves_work_rate_and_channels_are_independent() {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async {
                let source = MaintenanceWake::default();
                let checkpoint = MaintenanceWake::default();
                let started = Instant::now();
                for _ in 0..100 {
                    source.wake();
                }
                source
                    .wait_after(IDLE_RECHECK, started, Duration::from_millis(40))
                    .await;
                assert!(
                    started.elapsed() >= Duration::from_millis(40),
                    "notifications bypassed the scan budget"
                );
                assert!(tokio::time::timeout(
                    Duration::from_millis(20),
                    checkpoint.wait(IDLE_RECHECK)
                )
                .await
                .is_err());
            });
    }

    #[test]
    fn due_deadline_does_not_pay_another_cooldown_after_sleeping() {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async {
                let wake = MaintenanceWake::default();
                let last_scan = Instant::now() - Duration::from_secs(1);
                tokio::time::timeout(
                    Duration::from_millis(100),
                    wake.wait_after(
                        Duration::from_millis(5),
                        last_scan,
                        Duration::from_millis(500),
                    ),
                )
                .await
                .expect("an already due timer incurred a new half-second sleep");
            });
    }
}
