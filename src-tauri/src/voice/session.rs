/// All timestamps are milliseconds from the same process monotonic clock.
/// The runtime owns a single controller behind its capture mutex.
#[derive(Default)]
pub struct SessionController {
    next_id: u64,
    session: Option<Session>,
}

#[derive(Clone, Copy, Debug)]
pub struct Readiness {
    pub microphone: bool,
    pub system_audio: bool,
    pub recognition: bool,
    pub storage: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Recording,
    Paused,
    Ending,
    Ended,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PauseReason {
    User,
    Silence,
    Device,
    Storage,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionSnapshot {
    pub id: u64,
    pub phase: Phase,
    pub active_ms: u64,
    pub pause_reason: Option<PauseReason>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionError {
    AlreadyActive,
    NotReady,
    WrongSession,
    ClockWentBackwards,
    IdExhausted,
    InvalidTransition,
}

struct Session {
    snapshot: SessionSnapshot,
    recording_since: Option<u64>,
    last_transition: u64,
}

impl SessionController {
    pub fn start(&mut self, ready: Readiness, now: u64) -> Result<SessionSnapshot, SessionError> {
        if self
            .session
            .as_ref()
            .is_some_and(|s| s.snapshot.phase != Phase::Ended)
        {
            return Err(SessionError::AlreadyActive);
        }
        if !ready.microphone || !ready.system_audio || !ready.recognition || !ready.storage {
            return Err(SessionError::NotReady);
        }
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or(SessionError::IdExhausted)?;
        let snapshot = SessionSnapshot {
            id: self.next_id,
            phase: Phase::Recording,
            active_ms: 0,
            pause_reason: None,
        };
        self.session = Some(Session {
            snapshot: snapshot.clone(),
            recording_since: Some(now),
            last_transition: now,
        });
        Ok(snapshot)
    }

    pub fn snapshot(&self, now: u64) -> Option<SessionSnapshot> {
        self.session.as_ref().map(|session| {
            let mut snapshot = session.snapshot.clone();
            if let Some(start) = session.recording_since {
                snapshot.active_ms = snapshot.active_ms.saturating_add(now.saturating_sub(start));
            }
            snapshot
        })
    }

    pub fn pause(&mut self, id: u64, reason: PauseReason, now: u64) -> Result<(), SessionError> {
        let session = self
            .session
            .as_mut()
            .filter(|s| s.snapshot.id == id)
            .ok_or(SessionError::WrongSession)?;
        if now < session.last_transition {
            return Err(SessionError::ClockWentBackwards);
        }
        if matches!(session.snapshot.phase, Phase::Ending | Phase::Ended) {
            return Err(SessionError::InvalidTransition);
        }
        if let Some(start) = session.recording_since.take() {
            session.snapshot.active_ms += now - start;
            session.snapshot.phase = Phase::Paused;
            session.snapshot.pause_reason = Some(reason);
            session.last_transition = now;
        }
        Ok(())
    }

    pub fn resume(&mut self, id: u64, ready: Readiness, now: u64) -> Result<(), SessionError> {
        let session = self
            .session
            .as_mut()
            .filter(|s| s.snapshot.id == id)
            .ok_or(SessionError::WrongSession)?;
        if now < session.last_transition {
            return Err(SessionError::ClockWentBackwards);
        }
        if session.snapshot.phase != Phase::Paused {
            return Err(SessionError::InvalidTransition);
        }
        if !ready.microphone || !ready.system_audio || !ready.recognition || !ready.storage {
            return Err(SessionError::NotReady);
        }
        session.snapshot.phase = Phase::Recording;
        session.snapshot.pause_reason = None;
        session.recording_since = Some(now);
        session.last_transition = now;
        Ok(())
    }

    /// Enter Ending before flushing the writer. Ownership is retained until finish_end.
    pub fn begin_end(&mut self, id: u64, now: u64) -> Result<(), SessionError> {
        let session = self
            .session
            .as_mut()
            .filter(|s| s.snapshot.id == id)
            .ok_or(SessionError::WrongSession)?;
        if now < session.last_transition {
            return Err(SessionError::ClockWentBackwards);
        }
        if matches!(session.snapshot.phase, Phase::Ending | Phase::Ended) {
            return Ok(());
        }
        if let Some(start) = session.recording_since.take() {
            session.snapshot.active_ms += now - start;
        }
        session.snapshot.phase = Phase::Ending;
        session.snapshot.pause_reason = None;
        session.last_transition = now;
        Ok(())
    }

    /// Call only after both source writers and durable pending work have been flushed.
    pub fn finish_end(&mut self, id: u64) -> Result<(), SessionError> {
        let session = self
            .session
            .as_mut()
            .filter(|s| s.snapshot.id == id)
            .ok_or(SessionError::WrongSession)?;
        if !matches!(session.snapshot.phase, Phase::Ending | Phase::Ended) {
            return Err(SessionError::InvalidTransition);
        }
        session.snapshot.phase = Phase::Ended;
        Ok(())
    }

    /// Only call with durations from healthy VAD streams; missing callbacks are
    /// device faults, not evidence of silence. Durations are clamped to this run.
    pub fn observe_silence(
        &mut self,
        id: u64,
        microphone_ms: u64,
        system_ms: u64,
        now: u64,
    ) -> Result<bool, SessionError> {
        let session = self
            .session
            .as_ref()
            .filter(|s| s.snapshot.id == id)
            .ok_or(SessionError::WrongSession)?;
        if now < session.last_transition {
            return Err(SessionError::ClockWentBackwards);
        }
        let Some(start) = session.recording_since else {
            return Ok(false);
        };
        if microphone_ms.min(system_ms).min(now - start) < 300_000 {
            return Ok(false);
        }
        self.pause(id, PauseReason::Silence, now)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unfinished_recording_keeps_exclusive_ownership_even_when_paused() {
        let mut sessions = SessionController::default();
        let ready = Readiness {
            microphone: true,
            system_audio: true,
            recognition: true,
            storage: true,
        };
        let first = sessions.start(ready, 100).unwrap();
        assert_eq!(sessions.start(ready, 200), Err(SessionError::AlreadyActive));
        sessions.pause(first.id, PauseReason::User, 300).unwrap();
        assert_eq!(sessions.start(ready, 400), Err(SessionError::AlreadyActive));
        assert_eq!(sessions.snapshot(500).unwrap().phase, Phase::Paused);
    }

    #[test]
    fn pause_time_is_excluded_and_ending_releases_ownership_only_after_flush() {
        let mut sessions = SessionController::default();
        let ready = Readiness {
            microphone: true,
            system_audio: true,
            recognition: true,
            storage: true,
        };
        let first = sessions.start(ready, 100).unwrap();
        sessions.pause(first.id, PauseReason::User, 1_100).unwrap();
        sessions.resume(first.id, ready, 9_000).unwrap();
        assert_eq!(sessions.snapshot(9_500).unwrap().active_ms, 1_500);
        sessions.begin_end(first.id, 10_000).unwrap();
        assert_eq!(sessions.snapshot(20_000).unwrap().active_ms, 2_000);
        assert_eq!(
            sessions.start(ready, 20_000),
            Err(SessionError::AlreadyActive)
        );
        sessions.finish_end(first.id).unwrap();
        assert_eq!(
            sessions.resume(first.id, ready, 20_001),
            Err(SessionError::InvalidTransition)
        );
        let second = sessions.start(ready, 20_002).unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(
            sessions.pause(first.id, PauseReason::Device, 20_003),
            Err(SessionError::WrongSession)
        );
        assert_eq!(sessions.snapshot(20_004).unwrap().phase, Phase::Recording);
    }

    #[test]
    fn five_minutes_of_verified_silence_on_both_sources_pauses_capture() {
        let mut sessions = SessionController::default();
        let ready = Readiness {
            microphone: true,
            system_audio: true,
            recognition: true,
            storage: true,
        };
        let first = sessions.start(ready, 0).unwrap();
        // The VAD caller reports source silence durations, not ASR response age.
        assert!(!sessions
            .observe_silence(first.id, 300_000, 299_999, 300_000)
            .unwrap());
        assert_eq!(sessions.snapshot(300_000).unwrap().phase, Phase::Recording);
        assert!(sessions
            .observe_silence(first.id, 300_001, 300_000, 300_001)
            .unwrap());
        assert_eq!(
            sessions.snapshot(900_000).unwrap().pause_reason,
            Some(PauseReason::Silence)
        );
        assert_eq!(sessions.snapshot(900_000).unwrap().active_ms, 300_001);
        sessions.resume(first.id, ready, 900_000).unwrap();
        // Durations from a previous epoch must not immediately pause the resumed stream.
        assert!(!sessions
            .observe_silence(first.id, 900_000, 900_000, 900_001)
            .unwrap());
    }
}
