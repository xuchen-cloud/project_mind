use super::*;
use crate::voice::contracts::{VoiceDiarizationSnapshot, VoiceSpeaker, VoiceSpeakerTurn};

impl Database {
    pub fn voice_diarization_has_pending(&self) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM voice_diarization WHERE status='pending')",
            [],
            |row| row.get(0),
        )?)
    }

    pub fn voice_session_save_stopped(
        &self,
        session_id: &str,
        expected_revision: u64,
        lifecycle: &str,
        pause_reason: Option<&str>,
        active_ms: u64,
        capture_epoch: u64,
        auto_diarization: bool,
    ) -> Result<PersistedVoiceSession> {
        let tx = self.conn.unchecked_transaction()?;
        let session = self.voice_session_transition(
            session_id,
            expected_revision,
            lifecycle,
            pause_reason,
            active_ms,
            capture_epoch,
        )?;
        if lifecycle == "ended" && auto_diarization {
            self.voice_diarization_enqueue(session_id)?;
        }
        tx.commit()?;
        Ok(session)
    }

    pub(super) fn ensure_voice_diarization_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS voice_diarization (
                session_id TEXT PRIMARY KEY REFERENCES recording_sessions(id) ON DELETE CASCADE,
                revision INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL CHECK(status IN ('pending','running','ready','failed')),
                error TEXT,
                speakers TEXT NOT NULL DEFAULT '[]',
                turns TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE IF NOT EXISTS voice_speaker_embeddings (
                session_id TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
                speaker_id INTEGER NOT NULL,
                model_id TEXT NOT NULL,
                embedding TEXT NOT NULL,
                PRIMARY KEY(session_id,speaker_id)
            );
            CREATE TABLE IF NOT EXISTS voice_speaker_contacts (
                session_id TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
                speaker_id INTEGER NOT NULL,
                contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
                association TEXT NOT NULL CHECK(association IN ('confirmed','automatic')),
                PRIMARY KEY(session_id,speaker_id)
            );
            CREATE TABLE IF NOT EXISTS contact_voice_profiles (
                contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
                model_id TEXT NOT NULL,
                embedding TEXT NOT NULL,
                source_session TEXT,
                source_speaker INTEGER,
                PRIMARY KEY(contact_id,model_id)
            );
        "#,
        )?;
        Ok(())
    }

    pub fn voice_diarization_get(
        &self,
        target: &VoiceRecordLookup,
    ) -> Result<Option<VoiceDiarizationSnapshot>> {
        let Some((session, _)) = self.voice_session_for_target(target)? else {
            return Ok(None);
        };
        Ok(Some(self.voice_diarization_snapshot(&session)?))
    }

    fn voice_diarization_snapshot(&self, session: &str) -> Result<VoiceDiarizationSnapshot> {
        let stored = self.conn.query_row(
            "SELECT revision,status,error,speakers,turns FROM voice_diarization WHERE session_id=?1",
            [session], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))
        ).optional()?;
        let (revision, status, error, speakers, turns) =
            stored.unwrap_or((0, "not_started".into(), None, "[]".into(), "[]".into()));
        let mut speakers: Vec<VoiceSpeaker> = serde_json::from_str(&speakers)?;
        for speaker in &mut speakers {
            speaker.contact_id = None;
            speaker.association = None;
            speaker.voiceprint_ready = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM voice_speaker_embeddings WHERE session_id=?1 AND speaker_id=?2)",params![session,speaker.id],|r|r.get(0))?;
            let contact = self.conn.query_row("SELECT c.id,c.name,s.association FROM voice_speaker_contacts s JOIN contacts c ON c.id=s.contact_id WHERE s.session_id=?1 AND s.speaker_id=?2",params![session,speaker.id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional()?;
            if let Some((id, name, association)) = contact {
                speaker.contact_id = Some(id);
                speaker.name = name;
                speaker.association = Some(association);
            }
        }
        Ok(VoiceDiarizationSnapshot {
            session_id: session.into(),
            revision: u64::try_from(revision)?,
            status,
            error,
            speakers,
            turns: serde_json::from_str(&turns)?,
        })
    }

    pub fn voice_diarization_enqueue(&self, session: &str) -> Result<bool> {
        Ok(self.conn.execute(r#"
            INSERT INTO voice_diarization(session_id,status)
            SELECT id,'pending' FROM recording_sessions s WHERE id=?1 AND lifecycle='ended'
              AND EXISTS(SELECT 1 FROM voice_audio_chunks c WHERE c.session_id=s.id AND c.state='complete')
            ON CONFLICT(session_id) DO UPDATE SET status='pending',error=NULL
            WHERE voice_diarization.status='failed'
        "#, [session])? > 0)
    }

    pub fn voice_diarization_claim(&mut self) -> Result<Option<(String, u64)>> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let next = tx.query_row("SELECT session_id,revision FROM voice_diarization WHERE status='pending' ORDER BY rowid LIMIT 1", [], |r| Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).optional()?;
        let Some((session, revision)) = next else {
            return Ok(None);
        };
        let revision = revision
            .checked_add(1)
            .ok_or_else(|| anyhow!("speaker revision overflow"))?;
        tx.execute("UPDATE voice_diarization SET status='running',revision=?2,error=NULL WHERE session_id=?1",params![session,revision])?;
        tx.commit()?;
        Ok(Some((session, u64::try_from(revision)?)))
    }

    pub fn voice_diarization_finish(
        &mut self,
        session: &str,
        expected_revision: u64,
        turns: &[VoiceSpeakerTurn],
    ) -> Result<bool> {
        self.voice_diarization_finish_with_embeddings(session, expected_revision, turns, "", &[])
    }

    pub fn voice_diarization_finish_with_embeddings(
        &mut self,
        session: &str,
        expected_revision: u64,
        turns: &[VoiceSpeakerTurn],
        model_id: &str,
        embeddings: &[(u32, Vec<f32>)],
    ) -> Result<bool> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let current = tx.query_row("SELECT 1 FROM voice_diarization WHERE session_id=?1 AND revision=?2 AND status='running'",params![session,i64::try_from(expected_revision)?], |_| Ok(())).optional()?;
        if current.is_none() {
            return Ok(false);
        }
        let duration: i64 = tx.query_row("SELECT COALESCE(SUM(duration),0) FROM (SELECT MAX((start_sample+sample_count)*1000/sample_rate) duration FROM voice_audio_chunks WHERE session_id=?1 AND state='complete' GROUP BY epoch)",[session],|r|r.get(0))?;
        let duration = u64::try_from(duration)?;
        let mut previous_start = 0;
        let mut ids = std::collections::BTreeSet::new();
        for turn in turns {
            if turn.start_ms < previous_start
                || turn.start_ms >= turn.end_ms
                || turn.end_ms > duration
            {
                return Err(anyhow!("invalid speaker turn timeline"));
            }
            previous_start = turn.start_ms;
            ids.insert(turn.speaker_id);
        }
        if ids.iter().copied().ne(1..=u32::try_from(ids.len())?) {
            return Err(anyhow!("invalid speaker identifiers"));
        }
        let mut embedding_ids = std::collections::BTreeSet::new();
        let mut dimension = None;
        for (speaker, embedding) in embeddings {
            if model_id.trim().is_empty()
                || !ids.contains(speaker)
                || !embedding_ids.insert(*speaker)
                || !valid_embedding(embedding)
                || dimension.is_some_and(|d| d != embedding.len())
            {
                return Err(anyhow!("invalid speaker embedding"));
            }
            dimension = Some(embedding.len());
        }
        let speakers: Vec<_> = ids
            .into_iter()
            .map(|id| VoiceSpeaker {
                id,
                name: format!("说话人 {}", id),
                contact_id: None,
                association: None,
                voiceprint_ready: false,
            })
            .collect();
        tx.execute("UPDATE voice_diarization SET status='ready',error=NULL,revision=revision+1,speakers=?3,turns=?4 WHERE session_id=?1 AND revision=?2 AND status='running'",
            params![session,i64::try_from(expected_revision)?,serde_json::to_string(&speakers)?,serde_json::to_string(turns)?])?;
        let profiles = {
            let mut statement = tx.prepare("SELECT contact_id,embedding FROM contact_voice_profiles WHERE model_id=?1 ORDER BY contact_id")?;
            let stored = statement
                .query_map([model_id], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            stored
                .into_iter()
                .map(|(id, json)| {
                    let embedding = serde_json::from_str::<Vec<f32>>(&json)?;
                    if !valid_embedding(&embedding)
                        || dimension.is_some_and(|expected| expected != embedding.len())
                    {
                        return Err(anyhow!(
                            "invalid persisted contact voice profile for contact {id}"
                        ));
                    }
                    Ok((id, embedding))
                })
                .collect::<Result<Vec<_>>>()?
        };
        for (speaker, embedding) in embeddings {
            tx.execute("INSERT INTO voice_speaker_embeddings(session_id,speaker_id,model_id,embedding) VALUES(?1,?2,?3,?4)",params![session,speaker,model_id,serde_json::to_string(embedding)?])?;
        }
        for (speaker, contact) in match_voice_contacts(embeddings, &profiles) {
            tx.execute("INSERT INTO voice_speaker_contacts(session_id,speaker_id,contact_id,association) VALUES(?1,?2,?3,'automatic')",params![session,speaker,contact])?;
        }
        tx.commit()?;
        Ok(true)
    }

    pub fn voice_diarization_fail(
        &self,
        session: &str,
        expected_revision: u64,
        error: &str,
    ) -> Result<()> {
        self.conn.execute("UPDATE voice_diarization SET status='failed',error=?3,revision=revision+1 WHERE session_id=?1 AND revision=?2 AND status='running'",params![session,i64::try_from(expected_revision)?,error])?;
        Ok(())
    }

    pub fn voice_diarization_release(&self, session: &str, expected_revision: u64) -> Result<()> {
        self.conn.execute("UPDATE voice_diarization SET status='pending',revision=revision+1 WHERE session_id=?1 AND revision=?2 AND status='running'",params![session,i64::try_from(expected_revision)?])?;
        Ok(())
    }

    pub fn voice_diarization_recover(&self) -> Result<()> {
        self.conn.execute("UPDATE voice_diarization SET status='pending',revision=revision+1 WHERE status='running'",[])?;
        Ok(())
    }

    pub fn voice_speaker_rename(
        &mut self,
        target: &VoiceRecordLookup,
        speaker_id: u32,
        name: &str,
        expected_revision: u64,
    ) -> Result<VoiceDiarizationSnapshot> {
        let name = name.trim();
        if !(1..=80).contains(&name.chars().count()) {
            return Err(anyhow!("speaker name must contain 1 to 80 characters"));
        }
        let tx = self.conn.unchecked_transaction()?;
        let Some((session, _)) = self.voice_session_for_target(target)? else {
            return Err(anyhow!("Voice Record not found"));
        };
        let mut snapshot = self.voice_diarization_snapshot(&session)?;
        if snapshot.status != "ready" || snapshot.revision != expected_revision {
            return Err(anyhow!("speaker revision conflict"));
        }
        let stored: String = self.conn.query_row(
            "SELECT speakers FROM voice_diarization WHERE session_id=?1",
            [&session],
            |r| r.get(0),
        )?;
        snapshot.speakers = serde_json::from_str(&stored)?;
        let speaker = snapshot
            .speakers
            .iter_mut()
            .find(|speaker| speaker.id == speaker_id)
            .ok_or_else(|| anyhow!("speaker not found"))?;
        speaker.name = name.into();
        self.voice_speaker_clear_contact(&session, speaker_id)?;
        if self.conn.execute("UPDATE voice_diarization SET speakers=?3,revision=revision+1 WHERE session_id=?1 AND revision=?2 AND status='ready'",params![session,i64::try_from(expected_revision)?,serde_json::to_string(&snapshot.speakers)?])? != 1 { return Err(anyhow!("speaker revision conflict")); }
        let snapshot = self.voice_diarization_snapshot(&session)?;
        tx.commit()?;
        Ok(snapshot)
    }

    fn voice_speaker_clear_contact(&self, session: &str, speaker_id: u32) -> Result<()> {
        self.conn.execute(
            "DELETE FROM contact_voice_profiles WHERE source_session=?1 AND source_speaker=?2",
            params![session, speaker_id],
        )?;
        self.conn.execute(
            "DELETE FROM voice_speaker_contacts WHERE session_id=?1 AND speaker_id=?2",
            params![session, speaker_id],
        )?;
        Ok(())
    }

    pub fn voice_speaker_link_contact(
        &mut self,
        target: &VoiceRecordLookup,
        speaker_id: u32,
        contact_id: Option<i64>,
        expected_revision: u64,
    ) -> Result<VoiceDiarizationSnapshot> {
        let tx = self.conn.unchecked_transaction()?;
        let Some((session, _)) = self.voice_session_for_target(target)? else {
            return Err(anyhow!("Voice Record not found"));
        };
        let snapshot = self.voice_diarization_snapshot(&session)?;
        if snapshot.status != "ready" || snapshot.revision != expected_revision {
            return Err(anyhow!("speaker revision conflict"));
        }
        if !snapshot
            .speakers
            .iter()
            .any(|speaker| speaker.id == speaker_id)
        {
            return Err(anyhow!("speaker not found"));
        }
        if let Some(contact) = contact_id {
            if self
                .conn
                .query_row("SELECT 1 FROM contacts WHERE id=?1", [contact], |_| Ok(()))
                .optional()?
                .is_none()
            {
                return Err(anyhow!("contact not found"));
            }
        }
        self.voice_speaker_clear_contact(&session, speaker_id)?;
        if let Some(contact) = contact_id {
            self.conn.execute("INSERT INTO voice_speaker_contacts(session_id,speaker_id,contact_id,association) VALUES(?1,?2,?3,'confirmed')",params![session,speaker_id,contact])?;
            let embedding = self.conn.query_row("SELECT model_id,embedding FROM voice_speaker_embeddings WHERE session_id=?1 AND speaker_id=?2",params![session,speaker_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
            if let Some((model, json)) = embedding {
                let values: Vec<f32> = serde_json::from_str(&json)?;
                if !valid_embedding(&values) {
                    return Err(anyhow!("invalid persisted speaker embedding"));
                }
                self.conn.execute("INSERT INTO contact_voice_profiles(contact_id,model_id,embedding,source_session,source_speaker) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(contact_id,model_id) DO UPDATE SET embedding=excluded.embedding,source_session=excluded.source_session,source_speaker=excluded.source_speaker",params![contact,model,json,session,speaker_id])?;
            }
        }
        if self.conn.execute("UPDATE voice_diarization SET revision=revision+1 WHERE session_id=?1 AND revision=?2 AND status='ready'",params![session,i64::try_from(expected_revision)?])?!=1 { return Err(anyhow!("speaker revision conflict")); }
        let snapshot = self.voice_diarization_snapshot(&session)?;
        tx.commit()?;
        Ok(snapshot)
    }

    pub fn voice_diarization_playback(
        &self,
        session: &str,
    ) -> Result<Option<VoicePlaybackSnapshot>> {
        let Some(stored) = self.voice_session_get(session)? else {
            return Ok(None);
        };
        let target = if let Some(record_id) = stored.workspace_note_id {
            VoiceRecordLookup::Workspace { record_id }
        } else if let Some(record_id) = stored.project_note_id {
            let project_id = self.conn.query_row(
                "SELECT project_id FROM notes WHERE id=?1",
                [record_id],
                |r| r.get(0),
            )?;
            VoiceRecordLookup::Project {
                project_id,
                record_id,
            }
        } else {
            return Err(anyhow!("Voice Record target missing"));
        };
        self.voice_playback_get(&target)
    }
}

fn valid_embedding(embedding: &[f32]) -> bool {
    !embedding.is_empty()
        && embedding.iter().all(|v| v.is_finite())
        && embedding.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() > 0.0
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> Option<f64> {
    if a.len() != b.len() || !valid_embedding(a) || !valid_embedding(b) {
        return None;
    }
    let dot: f64 = a
        .iter()
        .zip(b)
        .map(|(a, b)| f64::from(*a) * f64::from(*b))
        .sum();
    let norm = |v: &[f32]| v.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>().sqrt();
    Some(dot / (norm(a) * norm(b)))
}

fn match_voice_contacts(
    embeddings: &[(u32, Vec<f32>)],
    profiles: &[(i64, Vec<f32>)],
) -> Vec<(u32, i64)> {
    let mut candidates = Vec::new();
    for (speaker, embedding) in embeddings {
        let mut scores: Vec<_> = profiles
            .iter()
            .filter_map(|(contact, profile)| {
                cosine_similarity(embedding, profile).map(|score| (*contact, score))
            })
            .collect();
        scores.sort_by(|a, b| b.1.total_cmp(&a.1));
        if let Some((contact, score)) = scores.first().copied() {
            if score >= f64::from(crate::voice::diarization::CONTACT_MATCH_THRESHOLD)
                && scores
                    .get(1)
                    .is_none_or(|(_, second)| score - second >= 0.1)
            {
                candidates.push((*speaker, contact, score));
            }
        }
    }
    candidates
        .iter()
        .filter(|(speaker, contact, score)| {
            // Include all other speakers in the competition, even an ambiguous one:
            // two similar voices in this recording must not impersonate one contact.
            embeddings
                .iter()
                .filter(|(other, _)| other != speaker)
                .all(|(_, embedding)| {
                    let profile = profiles
                        .iter()
                        .find(|(id, _)| id == contact)
                        .expect("candidate profile exists");
                    cosine_similarity(embedding, &profile.1)
                        .is_none_or(|other| score - other >= 0.1)
                })
        })
        .map(|(speaker, contact, _)| (*speaker, *contact))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrupted_contact_profile_rejects_result_atomically() {
        let (_root, mut db, target) = setup();
        let id = contact(&db, "张三");
        db.voice_diarization_enqueue("diarization").unwrap();
        let (_, token) = db.voice_diarization_claim().unwrap().unwrap();
        let turns = [VoiceSpeakerTurn {
            start_ms: 0,
            end_ms: 1000,
            speaker_id: 1,
        }];
        for profile in ["[0,0]", "[1]", "[1e100,0]", "[null,0]", "[]"] {
            db.conn.execute("INSERT INTO contact_voice_profiles(contact_id,model_id,embedding) VALUES(?1,'model',?2) ON CONFLICT(contact_id,model_id) DO UPDATE SET embedding=excluded.embedding",params![id,profile]).unwrap();
            assert!(
                db.voice_diarization_finish_with_embeddings(
                    "diarization",
                    token,
                    &turns,
                    "model",
                    &[(1, vec![1.0, 0.0])]
                )
                .is_err(),
                "profile {profile} must be rejected"
            );
            let snapshot = db.voice_diarization_get(&target).unwrap().unwrap();
            assert_eq!(snapshot.status, "running");
            assert_eq!(snapshot.revision, token);
            assert!(snapshot.speakers.is_empty());
            let count: i64 = db
                .conn
                .query_row(
                    "SELECT count(*) FROM voice_speaker_embeddings WHERE session_id='diarization'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 0);
        }
        db.conn
            .execute(
                "UPDATE contact_voice_profiles SET embedding='[1,0]' WHERE contact_id=?1",
                [id],
            )
            .unwrap();
        assert!(db
            .voice_diarization_finish_with_embeddings(
                "diarization",
                token,
                &turns,
                "model",
                &[(1, vec![1.0, 0.0])]
            )
            .unwrap());
    }

    fn ready_voice(db: &mut Database, id: &str, embedding: Vec<f32>) -> VoiceRecordLookup {
        let session = db
            .voice_session_create(&RecordTarget::Workspace, id, id, "Voice")
            .unwrap();
        db.voice_audio_chunk_insert(
            id,
            &AudioChunkManifest {
                source: "microphone",
                epoch: 1,
                chunk_index: 0,
                start_sample: 0,
                sample_count: 16000,
                sample_rate: 16000,
                channels: 1,
                relative_path: format!(".project-mind/voice/{id}/microphone.wav"),
                byte_size: 32044,
            },
        )
        .unwrap();
        db.voice_session_transition(id, session.revision, "ended", None, 1000, 1)
            .unwrap();
        db.voice_diarization_enqueue(id).unwrap();
        let (claimed, revision) = db.voice_diarization_claim().unwrap().unwrap();
        assert_eq!(claimed, id);
        db.voice_diarization_finish_with_embeddings(
            id,
            revision,
            &[VoiceSpeakerTurn {
                start_ms: 0,
                end_ms: 1000,
                speaker_id: 1,
            }],
            "model",
            &[(1, embedding)],
        )
        .unwrap();
        VoiceRecordLookup::Workspace {
            record_id: session.workspace_note_id.unwrap(),
        }
    }

    fn contact(db: &Database, name: &str) -> i64 {
        db.conn
            .execute(
                "INSERT INTO contacts(name,created_at,updated_at) VALUES(?1,'now','now')",
                [name],
            )
            .unwrap();
        db.conn.last_insert_rowid()
    }

    #[test]
    fn confirmed_voice_matches_later_sessions_without_training_automatic_matches() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("db.sqlite"), root.path(), None).unwrap();
        let id = contact(&db, "张三");
        let first = ready_voice(&mut db, "first", vec![1.0, 0.0]);
        let snapshot = db.voice_diarization_get(&first).unwrap().unwrap();
        let confirmed = db
            .voice_speaker_link_contact(&first, 1, Some(id), snapshot.revision)
            .unwrap();
        assert_eq!(
            confirmed.speakers[0].association.as_deref(),
            Some("confirmed")
        );
        assert!(confirmed.speakers[0].voiceprint_ready);
        let second = ready_voice(&mut db, "second", vec![0.98, 0.02]);
        let automatic = db.voice_diarization_get(&second).unwrap().unwrap();
        assert_eq!(automatic.speakers[0].contact_id, Some(id));
        assert_eq!(
            automatic.speakers[0].association.as_deref(),
            Some("automatic")
        );
        let source: String = db
            .conn
            .query_row(
                "SELECT source_session FROM contact_voice_profiles",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(source, "first");
        db.conn
            .execute("UPDATE contacts SET name='新名字' WHERE id=?1", [id])
            .unwrap();
        assert_eq!(
            db.voice_diarization_get(&second).unwrap().unwrap().speakers[0].name,
            "新名字"
        );
        assert!(db
            .voice_speaker_link_contact(&first, 1, None, snapshot.revision)
            .is_err());
        db.voice_speaker_link_contact(&first, 1, None, confirmed.revision)
            .unwrap();
        let count: i64 = db
            .conn
            .query_row("SELECT count(*) FROM contact_voice_profiles", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        db.conn
            .execute("DELETE FROM contacts WHERE id=?1", [id])
            .unwrap();
        let deleted = db.voice_diarization_get(&second).unwrap().unwrap();
        assert_eq!(deleted.speakers[0].name, "说话人 1");
        assert!(deleted.speakers[0].contact_id.is_none());
        assert!(deleted.speakers[0].association.is_none());
    }

    #[test]
    fn voice_profiles_are_workspace_local_and_rename_revokes_own_confirmation() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("first.sqlite"), root.path(), None).unwrap();
        let id = contact(&db, "张三");
        let first = ready_voice(&mut db, "first", vec![1.0, 0.0]);
        let revision = db.voice_diarization_get(&first).unwrap().unwrap().revision;
        let confirmed = db
            .voice_speaker_link_contact(&first, 1, Some(id), revision)
            .unwrap();
        let mut other =
            Database::open(&root.path().join("other.sqlite"), root.path(), None).unwrap();
        contact(&other, "张三");
        let target = ready_voice(&mut other, "other", vec![1.0, 0.0]);
        assert!(other
            .voice_diarization_get(&target)
            .unwrap()
            .unwrap()
            .speakers[0]
            .contact_id
            .is_none());
        let renamed = db
            .voice_speaker_rename(&first, 1, "手动名字", confirmed.revision)
            .unwrap();
        assert_eq!(renamed.speakers[0].name, "手动名字");
        assert!(renamed.speakers[0].contact_id.is_none());
        let count: i64 = db
            .conn
            .query_row("SELECT count(*) FROM contact_voice_profiles", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn matching_rejects_unknown_ambiguous_and_competing_voices() {
        let profiles = vec![(1, vec![1.0, 0.0]), (2, vec![0.0, 1.0])];
        assert!(match_voice_contacts(&[(1, vec![-1.0, 0.0])], &profiles).is_empty());
        assert!(match_voice_contacts(&[(1, vec![1.0, 1.0])], &profiles).is_empty());
        assert!(match_voice_contacts(
            &[(1, vec![1.0, 0.0])],
            &[(1, vec![1.0, 0.0]), (2, vec![0.99, 0.01])]
        )
        .is_empty());
        assert!(
            match_voice_contacts(&[(1, vec![1.0, 0.0]), (2, vec![0.99, 0.01])], &profiles)
                .is_empty()
        );
        assert_eq!(
            match_voice_contacts(&[(1, vec![1.0, 0.0]), (2, vec![0.7, 0.7])], &profiles),
            vec![(1, 1)]
        );
        assert!(cosine_similarity(&[1.0], &[1.0, 0.0]).is_none());
        assert!(!valid_embedding(&[f32::NAN]));
        assert!(!valid_embedding(&[0.0, 0.0]));
    }

    #[test]
    fn linking_without_embedding_does_not_claim_voice_memory() {
        let (_root, mut db, target) = setup();
        let contact = contact(&db, "张三");
        db.voice_diarization_enqueue("diarization").unwrap();
        let (_, token) = db.voice_diarization_claim().unwrap().unwrap();
        db.voice_diarization_finish(
            "diarization",
            token,
            &[VoiceSpeakerTurn {
                start_ms: 0,
                end_ms: 1000,
                speaker_id: 1,
            }],
        )
        .unwrap();
        let snapshot = db.voice_diarization_get(&target).unwrap().unwrap();
        let linked = db
            .voice_speaker_link_contact(&target, 1, Some(contact), snapshot.revision)
            .unwrap();
        assert_eq!(linked.speakers[0].contact_id, Some(contact));
        assert!(!linked.speakers[0].voiceprint_ready);
        let profiles: i64 = db
            .conn
            .query_row("SELECT count(*) FROM contact_voice_profiles", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(profiles, 0);
    }

    #[test]
    fn invalid_embedding_rolls_back_result_and_contact_deletion_cascades_profile() {
        let (_root, mut db, target) = setup();
        db.voice_diarization_enqueue("diarization").unwrap();
        let (_, token) = db.voice_diarization_claim().unwrap().unwrap();
        let turns = [VoiceSpeakerTurn {
            start_ms: 0,
            end_ms: 1000,
            speaker_id: 1,
        }];
        for invalid in [vec![0.0, 0.0], vec![f32::NAN], vec![]] {
            assert!(db
                .voice_diarization_finish_with_embeddings(
                    "diarization",
                    token,
                    &turns,
                    "model",
                    &[(1, invalid)]
                )
                .is_err());
            assert_eq!(
                db.voice_diarization_get(&target).unwrap().unwrap().status,
                "running"
            );
        }
        assert!(db
            .voice_diarization_finish_with_embeddings(
                "diarization",
                token,
                &turns,
                "model",
                &[(2, vec![1.0, 0.0])]
            )
            .is_err());
        db.voice_diarization_finish_with_embeddings(
            "diarization",
            token,
            &turns,
            "model",
            &[(1, vec![1.0, 0.0])],
        )
        .unwrap();
        let id = contact(&db, "张三");
        let revision = db.voice_diarization_get(&target).unwrap().unwrap().revision;
        db.voice_speaker_link_contact(&target, 1, Some(id), revision)
            .unwrap();
        db.conn
            .execute("DELETE FROM contacts WHERE id=?1", [id])
            .unwrap();
        let profiles: i64 = db
            .conn
            .query_row("SELECT count(*) FROM contact_voice_profiles", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(profiles, 0);
        let snapshot = db.voice_diarization_get(&target).unwrap().unwrap();
        assert_eq!(snapshot.speakers[0].name, "说话人 1");
        assert!(snapshot.speakers[0].contact_id.is_none());
    }

    #[test]
    fn diarization_enqueue_failure_rolls_back_session_end() {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("db.sqlite"), root.path(), None).unwrap();
        let session = db
            .voice_session_create(&RecordTarget::Workspace, "atomic", "atomic", "Voice")
            .unwrap();
        db.voice_audio_chunk_insert(
            "atomic",
            &AudioChunkManifest {
                source: "microphone",
                epoch: 1,
                chunk_index: 0,
                start_sample: 0,
                sample_count: 16000,
                sample_rate: 16000,
                channels: 1,
                relative_path: ".project-mind/voice/atomic/microphone.wav".into(),
                byte_size: 32044,
            },
        )
        .unwrap();
        db.conn.execute_batch("CREATE TRIGGER reject_diarization BEFORE INSERT ON voice_diarization BEGIN SELECT RAISE(ABORT,'enqueue failed'); END;").unwrap();
        assert!(db
            .voice_session_save_stopped("atomic", session.revision, "ended", None, 1000, 1, true)
            .is_err());
        let unchanged = db.voice_session_get("atomic").unwrap().unwrap();
        assert_eq!(unchanged.lifecycle, session.lifecycle);
        assert_eq!(unchanged.revision, session.revision);
        assert!(!db.voice_diarization_has_pending().unwrap());
        db.conn
            .execute_batch("DROP TRIGGER reject_diarization")
            .unwrap();
        db.voice_session_save_stopped("atomic", session.revision, "ended", None, 1000, 1, true)
            .unwrap();
        assert!(db.voice_diarization_has_pending().unwrap());
    }

    fn setup() -> (tempfile::TempDir, Database, VoiceRecordLookup) {
        let root = tempfile::tempdir().unwrap();
        let mut db = Database::open(&root.path().join("db.sqlite"), root.path(), None).unwrap();
        let session = db
            .voice_session_create(
                &RecordTarget::Workspace,
                "diarization",
                "diarization",
                "Voice",
            )
            .unwrap();
        db.voice_audio_chunk_insert(
            "diarization",
            &AudioChunkManifest {
                source: "microphone",
                epoch: 1,
                chunk_index: 0,
                start_sample: 0,
                sample_count: 16000,
                sample_rate: 16000,
                channels: 1,
                relative_path: ".project-mind/voice/diarization/microphone.wav".into(),
                byte_size: 32044,
            },
        )
        .unwrap();
        let target = VoiceRecordLookup::Workspace {
            record_id: session.workspace_note_id.unwrap(),
        };
        assert!(!db.voice_diarization_enqueue("diarization").unwrap());
        db.voice_session_transition("diarization", session.revision, "ended", None, 1000, 1)
            .unwrap();
        (root, db, target)
    }

    #[test]
    fn diarization_is_scoped_idempotent_and_preserves_named_results() {
        let (root, mut db, target) = setup();
        db.voice_transcript_append_final("diarization", "original", 100, 900, "原始文本", None)
            .unwrap();
        assert_eq!(
            db.voice_diarization_get(&target).unwrap().unwrap().status,
            "not_started"
        );
        assert!(db
            .voice_diarization_get(&VoiceRecordLookup::Project {
                project_id: 1,
                record_id: 1
            })
            .unwrap()
            .is_none());
        assert!(db.voice_diarization_enqueue("diarization").unwrap());
        assert!(!db.voice_diarization_enqueue("diarization").unwrap());
        let (_, token) = db.voice_diarization_claim().unwrap().unwrap();
        let turns = [
            VoiceSpeakerTurn {
                start_ms: 0,
                end_ms: 800,
                speaker_id: 1,
            },
            VoiceSpeakerTurn {
                start_ms: 500,
                end_ms: 1000,
                speaker_id: 2,
            },
        ];
        assert!(db
            .voice_diarization_finish("diarization", token, &turns)
            .unwrap());
        let snapshot = db.voice_diarization_get(&target).unwrap().unwrap();
        let renamed = db
            .voice_speaker_rename(&target, 1, "  张三  ", snapshot.revision)
            .unwrap();
        assert_eq!(renamed.speakers[0].name, "张三");
        assert!(db
            .voice_speaker_rename(&target, 2, "李四", snapshot.revision)
            .is_err());
        assert!(db
            .voice_speaker_rename(&target, 3, "李四", renamed.revision)
            .is_err());
        assert!(!db.voice_diarization_enqueue("diarization").unwrap());
        drop(db);
        let db = Database::open(&root.path().join("db.sqlite"), root.path(), None).unwrap();
        assert_eq!(
            db.voice_diarization_get(&target).unwrap().unwrap().speakers[0].name,
            "张三"
        );
        let original: (i64,i64,String) = db.conn.query_row("SELECT start_ms,end_ms,text FROM voice_transcript_segments WHERE session_id='diarization'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(original, (100, 900, "原始文本".into()));
        db.conn
            .execute("DELETE FROM recording_sessions WHERE id='diarization'", [])
            .unwrap();
        let count: i64 = db
            .conn
            .query_row("SELECT count(*) FROM voice_diarization", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn diarization_recovery_invalidates_old_results_and_failure_requires_retry() {
        let (root, mut db, target) = setup();
        db.voice_diarization_enqueue("diarization").unwrap();
        let (_, old) = db.voice_diarization_claim().unwrap().unwrap();
        drop(db);
        let mut db = Database::open(&root.path().join("db.sqlite"), root.path(), None).unwrap();
        db.voice_diarization_recover().unwrap();
        assert!(!db
            .voice_diarization_finish("diarization", old, &[])
            .unwrap());
        let (_, token) = db.voice_diarization_claim().unwrap().unwrap();
        assert!(token > old);
        assert!(db
            .voice_diarization_finish(
                "diarization",
                token,
                &[VoiceSpeakerTurn {
                    start_ms: 0,
                    end_ms: 1001,
                    speaker_id: 1
                }]
            )
            .is_err());
        db.voice_diarization_fail("diarization", token, "model failed")
            .unwrap();
        assert!(db.voice_diarization_claim().unwrap().is_none());
        assert_eq!(
            db.voice_diarization_get(&target).unwrap().unwrap().status,
            "failed"
        );
        assert!(db.voice_diarization_enqueue("diarization").unwrap());
        let (_, token) = db.voice_diarization_claim().unwrap().unwrap();
        assert!(db
            .voice_diarization_finish("diarization", token, &[])
            .unwrap());
    }
}
