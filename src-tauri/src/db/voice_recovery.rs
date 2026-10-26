use super::*;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudGap {
    pub id: i64,
    pub session_id: String,
    pub epoch: u64,
    pub start_ms: u64,
    pub end_ms: Option<u64>,
    pub cursor_ms: u64,
    pub status: String,
    pub error: Option<String>,
    #[serde(skip)]
    pub endpoint: String,
    #[serde(skip)]
    pub credential_profile_id: i64,
    #[serde(skip)]
    pub epoch_offset_ms: u64,
}

fn unsigned(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(column)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(column, value))
}

impl Database {
    /// Keep the existing atomic claim and capture its lease for cancellation.
    pub(crate) fn voice_minutes_claim_owned(&mut self) -> Result<Option<(i64, String, String)>> {
        let Some((id, session)) = self.voice_minutes_claim_next()? else {
            return Ok(None);
        };
        let lease = self.conn.query_row(
            "SELECT started_at FROM voice_minutes_jobs WHERE id=?1 AND status='running'",
            [id],
            |row| row.get(0),
        )?;
        Ok(Some((id, session, lease)))
    }

    /// Release only an in-flight minutes job on Workspace cancellation. Keep
    /// its idempotency key and the applied minutes/Transcript watermark intact.
    pub(crate) fn voice_minutes_release_job(&self, job_id: i64, lease: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE voice_minutes_jobs SET status='pending', preview='', error=NULL, started_at=NULL WHERE id=?1 AND status='running' AND started_at=?2",
            params![job_id, lease],
        )?;
        Ok(())
    }

    pub(super) fn ensure_cloud_recovery_schema(&self) -> Result<()> {
        self.conn.execute_batch(r#"
            CREATE TABLE IF NOT EXISTS voice_cloud_epochs (
              session_id TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
              epoch INTEGER NOT NULL, offset_ms INTEGER NOT NULL, endpoint TEXT NOT NULL,
              credential_profile_id INTEGER NOT NULL, clean INTEGER NOT NULL DEFAULT 0,
              finalized INTEGER NOT NULL DEFAULT 0, acknowledged_ms INTEGER NOT NULL,
              PRIMARY KEY(session_id, epoch)
            );
            CREATE TABLE IF NOT EXISTS voice_cloud_gaps (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id TEXT NOT NULL, epoch INTEGER NOT NULL,
              start_ms INTEGER NOT NULL, end_ms INTEGER, cursor_ms INTEGER NOT NULL,
              status TEXT NOT NULL DEFAULT 'waiting', error TEXT,
              attempt INTEGER NOT NULL DEFAULT 0, next_retry_ms INTEGER NOT NULL DEFAULT 0,
              UNIQUE(session_id, epoch, start_ms),
              FOREIGN KEY(session_id, epoch) REFERENCES voice_cloud_epochs(session_id, epoch) ON DELETE CASCADE
            );
        "#)?;
        Ok(())
    }

    pub fn voice_cloud_epoch(
        &self,
        session: &str,
        epoch: u64,
        offset_ms: u64,
        endpoint: &str,
        credential: i64,
    ) -> Result<()> {
        self.conn.execute("INSERT INTO voice_cloud_epochs(session_id, epoch, offset_ms, endpoint, credential_profile_id, acknowledged_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?3) ON CONFLICT DO NOTHING",
            params![session, i64::try_from(epoch)?, i64::try_from(offset_ms)?, endpoint, credential])?;
        Ok(())
    }

    pub(crate) fn voice_recognition_failed(
        &self,
        session: &str,
        epoch: u64,
        error: &str,
    ) -> Result<()> {
        let cloud: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM voice_cloud_epochs WHERE session_id=?1 AND epoch=?2)",
            params![session, i64::try_from(epoch)?],
            |row| row.get(0),
        )?;
        if cloud {
            return self.voice_cloud_open_gap(session, epoch, error);
        }
        // Local recognition has no cloud recovery epoch. Preserve its failure separately
        // from capture/storage faults, including after the recording has ended.
        self.conn.execute(
            "INSERT INTO voice_timeline_events(session_id, epoch, kind, media_position_ms, reason, created_at)
             SELECT id, ?2, 'recognition_error', active_ms, ?3, ?4 FROM recording_sessions
             WHERE id=?1 AND NOT EXISTS (SELECT 1 FROM voice_timeline_events WHERE session_id=?1 AND epoch=?2 AND kind='recognition_error')",
            params![session, i64::try_from(epoch)?, error, now_iso()],
        )?;
        Ok(())
    }

    pub(crate) fn voice_recognition_error(
        &self,
        session: &str,
        epoch: Option<u64>,
    ) -> Result<Option<String>> {
        self.conn.query_row(
            "SELECT reason FROM voice_timeline_events WHERE session_id=?1 AND kind='recognition_error' AND (?2 IS NULL OR epoch=?2) ORDER BY id DESC LIMIT 1",
            params![session, epoch.map(i64::try_from).transpose()?],
            |row| row.get(0),
        ).optional().map_err(Into::into)
    }

    pub fn voice_cloud_open_gap(&self, session: &str, epoch: u64, error: &str) -> Result<()> {
        // A single open interval extends until new live audio is accepted.
        self.conn.execute(r#"INSERT INTO voice_cloud_gaps(session_id, epoch, start_ms, cursor_ms, error)
            SELECT e.session_id, e.epoch,
              e.acknowledged_ms,
              e.acknowledged_ms, ?3
            FROM voice_cloud_epochs e WHERE session_id=?1 AND epoch=?2
              AND NOT EXISTS (SELECT 1 FROM voice_cloud_gaps g WHERE g.session_id=e.session_id AND g.epoch=e.epoch AND g.end_ms IS NULL)
            ON CONFLICT DO NOTHING"#, params![session, i64::try_from(epoch)?, error])?;
        Ok(())
    }

    pub fn voice_cloud_connected(&self, session: &str, epoch: u64, start_ms: u64) -> Result<()> {
        self.conn.execute("UPDATE voice_cloud_gaps SET end_ms=MAX(start_ms, ?3), status=CASE WHEN start_ms < ?3 THEN 'pending' ELSE 'ready' END WHERE session_id=?1 AND epoch=?2 AND end_ms IS NULL", params![session, i64::try_from(epoch)?, i64::try_from(start_ms)?])?;
        Ok(())
    }

    pub fn voice_cloud_complete(&self, session: &str, epoch: u64) -> Result<()> {
        self.conn.execute(
            "UPDATE voice_cloud_epochs SET clean=1 WHERE session_id=?1 AND epoch=?2",
            params![session, i64::try_from(epoch)?],
        )?;
        Ok(())
    }

    pub fn voice_cloud_finish_epochs(&self, session: &str) -> Result<()> {
        let epochs = self.conn.prepare("SELECT epoch,offset_ms,clean FROM voice_cloud_epochs WHERE session_id=?1 AND finalized=0")?
            .query_map([session], |row| Ok((unsigned(row, 0)?, unsigned(row, 1)?, row.get::<_, bool>(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (epoch, offset, clean) in epochs {
            if !clean {
                self.voice_cloud_open_gap(session, epoch, "待从已保存音频补齐")?;
            }
            let duration: u64 = self.conn.query_row("SELECT COALESCE(MAX((start_sample+sample_count)*1000/sample_rate),0) FROM voice_audio_chunks WHERE session_id=?1 AND epoch=?2", params![session, i64::try_from(epoch)?], |row| unsigned(row, 0))?;
            self.voice_cloud_connected(session, epoch, offset + duration)?;
            self.conn.execute(
                "UPDATE voice_cloud_epochs SET finalized=1 WHERE session_id=?1 AND epoch=?2",
                params![session, i64::try_from(epoch)?],
            )?;
        }
        Ok(())
    }

    pub(crate) fn voice_cloud_acknowledge(
        &self,
        session: &str,
        epoch: u64,
        end_ms: u64,
    ) -> Result<()> {
        self.conn.execute("UPDATE voice_cloud_epochs SET acknowledged_ms=MAX(acknowledged_ms, ?3) WHERE session_id=?1 AND epoch=?2", params![session, i64::try_from(epoch)?, i64::try_from(end_ms)?])?;
        Ok(())
    }

    pub(crate) fn voice_cloud_audio(
        &self,
        gap: &CloudGap,
    ) -> Result<Vec<crate::voice::recovery::SavedChunk>> {
        let mut statement = self.conn.prepare("SELECT relative_path,start_sample,sample_count,sample_rate,channels FROM voice_audio_chunks WHERE session_id=?1 AND epoch=?2 AND state='complete' ORDER BY source,start_sample")?;
        let rows = statement
            .query_map(params![gap.session_id, i64::try_from(gap.epoch)?], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    unsigned(row, 1)?,
                    unsigned(row, 2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, u16>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.is_empty() {
            return Err(anyhow!("补转写音频尚未保存"));
        }
        rows.into_iter()
            .map(
                |(path, start_sample, sample_count, sample_rate, channels)| {
                    Ok(crate::voice::recovery::SavedChunk {
                        path: crate::voice::recovery::managed_path(&self.workspace_root, &path)?,
                        start_sample,
                        sample_count,
                        sample_rate,
                        channels,
                    })
                },
            )
            .collect()
    }

    /// The supervisor sleeps until the next durable retry deadline, or a new
    /// voice mutation wakes it. Empty workspaces need no 250ms scan.
    pub(crate) fn voice_cloud_next_retry_ms(&self) -> Result<Option<i64>> {
        Ok(self.conn.query_row(
            "SELECT MIN(next_retry_ms) FROM voice_cloud_gaps WHERE end_ms > cursor_ms AND status IN ('pending','running') AND EXISTS (SELECT 1 FROM voice_cloud_epochs e WHERE e.session_id=voice_cloud_gaps.session_id AND e.epoch=voice_cloud_gaps.epoch AND e.finalized=1)",
            [], |row| row.get(0),
        )?)
    }

    pub(crate) fn voice_cloud_claim(&mut self, now_ms: i64) -> Result<Option<CloudGap>> {
        let transaction = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let candidate = transaction.query_row(
            "SELECT id,session_id FROM voice_cloud_gaps WHERE end_ms > cursor_ms AND EXISTS (SELECT 1 FROM voice_cloud_epochs e WHERE e.session_id=voice_cloud_gaps.session_id AND e.epoch=voice_cloud_gaps.epoch AND e.finalized=1) AND next_retry_ms <= ?1 AND (status='pending' OR status='running') AND NOT EXISTS (SELECT 1 FROM recording_sessions WHERE lifecycle='recording') ORDER BY id LIMIT 1",
            [now_ms], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))).optional()?;
        if let Some((id, _)) = &candidate {
            transaction.execute(
                "UPDATE voice_cloud_gaps SET status='running',next_retry_ms=?2 WHERE id=?1",
                params![id, now_ms + 120_000],
            )?;
        }
        transaction.commit()?;
        candidate
            .map(|(id, session)| {
                self.voice_cloud_gaps(&session)?
                    .into_iter()
                    .find(|gap| gap.id == id)
                    .ok_or_else(|| anyhow!("recovery task disappeared"))
            })
            .transpose()
    }

    pub(crate) fn voice_cloud_commit(
        &mut self,
        gap: &CloudGap,
        end_ms: u64,
        results: &[crate::voice::live_local::TranscriptFinal],
    ) -> Result<()> {
        if end_ms <= gap.cursor_ms || Some(end_ms) > gap.end_ms {
            return Err(anyhow!("invalid recovery progress"));
        }
        let transaction = self.conn.unchecked_transaction()?;
        for (index, result) in results.iter().enumerate() {
            if result.start_ms < gap.cursor_ms || result.end_ms > end_ms {
                return Err(anyhow!("recovered text escaped its interval"));
            }
            self.voice_transcript_append_final_in_transaction(
                &gap.session_id,
                &format!("recovery:{}:{}:{index}", gap.id, gap.cursor_ms),
                result.start_ms,
                result.end_ms,
                &result.text,
                None,
            )?;
        }
        let updated = transaction.execute("UPDATE voice_cloud_gaps SET cursor_ms=?2,status=CASE WHEN end_ms=?2 THEN 'ready' ELSE 'pending' END,error=NULL,attempt=0,next_retry_ms=0 WHERE id=?1 AND cursor_ms=?3 AND status='running'", params![gap.id, i64::try_from(end_ms)?, i64::try_from(gap.cursor_ms)?])?;
        if updated != 1 {
            return Err(anyhow!("stale recovery task"));
        }
        if !results.is_empty() && self.voice_settings_get()?.text_profile_id.is_some() {
            self.voice_minutes_enqueue(&gap.session_id, &format!("recovery:{}:{end_ms}", gap.id))?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn voice_cloud_release(
        &self,
        id: i64,
        error: Option<&str>,
        now_ms: i64,
    ) -> Result<()> {
        if let Some(error) = error {
            self.conn.execute("UPDATE voice_cloud_gaps SET attempt=attempt+1,status=CASE WHEN attempt>=4 THEN 'failed' ELSE 'pending' END,error=?2,next_retry_ms=?3+MIN(300000,5000*(1 << attempt)) WHERE id=?1 AND status='running'", params![id, error, now_ms])?;
        } else {
            self.conn.execute("UPDATE voice_cloud_gaps SET status='pending',next_retry_ms=0 WHERE id=?1 AND status='running'", [id])?;
        }
        Ok(())
    }

    pub(crate) fn voice_cloud_retry(&self, target: &VoiceRecordLookup) -> Result<()> {
        let Some((session, _)) = self.voice_session_for_target(target)? else {
            return Err(anyhow!("Voice Record not found"));
        };
        self.conn.execute("UPDATE voice_cloud_gaps SET status='pending',attempt=0,next_retry_ms=0,error=NULL WHERE session_id=?1 AND status='failed'", [session])?;
        Ok(())
    }

    pub(crate) fn voice_cloud_status(&self, target: &VoiceRecordLookup) -> Result<Vec<CloudGap>> {
        match self.voice_session_for_target(target)? {
            Some((session, _)) => self.voice_cloud_gaps(&session),
            None => Ok(Vec::new()),
        }
    }

    pub(crate) fn voice_cloud_gaps(&self, session: &str) -> Result<Vec<CloudGap>> {
        let mut statement = self.conn.prepare("SELECT g.id,g.session_id,g.epoch,g.start_ms,g.end_ms,g.cursor_ms,g.status,g.error,e.endpoint,e.credential_profile_id,e.offset_ms FROM voice_cloud_gaps g JOIN voice_cloud_epochs e ON e.session_id=g.session_id AND e.epoch=g.epoch WHERE g.session_id=?1 ORDER BY g.start_ms,g.id")?;
        let rows = statement
            .query_map([session], |row| {
                Ok(CloudGap {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    epoch: unsigned(row, 2)?,
                    start_ms: unsigned(row, 3)?,
                    end_ms: row
                        .get::<_, Option<i64>>(4)?
                        .map(|value| {
                            u64::try_from(value)
                                .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(4, value))
                        })
                        .transpose()?,
                    cursor_ms: unsigned(row, 5)?,
                    status: row.get(6)?,
                    error: row.get(7)?,
                    endpoint: row.get(8)?,
                    credential_profile_id: row.get(9)?,
                    epoch_offset_ms: unsigned(row, 10)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelled_minutes_job_resumes_without_advancing_transcript_or_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db.sqlite");
        let mut db = Database::open(&path, root.path(), None).unwrap();
        let session = db
            .voice_session_create(
                &RecordTarget::Workspace,
                "minutes-cancel",
                "minutes-cancel",
                "Voice",
            )
            .unwrap();
        db.voice_transcript_append_final(
            &session.session_id,
            "first",
            100,
            200,
            "first fact",
            None,
        )
        .unwrap();
        assert!(db
            .voice_minutes_enqueue(&session.session_id, "same-request")
            .unwrap());
        let (job, _, lease) = db.voice_minutes_claim_owned().unwrap().unwrap();
        db.voice_minutes_update_preview(job, "provisional").unwrap();
        db.voice_minutes_release_job(job, &lease).unwrap();
        drop(db);
        let mut db = Database::open(&path, root.path(), None).unwrap();
        let lookup = VoiceRecordLookup::Workspace {
            record_id: session.workspace_note_id.unwrap(),
        };
        let snapshot = db.voice_minutes_get(&lookup).unwrap().unwrap();
        assert_eq!(snapshot.status, "pending");
        assert_eq!(snapshot.version, 0);
        assert!(snapshot.preview.is_empty());
        assert!(
            !db.voice_minutes_enqueue(&session.session_id, "same-request")
                .unwrap(),
            "cancellation retains the request key"
        );
        let (resumed, _, resumed_lease) = db.voice_minutes_claim_owned().unwrap().unwrap();
        assert_eq!(resumed, job);
        let input = db.voice_minutes_input(&session.session_id).unwrap();
        assert_eq!(input.segments.len(), 1);
        db.voice_minutes_apply(
            &session.session_id,
            input.expected_version,
            input.source_max_rowid,
            "cumulative minutes",
            "title",
        )
        .unwrap();
        db.voice_minutes_finish_job(job, None).unwrap();
        db.voice_minutes_release_job(job, &resumed_lease).unwrap(); // a late release cannot reopen completed work
        assert_eq!(
            db.voice_minutes_get(&lookup).unwrap().unwrap().status,
            "ready"
        );
        assert!(db
            .voice_minutes_input(&session.session_id)
            .unwrap()
            .segments
            .is_empty());
        // Late recovery inserts may have earlier timestamps; rowid still wins.
        db.voice_transcript_append_final(&session.session_id, "late", 0, 100, "late fact", None)
            .unwrap();
        let next = db.voice_minutes_input(&session.session_id).unwrap();
        assert_eq!(next.segments.len(), 1);
        assert_eq!(next.segments[0].text, "late fact");
        assert!(db
            .voice_minutes_apply(
                &session.session_id,
                input.expected_version,
                next.source_max_rowid,
                "stale",
                "stale"
            )
            .is_err());
    }

    #[test]
    fn recognition_failures_keep_local_history_and_cloud_recovery_separate() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db.sqlite");
        let mut db = Database::open(&path, root.path(), None).unwrap();
        db.voice_session_create(&RecordTarget::Workspace, "local", "local", "Voice")
            .unwrap();
        db.voice_recognition_failed("local", 1, "local inference failed")
            .unwrap();
        db.voice_recognition_failed("local", 1, "local inference failed")
            .unwrap();
        assert!(db.voice_cloud_gaps("local").unwrap().is_empty());
        drop(db);
        let db = Database::open(&path, root.path(), None).unwrap();
        assert_eq!(
            db.voice_recognition_error("local", Some(1))
                .unwrap()
                .as_deref(),
            Some("local inference failed")
        );
        assert!(db
            .voice_recognition_error("local", Some(2))
            .unwrap()
            .is_none());
        let count: i64 = db.conn.query_row("SELECT COUNT(*) FROM voice_timeline_events WHERE session_id='local' AND kind='recognition_error'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
        // A repeated cloud failure must remain a cloud gap even when a gap is already open.
        db.voice_cloud_epoch("local", 2, 1000, "wss://example.invalid/", 1)
            .unwrap();
        db.voice_recognition_failed("local", 2, "offline").unwrap();
        db.voice_recognition_failed("local", 2, "still offline")
            .unwrap();
        assert_eq!(db.voice_cloud_gaps("local").unwrap().len(), 1);
        assert!(db
            .voice_recognition_error("local", Some(2))
            .unwrap()
            .is_none());
        assert_eq!(
            db.voice_recognition_error("local", None)
                .unwrap()
                .as_deref(),
            Some("local inference failed")
        );
    }

    #[test]
    fn failed_recovery_has_bounded_retries_and_can_be_retried_manually() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db.sqlite");
        let mut db = Database::open(&path, root.path(), None).unwrap();
        let session = db
            .voice_session_create(&RecordTarget::Workspace, "cloud", "cloud", "Voice")
            .unwrap();
        db.voice_cloud_epoch(
            "cloud",
            1,
            0,
            "wss://dashscope.aliyuncs.com/api-ws/v1/inference/",
            1,
        )
        .unwrap();
        db.voice_cloud_open_gap("cloud", 1, "offline").unwrap();
        db.voice_cloud_connected("cloud", 1, 2000).unwrap();
        db.voice_cloud_finish_epochs("cloud").unwrap();
        for attempt in 0..5 {
            let now = attempt * 400_000;
            let gap = db.voice_cloud_claim(now).unwrap().unwrap();
            db.voice_cloud_release(gap.id, Some("network"), now)
                .unwrap();
            assert!(db.voice_cloud_claim(now + 1).unwrap().is_none());
            if attempt == 0 {
                assert_eq!(db.voice_cloud_next_retry_ms().unwrap(), Some(5_000));
            }
        }
        assert_eq!(db.voice_cloud_gaps("cloud").unwrap()[0].status, "failed");
        drop(db);
        let mut db = Database::open(&path, root.path(), None).unwrap();
        assert!(db.voice_cloud_claim(10_000_000).unwrap().is_none());
        db.voice_cloud_retry(&VoiceRecordLookup::Workspace {
            record_id: session.workspace_note_id.unwrap(),
        })
        .unwrap();
        assert!(db.voice_cloud_claim(10_000_000).unwrap().is_some());
    }

    #[test]
    fn recovery_progress_and_transcripts_commit_together() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("db.sqlite"), root.path(), None).unwrap();
        let session = db
            .voice_session_create(&RecordTarget::Workspace, "cloud", "cloud", "Voice")
            .unwrap();
        db.voice_cloud_epoch(
            "cloud",
            1,
            0,
            "wss://dashscope.aliyuncs.com/api-ws/v1/inference/",
            1,
        )
        .unwrap();
        db.voice_cloud_open_gap("cloud", 1, "offline").unwrap();
        db.voice_cloud_connected("cloud", 1, 2000).unwrap();
        db.voice_cloud_finish_epochs("cloud").unwrap();
        db.voice_session_transition("cloud", session.revision, "ended", None, 2000, 1)
            .unwrap();
        let gap = db.voice_cloud_claim(1000).unwrap().unwrap();
        assert!(db.voice_cloud_claim(1001).unwrap().is_none());
        let valid = crate::voice::live_local::TranscriptFinal {
            provider_key: "a".into(),
            start_ms: 0,
            end_ms: 1000,
            text: "恢复".into(),
        };
        let invalid = crate::voice::live_local::TranscriptFinal {
            provider_key: "b".into(),
            start_ms: 1000,
            end_ms: 2000,
            text: "".into(),
        };
        assert!(db
            .voice_cloud_commit(&gap, 2000, &[valid.clone(), invalid])
            .is_err());
        assert!(db.voice_minutes_input("cloud").unwrap().segments.is_empty());
        assert_eq!(db.voice_cloud_gaps("cloud").unwrap()[0].cursor_ms, 0);
        db.voice_cloud_commit(&gap, 2000, &[valid]).unwrap();
        assert_eq!(db.voice_cloud_gaps("cloud").unwrap()[0].status, "ready");
        assert_eq!(db.voice_minutes_input("cloud").unwrap().segments.len(), 1);
        assert!(db.voice_cloud_claim(200_000).unwrap().is_none());
    }

    #[test]
    fn cloud_gap_survives_restart_and_late_results_reach_final_minutes() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db.sqlite");
        let mut db = Database::open(&path, root.path(), None).unwrap();
        let session = db
            .voice_session_create(&RecordTarget::Workspace, "cloud", "cloud", "Voice")
            .unwrap();
        db.voice_cloud_epoch(
            "cloud",
            1,
            0,
            "wss://dashscope.aliyuncs.com/api-ws/v1/inference/",
            1,
        )
        .unwrap();
        db.voice_transcript_append_final("cloud", "first", 0, 500, "先说的话", None)
            .unwrap();
        db.voice_cloud_acknowledge("cloud", 1, 500).unwrap();
        db.voice_cloud_open_gap("cloud", 1, "network failed")
            .unwrap();
        db.voice_cloud_connected("cloud", 1, 2_000).unwrap();
        db.voice_session_transition("cloud", session.revision, "ended", None, 3_000, 1)
            .unwrap();
        drop(db);
        let db = Database::open(&path, root.path(), None).unwrap();
        let gaps = db.voice_cloud_gaps("cloud").unwrap();
        assert_eq!(gaps.len(), 1);
        assert_eq!((gaps[0].start_ms, gaps[0].end_ms), (500, Some(2_000)));
        db.voice_transcript_append_final("cloud", "later", 2_000, 3_000, "后来的话", None)
            .unwrap();
        db.voice_transcript_append_final("cloud", "recovery", 500, 1_900, "断网时的话", None)
            .unwrap();
        let input = db.voice_minutes_input("cloud").unwrap();
        assert_eq!(
            input
                .segments
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>(),
            vec!["先说的话", "断网时的话", "后来的话"]
        );
    }
}
