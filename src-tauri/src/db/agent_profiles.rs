//! Trusted Host profile resolution and successful tool-probe receipts.
//! These methods are internal; GUI authorization and the actual probe belong to
//! the command/service boundary. Model tools must never call verification writes.
use super::{AiDefaultRole, Database};
use crate::{
    agent::errors::{AgentError, AgentResult, ErrorCode},
    ai_provider::ResolvedAiProfile,
};
use rusqlite::params;
use sha2::{Digest, Sha256};

/// Installed by the formal schema migration, never by profile reads/writes.
pub(crate) const AGENT_PROFILE_VERIFICATIONS_SQL: &str = "
CREATE TABLE IF NOT EXISTS agent_profile_verifications (
    fingerprint TEXT PRIMARY KEY NOT NULL,
    verified_at TEXT NOT NULL
);";

// Deliberately neither serializable nor Debug: profile contains a decrypted key.
pub(crate) struct ResolvedAgentProfile {
    pub profile: ResolvedAiProfile,
    pub fingerprint: String,
}

fn unavailable() -> AgentError {
    AgentError::new(
        ErrorCode::ProfileUnavailable,
        "The selected AI profile is unavailable",
    )
}

fn storage_error(_: impl std::fmt::Display) -> AgentError {
    AgentError::new(
        ErrorCode::IoFailed,
        "Cannot access AI profile verification storage",
    )
}

fn validate_fingerprint(fingerprint: &str) -> AgentResult<()> {
    if fingerprint.len() != 71
        || !fingerprint.starts_with("sha256:")
        || !fingerprint[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Invalid profile fingerprint",
        ));
    }
    Ok(())
}

impl Database {
    pub(crate) fn agent_resolve_profile(
        &self,
        profile_override_id: Option<i64>,
    ) -> AgentResult<ResolvedAgentProfile> {
        let binding = if profile_override_id.is_none() {
            Some(
                self.effective_default_binding(AiDefaultRole::General)
                    .map_err(storage_error)?,
            )
        } else {
            None
        };
        let profile_id = profile_override_id
            .or_else(|| binding.as_ref().and_then(|binding| binding.profile_id))
            .ok_or_else(unavailable)?;
        let stored = self.ai_profile_storage(profile_id).map_err(|error| {
            if matches!(
                error.downcast_ref::<rusqlite::Error>(),
                Some(rusqlite::Error::QueryReturnedNoRows)
            ) {
                unavailable()
            } else {
                storage_error(error)
            }
        })?;
        if !stored.enabled {
            return Err(unavailable());
        }
        if stored.provider_family != "openai_compatible" || !stored.supports_text {
            return Err(AgentError::new(
                ErrorCode::ToolCallUnsupported,
                "This profile does not support the built-in Agent provider mapping",
            ));
        }
        let model = binding
            .as_ref()
            .and_then(|binding| binding.model.as_deref())
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .unwrap_or(stored.default_model.trim());
        if model.is_empty()
            || stored.base_url.trim().is_empty()
            || stored.api_key_ciphertext.is_empty()
            || stored.api_key_nonce.is_empty()
            || stored.api_key_salt.is_empty()
        {
            return Err(unavailable());
        }
        if self
            .secret_password
            .as_deref()
            .is_none_or(|password| password.trim().is_empty())
        {
            return Err(AgentError::new(
                ErrorCode::SecretsLocked,
                "Workspace AI secrets are locked",
            ));
        }
        // Only key decryption failures are SecretsLocked. Storage/network
        // failures must remain errors when the assistant filters locked models.
        let api_key = crate::secret_crypto::decrypt_secret(
            &stored.api_key_ciphertext,
            &stored.api_key_nonce,
            &stored.api_key_salt,
            self.secret_password
                .as_deref()
                .expect("validated secret password"),
        )
        .map_err(|_| {
            AgentError::new(
                ErrorCode::SecretsLocked,
                "Cannot unlock the selected profile's API key",
            )
        })?;
        if api_key.trim().is_empty() {
            return Err(unavailable());
        }
        let network = self.resolve_ai_network().map_err(storage_error)?;
        // Length-delimited JSON avoids ambiguous concatenations; ciphertext,
        // salt and nonce invalidate receipts on key replacement without storing
        // a plaintext key or its hash in verification storage.
        let identity = serde_json::to_vec(&(
            "mind-agent-profile/v1",
            stored.id,
            &stored.provider_family,
            &stored.base_url,
            &stored.default_model,
            model,
            &stored.api_key_ciphertext,
            &stored.api_key_nonce,
            &stored.api_key_salt,
        ))
        .map_err(storage_error)?;
        let fingerprint = format!("sha256:{:x}", Sha256::digest(identity));
        let profile = ResolvedAiProfile {
            profile_name: stored.name,
            provider_family: stored.provider_family,
            base_url: stored.base_url,
            model: model.to_string(),
            api_key,
            supports_text: stored.supports_text,
            supports_image: stored.supports_image,
            network,
        };
        Ok(ResolvedAgentProfile {
            profile,
            fingerprint,
        })
    }

    /// Read by the trusted Host before deciding whether a real tool probe is needed.
    /// `supports_text` alone never creates a verification receipt.
    pub(crate) fn agent_profile_verified(&self, fingerprint: &str) -> AgentResult<bool> {
        validate_fingerprint(fingerprint)?;
        self.conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_profile_verifications WHERE fingerprint = ?1)",
                [fingerprint],
                |row| row.get(0),
            )
            .map_err(storage_error)
    }

    /// Trusted GUI/Host only, after an actual successful tool roundtrip. The
    /// caller must re-resolve the profile after the asynchronous probe and only
    /// record the fingerprint if it still matches the probed configuration.
    pub(crate) fn agent_profile_record_verification(&self, fingerprint: &str) -> AgentResult<()> {
        validate_fingerprint(fingerprint)?;
        self.conn
            .execute(
                "INSERT INTO agent_profile_verifications(fingerprint, verified_at) VALUES (?1, ?2)
             ON CONFLICT(fingerprint) DO UPDATE SET verified_at = excluded.verified_at",
                params![fingerprint, super::now_iso()],
            )
            .map_err(storage_error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret_crypto;
    use rusqlite::Connection;

    fn database() -> Database {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE ai_provider_profiles (
            id INTEGER PRIMARY KEY, name TEXT NOT NULL, provider_family TEXT NOT NULL,
            base_url TEXT NOT NULL, api_key_ciphertext TEXT NOT NULL, api_key_nonce TEXT NOT NULL,
            api_key_salt TEXT NOT NULL, api_key_last4 TEXT NOT NULL, default_model TEXT NOT NULL,
            supports_text INTEGER NOT NULL, supports_image INTEGER NOT NULL,
            supports_file INTEGER NOT NULL, enabled INTEGER NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE ai_capability_bindings (capability TEXT PRIMARY KEY, use_default INTEGER NOT NULL,
            profile_id INTEGER, model TEXT, updated_at TEXT NOT NULL);
            CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL);").unwrap();
        // The fixture explicitly installs the migration-owned table.
        conn.execute_batch(AGENT_PROFILE_VERIFICATIONS_SQL).unwrap();
        Database {
            conn,
            workspace_root: std::path::PathBuf::new(),
            secret_password: Some("fixture-password".into()),
            native_workspace_id: None,
        }
    }

    fn profile(db: &Database, name: &str) -> i64 {
        let key =
            secret_crypto::encrypt_secret(&format!("key-{name}"), "fixture-password").unwrap();
        db.conn.execute("INSERT INTO ai_provider_profiles (name, provider_family, base_url,
            api_key_ciphertext, api_key_nonce, api_key_salt, api_key_last4, default_model,
            supports_text, supports_image, supports_file, enabled, created_at, updated_at)
            VALUES (?1,'openai_compatible','https://fixture.invalid/v1',?2,?3,?4,?5,?6,1,0,0,1,'created','updated')",
            params![name,key.ciphertext_b64,key.nonce_b64,key.salt_b64,key.last4,format!("model-{name}")]).unwrap();
        db.conn.last_insert_rowid()
    }

    fn default_profile(db: &Database, id: i64, model: Option<&str>) {
        db.conn.execute("INSERT INTO ai_capability_bindings VALUES ('default',0,?1,?2,'updated')
            ON CONFLICT(capability) DO UPDATE SET profile_id=excluded.profile_id, model=excluded.model",
            params![id,model]).unwrap();
    }

    fn error_code(db: &Database, id: Option<i64>) -> ErrorCode {
        db.agent_resolve_profile(id)
            .err()
            .expect("resolution must fail")
            .code
    }

    #[test]
    fn agent_profiles_resolve_current_default_and_explicit_override_without_fallback() {
        let db = database();
        let general = profile(&db, "general");
        let other = profile(&db, "override");
        default_profile(&db, general, Some("bound-model"));
        let resolved = db.agent_resolve_profile(None).unwrap();
        assert_eq!(resolved.profile.model, "bound-model");
        assert_eq!(resolved.profile.api_key, "key-general");
        assert!(!db.agent_profile_verified(&resolved.fingerprint).unwrap());
        let overridden = db.agent_resolve_profile(Some(other)).unwrap();
        assert_eq!(overridden.profile.model, "model-override");
        assert_eq!(overridden.profile.api_key, "key-override");
        assert_ne!(resolved.fingerprint, overridden.fingerprint);
        assert_eq!(error_code(&db, Some(9999)), ErrorCode::ProfileUnavailable);
        default_profile(&db, other, None);
        assert_eq!(
            db.agent_resolve_profile(None).unwrap().fingerprint,
            overridden.fingerprint
        );
    }

    #[test]
    fn agent_profiles_reject_disabled_nontext_other_provider_and_missing_model_or_key() {
        let db = database();
        let id = profile(&db, "general");
        default_profile(&db, id, None);
        for (sql, code) in [
            ("UPDATE ai_provider_profiles SET enabled=0", ErrorCode::ProfileUnavailable),
            ("UPDATE ai_provider_profiles SET enabled=1,supports_text=0", ErrorCode::ToolCallUnsupported),
            ("UPDATE ai_provider_profiles SET supports_text=1,provider_family='gemini_compatible'", ErrorCode::ToolCallUnsupported),
            ("UPDATE ai_provider_profiles SET provider_family='openai_compatible',default_model=''", ErrorCode::ProfileUnavailable),
            ("UPDATE ai_provider_profiles SET default_model='model',api_key_ciphertext=''", ErrorCode::ProfileUnavailable),
        ] {
            db.conn.execute(sql, []).unwrap();
            assert_eq!(error_code(&db, Some(id)), code);
            assert_eq!(error_code(&db, None), code);
        }
    }

    #[test]
    fn agent_profiles_locked_or_wrong_password_returns_redacted_typed_failure() {
        let mut db = database();
        let id = profile(&db, "secret");
        for password in [None, Some("".to_owned()), Some("wrong-password".to_owned())] {
            db.secret_password = password;
            let error = db.agent_resolve_profile(Some(id)).err().unwrap();
            assert_eq!(error.code, ErrorCode::SecretsLocked);
            assert!(!error.message.contains("key-secret"));
            assert!(error.details.is_none());
        }
    }

    #[test]
    fn agent_profiles_verification_invalidated_by_url_model_binding_and_key_changes() {
        let db = database();
        let id = profile(&db, "general");
        default_profile(&db, id, None);
        let original = db.agent_resolve_profile(None).unwrap().fingerprint;
        db.agent_profile_record_verification(&original).unwrap();
        db.agent_profile_record_verification(&original).unwrap();
        assert!(db.agent_profile_verified(&original).unwrap());
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT COUNT(*) FROM agent_profile_verifications",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        let mut previous = original;
        for sql in [
            "UPDATE ai_provider_profiles SET base_url='https://changed.invalid/v1'",
            "UPDATE ai_provider_profiles SET default_model='changed-model'",
            "UPDATE ai_capability_bindings SET model='new-binding-model'",
        ] {
            db.conn.execute(sql, []).unwrap();
            let next = db.agent_resolve_profile(None).unwrap().fingerprint;
            assert_ne!(next, previous);
            assert!(!db.agent_profile_verified(&next).unwrap());
            db.agent_profile_record_verification(&next).unwrap();
            previous = next;
        }
        let key = secret_crypto::encrypt_secret("replacement-key", "fixture-password").unwrap();
        db.conn.execute("UPDATE ai_provider_profiles SET api_key_ciphertext=?1,api_key_nonce=?2,api_key_salt=?3", params![key.ciphertext_b64,key.nonce_b64,key.salt_b64]).unwrap();
        let changed = db.agent_resolve_profile(None).unwrap().fingerprint;
        assert_ne!(changed, previous);
        assert!(!db.agent_profile_verified(&changed).unwrap());
    }

    #[test]
    fn agent_profiles_verification_persists_without_automatic_table_creation() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("profiles.sqlite");
        let mut db = database();
        let id = profile(&db, "persisted");
        let fingerprint = db.agent_resolve_profile(Some(id)).unwrap().fingerprint;
        let connection = Connection::open(&file).unwrap();
        connection
            .execute_batch(AGENT_PROFILE_VERIFICATIONS_SQL)
            .unwrap();
        db.conn = connection;
        assert!(!db.agent_profile_verified(&fingerprint).unwrap());
        db.agent_profile_record_verification(&fingerprint).unwrap();
        drop(db.conn);
        db.conn = Connection::open(&file).unwrap();
        assert!(db.agent_profile_verified(&fingerprint).unwrap());
        assert_eq!(
            db.agent_profile_record_verification("key-secret")
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
        db.conn
            .execute("DROP TABLE agent_profile_verifications", [])
            .unwrap();
        assert_eq!(
            db.agent_profile_verified(&fingerprint).unwrap_err().code,
            ErrorCode::IoFailed
        );
        assert_eq!(
            db.agent_profile_record_verification(&fingerprint)
                .unwrap_err()
                .code,
            ErrorCode::IoFailed
        );
    }

    #[test]
    fn agent_profiles_missing_default_is_unavailable() {
        let db = database();
        assert_eq!(error_code(&db, None), ErrorCode::ProfileUnavailable);
    }

    #[test]
    fn agent_profiles_network_storage_failure_is_not_a_locked_key() {
        let db = database();
        let id = profile(&db, "storage-error");
        db.conn.execute("DROP TABLE app_settings", []).unwrap();
        assert_eq!(error_code(&db, Some(id)), ErrorCode::IoFailed);
    }
}
