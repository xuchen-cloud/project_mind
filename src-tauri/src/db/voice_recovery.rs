use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub(crate) enum RecoveryBackend {
    Paraformer,
    SenseVoice,
}

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
    #[serde(skip)]
    pub backend: RecoveryBackend,
    #[serde(skip)]
    lease: i64,
    #[serde(skip)]
    pub local_state: Option<String>,
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
        self.ensure_column("voice_cloud_epochs", "backend", "ALTER TABLE voice_cloud_epochs ADD COLUMN backend TEXT NOT NULL DEFAULT 'paraformer' CHECK(backend IN ('paraformer','sense_voice'))")?;
        self.ensure_column(
            "voice_cloud_gaps",
            "lease",
            "ALTER TABLE voice_cloud_gaps ADD COLUMN lease INTEGER NOT NULL DEFAULT 0",
        )?;
        self.ensure_column(
            "voice_cloud_gaps",
            "local_state",
            "ALTER TABLE voice_cloud_gaps ADD COLUMN local_state TEXT",
        )?;
        Ok(())
    }

    pub fn voice_local_epoch(&self, session: &str, epoch: u64, offset_ms: u64) -> Result<()> {
        self.conn.execute("INSERT INTO voice_cloud_epochs(session_id,epoch,offset_ms,endpoint,credential_profile_id,acknowledged_ms,backend) VALUES (?1,?2,?3,'',0,?3,'sense_voice') ON CONFLICT DO NOTHING", params![session,i64::try_from(epoch)?,i64::try_from(offset_ms)?])?;
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
        let registered: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM voice_cloud_epochs WHERE session_id=?1 AND epoch=?2)",
            params![session, i64::try_from(epoch)?],
            |row| row.get(0),
        )?;
        if registered {
            return self.voice_cloud_open_gap(session, epoch, error);
        }
        // Older unregistered epochs retain their error history independently
        // from capture/storage faults, including after recording has ended.
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
        // Only an unfinished capture epoch can acquire new live gaps. Paused
        // control changes and late callbacks cannot reopen a finalized interval.
        self.conn.execute(r#"INSERT INTO voice_cloud_gaps(session_id, epoch, start_ms, cursor_ms, error)
            SELECT e.session_id, e.epoch,
              MAX(e.acknowledged_ms, COALESCE((SELECT MAX(end_ms) FROM voice_cloud_gaps prior WHERE prior.session_id=e.session_id AND prior.epoch=e.epoch), e.offset_ms)),
              MAX(e.acknowledged_ms, COALESCE((SELECT MAX(end_ms) FROM voice_cloud_gaps prior WHERE prior.session_id=e.session_id AND prior.epoch=e.epoch), e.offset_ms)), ?3
            FROM voice_cloud_epochs e WHERE session_id=?1 AND epoch=?2 AND e.finalized=0
              AND NOT EXISTS (SELECT 1 FROM voice_cloud_gaps g WHERE g.session_id=e.session_id AND g.epoch=e.epoch AND g.end_ms IS NULL)
            ON CONFLICT(session_id,epoch,start_ms) DO UPDATE SET end_ms=NULL,status='waiting',error=excluded.error
              WHERE voice_cloud_gaps.end_ms=voice_cloud_gaps.start_ms AND voice_cloud_gaps.cursor_ms=voice_cloud_gaps.start_ms"#, params![session, i64::try_from(epoch)?, error])?;
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
        let transaction = self.conn.unchecked_transaction()?;
        transaction.execute("UPDATE voice_cloud_epochs SET acknowledged_ms=MAX(acknowledged_ms, ?3) WHERE session_id=?1 AND epoch=?2", params![session, i64::try_from(epoch)?, i64::try_from(end_ms)?])?;
        // A stop can open the gap before accepted inference drains. Its late final
        // remains authoritative; never replay that already acknowledged prefix.
        transaction.execute("UPDATE voice_cloud_gaps SET start_ms=MAX(start_ms,?3),cursor_ms=MAX(cursor_ms,?3) WHERE session_id=?1 AND epoch=?2 AND end_ms IS NULL", params![session, i64::try_from(epoch)?, i64::try_from(end_ms)?])?;
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn voice_cloud_audio(
        &self,
        gap: &CloudGap,
    ) -> Result<Vec<crate::voice::recovery::SavedChunk>> {
        let mut statement = self.conn.prepare("SELECT relative_path,start_sample,sample_count,sample_rate,channels,source FROM voice_audio_chunks WHERE session_id=?1 AND epoch=?2 AND state='complete' ORDER BY source,start_sample")?;
        let rows = statement
            .query_map(params![gap.session_id, i64::try_from(gap.epoch)?], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    unsigned(row, 1)?,
                    unsigned(row, 2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, u16>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.is_empty() {
            return Err(anyhow!("补转写音频尚未保存"));
        }
        rows.into_iter()
            .map(
                |(path, start_sample, sample_count, sample_rate, channels, source)| {
                    Ok(crate::voice::recovery::SavedChunk {
                        path: crate::voice::recovery::managed_path(&self.workspace_root, &path)?,
                        source,
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
                "UPDATE voice_cloud_gaps SET status='running',next_retry_ms=?2,lease=lease+1 WHERE id=?1",
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

    #[cfg(test)]
    pub(crate) fn voice_cloud_commit(
        &mut self,
        gap: &CloudGap,
        end_ms: u64,
        results: &[crate::voice::live_local::TranscriptFinal],
    ) -> Result<()> {
        self.voice_cloud_commit_state(gap, end_ms, results, None)
    }

    pub(crate) fn voice_cloud_commit_state(
        &mut self,
        gap: &CloudGap,
        end_ms: u64,
        results: &[crate::voice::live_local::TranscriptFinal],
        state: Option<&crate::voice::recovery::LocalReplayState>,
    ) -> Result<()> {
        let scan_ms = state.map(|s| s.scan_ms).unwrap_or(end_ms);
        let previous_scan = gap
            .local_state
            .as_deref()
            .map(serde_json::from_str::<serde_json::Value>)
            .transpose()?
            .and_then(|value| value.get("scan_ms").and_then(|v| v.as_u64()))
            .unwrap_or(gap.cursor_ms);
        if end_ms < gap.cursor_ms
            || scan_ms <= previous_scan
            || scan_ms < end_ms
            || Some(scan_ms) > gap.end_ms
        {
            return Err(anyhow!("invalid recovery progress"));
        }
        let checkpoint = state.map(serde_json::to_string).transpose()?;
        if checkpoint.as_ref().is_some_and(|s| s.len() > 5_000_000) {
            return Err(anyhow!("local replay checkpoint exceeds budget"));
        }
        let transaction = self.conn.unchecked_transaction()?;
        for (index, result) in results.iter().enumerate() {
            let earliest = if state.is_some() {
                gap.start_ms
            } else {
                gap.cursor_ms
            };
            if result.start_ms < earliest || result.end_ms > scan_ms {
                return Err(anyhow!("recovered text escaped its interval"));
            }
            self.voice_transcript_append_final_in_transaction(
                &gap.session_id,
                &format!("recovery:{}:{}:{index}", gap.id, previous_scan),
                result.start_ms,
                result.end_ms,
                &result.text,
                None,
            )?;
        }
        let updated = transaction.execute("UPDATE voice_cloud_gaps SET cursor_ms=?2,status=CASE WHEN end_ms=?2 THEN 'ready' ELSE 'pending' END,error=NULL,attempt=0,next_retry_ms=0,local_state=?5 WHERE id=?1 AND cursor_ms=?3 AND status='running' AND lease=?4", params![gap.id, i64::try_from(end_ms)?, i64::try_from(gap.cursor_ms)?, gap.lease, checkpoint])?;
        if updated != 1 {
            return Err(anyhow!("stale recovery task"));
        }
        if !results.is_empty() && self.voice_settings_get()?.text_profile_id.is_some() {
            self.voice_minutes_enqueue(&gap.session_id, &format!("recovery:{}:{scan_ms}", gap.id))?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn voice_cloud_release(
        &self,
        gap: &CloudGap,
        error: Option<&str>,
        now_ms: i64,
    ) -> Result<()> {
        if let Some(error) = error {
            self.conn.execute("UPDATE voice_cloud_gaps SET attempt=attempt+1,status=CASE WHEN attempt>=4 THEN 'failed' ELSE 'pending' END,error=?2,next_retry_ms=?3+MIN(300000,5000*(1 << attempt)) WHERE id=?1 AND status='running' AND lease=?4", params![gap.id, error, now_ms, gap.lease])?;
        } else {
            self.conn.execute("UPDATE voice_cloud_gaps SET status='pending',next_retry_ms=0 WHERE id=?1 AND status='running' AND lease=?2", params![gap.id, gap.lease])?;
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
        let mut statement = self.conn.prepare("SELECT g.id,g.session_id,g.epoch,g.start_ms,g.end_ms,g.cursor_ms,g.status,g.error,e.endpoint,e.credential_profile_id,e.offset_ms,e.backend,g.lease,g.local_state FROM voice_cloud_gaps g JOIN voice_cloud_epochs e ON e.session_id=g.session_id AND e.epoch=g.epoch WHERE g.session_id=?1 ORDER BY g.start_ms,g.id")?;
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
                    backend: match row.get::<_, String>(11)?.as_str() {
                        "sense_voice" => RecoveryBackend::SenseVoice,
                        "paraformer" => RecoveryBackend::Paraformer,
                        value => {
                            return Err(rusqlite::Error::InvalidParameterName(format!(
                                "unknown recovery backend: {value}"
                            )))
                        }
                    },
                    lease: row.get(12)?,
                    local_state: row.get(13)?,
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
    #[cfg(unix)]
    #[ignore = "requires private read-only WAV/model fixtures; set PROJECT_MIND_TEST_MIC_WAV, PROJECT_MIND_TEST_SYSTEM_WAV, PROJECT_MIND_TEST_MODEL_DIR"]
    fn actual_local_off_recovery_matches_restart_and_preserves_edited_record() {
        use sha2::{Digest, Sha256};
        use std::sync::atomic::AtomicBool;
        fn run(restart: bool) -> (String, usize, u64, String, usize) {
            let root = tempfile::tempdir().unwrap();
            let cache = tempfile::tempdir().unwrap();
            let models = cache.path().join("voice-models");
            std::fs::create_dir(&models).unwrap();
            std::os::unix::fs::symlink(
                std::env::var("PROJECT_MIND_TEST_MODEL_DIR").unwrap(),
                models.join(crate::voice::model_package::PACKAGE_ID),
            )
            .unwrap();
            let path = root.path().join("db.sqlite");
            let mut db = Database::open(&path, root.path(), None).unwrap();
            let session = db
                .voice_session_create(
                    &RecordTarget::Workspace,
                    "actual-local",
                    "actual-local",
                    "Voice",
                )
                .unwrap();
            let id = session.workspace_note_id.unwrap();
            let edited = db
                .workspace_record_upsert(WorkspaceRecordUpsertInput {
                    note_id: Some(id),
                    title: Some("Edited Voice Record".into()),
                    markdown: "User edited durable body".into(),
                    html: "<p>User edited durable body</p>".into(),
                    tag_ids: vec![],
                    default_code_language: None,
                })
                .unwrap();
            let before = serde_json::to_string(&edited).unwrap();
            db.voice_local_epoch("actual-local", 1, 0).unwrap();
            let directory = root
                .path()
                .join(crate::voice::storage::VOICE_ASSET_DIR)
                .join("actual-local/epoch-1");
            std::fs::create_dir_all(&directory).unwrap();
            let mut duration = 0;
            for (source, variable) in [
                ("microphone", "PROJECT_MIND_TEST_MIC_WAV"),
                ("system", "PROJECT_MIND_TEST_SYSTEM_WAV"),
            ] {
                let original = std::path::PathBuf::from(std::env::var(variable).unwrap());
                let bytes = std::fs::read(&original).unwrap();
                let sample_rate = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
                let channels = u16::from_le_bytes(bytes[22..24].try_into().unwrap());
                let sample_count = (bytes.len() as u64 - 44) / 4 / u64::from(channels);
                let start_sample = original
                    .file_stem()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .rsplit('-')
                    .next()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap();
                duration =
                    duration.max((start_sample + sample_count) * 1000 / u64::from(sample_rate));
                let destination = directory.join(original.file_name().unwrap());
                std::fs::write(&destination, &bytes).unwrap();
                db.voice_audio_chunk_insert(
                    "actual-local",
                    &AudioChunkManifest {
                        source,
                        epoch: 1,
                        chunk_index: 0,
                        start_sample,
                        sample_count,
                        sample_rate,
                        channels,
                        relative_path: destination
                            .strip_prefix(root.path())
                            .unwrap()
                            .to_str()
                            .unwrap()
                            .into(),
                        byte_size: bytes.len() as u64,
                    },
                )
                .unwrap();
            }
            db.voice_cloud_open_gap("actual-local", 1, "live disabled")
                .unwrap();
            db.voice_cloud_finish_epochs("actual-local").unwrap();
            db.voice_session_transition(
                "actual-local",
                session.revision,
                "ended",
                None,
                duration,
                1,
            )
            .unwrap();
            let mut blocks = 0;
            while let Some(gap) = db.voice_cloud_claim(10_000_000).unwrap() {
                let chunks = db.voice_cloud_audio(&gap).unwrap();
                // Cancellation cannot advance a cursor or persist a provisional checkpoint.
                assert!(crate::voice::recovery::replay_local_with(
                    &gap,
                    &chunks,
                    cache.path(),
                    &AtomicBool::new(true)
                )
                .unwrap()
                .is_none());
                let batch = crate::voice::recovery::replay_local_with(
                    &gap,
                    &chunks,
                    cache.path(),
                    &AtomicBool::new(false),
                )
                .unwrap()
                .unwrap();
                db.voice_cloud_commit_state(
                    &gap,
                    batch.end_ms,
                    &batch.results,
                    batch.local_state.as_ref(),
                )
                .unwrap();
                assert!(
                    db.voice_cloud_commit_state(
                        &gap,
                        batch.end_ms,
                        &batch.results,
                        batch.local_state.as_ref()
                    )
                    .is_err(),
                    "stale second commit must fail atomically"
                );
                blocks += 1;
                if restart && blocks == 1 {
                    drop(db);
                    db = Database::open(&path, root.path(), None).unwrap();
                }
                assert!(blocks <= 3);
            }
            let rows = db.conn.prepare("SELECT start_ms,end_ms,text FROM voice_transcript_segments WHERE session_id='actual-local' ORDER BY start_ms,end_ms,provider_key").unwrap().query_map([], |row| Ok((row.get::<_,i64>(0)?,row.get::<_,i64>(1)?,row.get::<_,String>(2)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
            assert!(!rows.is_empty());
            assert!(rows
                .iter()
                .all(|(start, end, _)| *start >= 0 && *end >= *start && *end <= duration as i64));
            let after = serde_json::to_string(&db.workspace_note_record(id).unwrap()).unwrap();
            assert_eq!(
                before, after,
                "background replay cannot edit Record body or metadata"
            );
            let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&rows).unwrap()));
            let normalized = rows
                .iter()
                .flat_map(|(_, _, text)| text.chars())
                .filter(|ch| {
                    !ch.is_whitespace()
                        && !ch.is_ascii_punctuation()
                        && !matches!(
                            ch,
                            '，' | '。'
                                | '！'
                                | '？'
                                | '；'
                                | '：'
                                | '、'
                                | '“'
                                | '”'
                                | '（'
                                | '）'
                        )
                })
                .collect::<String>();
            let normalized_hash = format!("{:x}", Sha256::digest(normalized.as_bytes()));
            if !restart {
                if let Ok(export) = std::env::var("PROJECT_MIND_TEST_RECOVERY_FINALS_JSON") {
                    use std::os::unix::fs::OpenOptionsExt;
                    let file = std::fs::OpenOptions::new()
                        .write(true)
                        .create(true)
                        .truncate(true)
                        .mode(0o600)
                        .open(export)
                        .unwrap();
                    use std::os::unix::fs::PermissionsExt;
                    file.set_permissions(std::fs::Permissions::from_mode(0o600))
                        .unwrap();
                    serde_json::to_writer(file, &rows).unwrap();
                }
            }
            let gaps = db.voice_cloud_gaps("actual-local").unwrap();
            assert_eq!(
                (gaps[0].cursor_ms, gaps[0].status.as_str()),
                (duration, "ready")
            );
            (
                hash,
                rows.len(),
                duration,
                normalized_hash,
                normalized.chars().count(),
            )
        }
        let reference = run(false);
        let resumed = run(true);
        assert_eq!(reference, resumed);
        eprintln!("actual-local-recovery sha256={} segments={} duration_ms={} normalized_text_sha256={} normalized_chars={} uninterrupted=restart stale_commit=rejected edited_record=unchanged", reference.0,reference.1,reference.2,reference.3,reference.4);
    }

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
    fn finalized_epochs_cannot_reopen_live_gaps_while_paused() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("db.sqlite"), root.path(), None).unwrap();
        let session = db
            .voice_session_create(
                &RecordTarget::Workspace,
                "paused-local",
                "paused-local",
                "Voice",
            )
            .unwrap();
        db.voice_local_epoch("paused-local", 1, 0).unwrap();
        db.voice_cloud_finish_epochs("paused-local").unwrap();
        // Finalization created a zero-length ready row. OFF must not reopen it.
        db.voice_cloud_open_gap("paused-local", 1, "off while paused")
            .unwrap();
        let first = db.voice_cloud_gaps("paused-local").unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(
            (first[0].end_ms, first[0].status.as_str()),
            (Some(0), "ready")
        );

        db.voice_local_epoch("paused-local", 2, 1000).unwrap();
        db.voice_cloud_open_gap("paused-local", 2, "off").unwrap();
        db.voice_cloud_connected("paused-local", 2, 1500).unwrap();
        db.voice_cloud_finish_epochs("paused-local").unwrap();
        db.voice_session_transition(
            "paused-local",
            session.revision,
            "paused",
            Some("user"),
            1500,
            2,
        )
        .unwrap();
        let gap = db.voice_cloud_claim(0).unwrap().unwrap();
        db.voice_cloud_commit(&gap, 1500, &[]).unwrap();
        // A completed nonempty gap must not grow an unsealed successor either.
        let finalized_count = db.voice_cloud_gaps("paused-local").unwrap().len();
        db.voice_cloud_open_gap("paused-local", 2, "off while paused")
            .unwrap();
        let completed = db.voice_cloud_gaps("paused-local").unwrap();
        assert_eq!(completed.len(), finalized_count);
        assert!(completed
            .iter()
            .all(|gap| gap.end_ms.is_some() && gap.status == "ready"));

        // Resuming capture registers a new unfinished epoch; its OFF gap is valid.
        db.voice_local_epoch("paused-local", 3, 2000).unwrap();
        db.voice_cloud_open_gap("paused-local", 3, "off after resume")
            .unwrap();
        let resumed = db.voice_cloud_gaps("paused-local").unwrap();
        assert_eq!(resumed.len(), finalized_count + 1);
        let last = resumed.last().unwrap();
        assert_eq!(
            (last.epoch, last.end_ms, last.status.as_str()),
            (3, None, "waiting")
        );
    }

    #[test]
    fn local_epochs_recover_gaps_after_restart_and_reject_stale_leases() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("db.sqlite");
        let mut db = Database::open(&path, root.path(), None).unwrap();
        let session = db
            .voice_session_create(&RecordTarget::Workspace, "local", "local", "Voice")
            .unwrap();
        db.voice_local_epoch("local", 1, 0).unwrap();
        db.voice_cloud_acknowledge("local", 1, 500).unwrap();
        db.voice_cloud_open_gap("local", 1, "disabled").unwrap();
        db.voice_cloud_connected("local", 1, 500).unwrap();
        db.voice_cloud_open_gap("local", 1, "disabled immediately again")
            .unwrap();
        db.voice_cloud_acknowledge("local", 1, 600).unwrap();
        db.voice_cloud_connected("local", 1, 1000).unwrap();
        db.voice_cloud_acknowledge("local", 1, 900).unwrap(); // closed gap stays intact
                                                              // No final was produced during the brief enabled interval.
        db.voice_cloud_open_gap("local", 1, "disabled again")
            .unwrap();
        db.voice_cloud_connected("local", 1, 1500).unwrap();
        let gaps = db.voice_cloud_gaps("local").unwrap();
        assert_eq!(
            gaps.iter()
                .map(|g| (g.start_ms, g.end_ms))
                .collect::<Vec<_>>(),
            vec![(600, Some(1000)), (1000, Some(1500))]
        );
        assert!(db.voice_cloud_claim(0).unwrap().is_none());
        db.voice_cloud_finish_epochs("local").unwrap();
        db.voice_session_transition("local", session.revision, "ended", None, 1500, 1)
            .unwrap();
        let old = db.voice_cloud_claim(0).unwrap().unwrap();
        drop(db);
        let mut db = Database::open(&path, root.path(), None).unwrap();
        let current = db.voice_cloud_claim(120_001).unwrap().unwrap();
        assert_eq!(current.id, old.id);
        assert_eq!(current.backend, RecoveryBackend::SenseVoice);
        db.voice_cloud_release(&old, Some("late error"), 120_002)
            .unwrap();
        assert!(db.voice_cloud_commit(&old, 1000, &[]).is_err());
        db.voice_cloud_commit(&current, 1000, &[]).unwrap();
        assert_eq!(db.voice_cloud_gaps("local").unwrap()[0].status, "ready");
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
            db.voice_cloud_release(&gap, Some("network"), now).unwrap();
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
