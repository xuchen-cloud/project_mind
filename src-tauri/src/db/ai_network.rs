//! Workspace-wide AI network settings. Proxy credentials are ordinary local
//! configuration, as requested; snapshot responses never include the password.
use super::{now_iso, Database, APP_SETTING_KEY_AI_NETWORK_SETTINGS};
use crate::{
    ai_network::{validate_settings, ResolvedAiNetwork},
    models::{AiNetworkSettings, AiNetworkSettingsUpsertInput, AiProxyMode},
};
use anyhow::{Context, Result};
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredNetwork {
    mode: AiProxyMode,
    proxy_url: Option<String>,
    username: Option<String>,
    password: Option<String>,
}

impl StoredNetwork {
    fn snapshot(&self) -> AiNetworkSettings {
        AiNetworkSettings {
            mode: self.mode,
            proxy_url: self.proxy_url.clone(),
            username: self.username.clone(),
            has_stored_password: self.password.is_some(),
        }
    }
}

impl Database {
    fn stored_ai_network(&self) -> Result<StoredNetwork> {
        let value = self
            .conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = ?1",
                params![APP_SETTING_KEY_AI_NETWORK_SETTINGS],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let stored = match value {
            Some(value) => serde_json::from_str::<StoredNetwork>(&value)
                .context("failed to read AI network settings")?,
            None => StoredNetwork::default(),
        };
        validate_settings(&stored.snapshot())?;
        Ok(stored)
    }

    pub fn ai_network_settings_get(&self) -> Result<AiNetworkSettings> {
        Ok(self.stored_ai_network()?.snapshot())
    }

    pub fn ai_network_settings_upsert(
        &mut self,
        input: AiNetworkSettingsUpsertInput,
    ) -> Result<AiNetworkSettings> {
        let mut next = StoredNetwork {
            mode: input.mode,
            ..StoredNetwork::default()
        };
        if input.mode == AiProxyMode::Custom {
            let mut url = reqwest::Url::parse(input.proxy_url.as_deref().unwrap_or("").trim())
                .context("请输入有效的代理地址")?;
            let embedded_username = (!url.username().is_empty())
                .then(|| {
                    percent_decode_str(url.username())
                        .decode_utf8()
                        .map(|value| value.into_owned())
                })
                .transpose()
                .context("代理用户名编码无效")?;
            let embedded_password = url
                .password()
                .map(|value| {
                    percent_decode_str(value)
                        .decode_utf8()
                        .map(|value| value.into_owned())
                })
                .transpose()
                .context("代理密码编码无效")?;
            url.set_username("")
                .map_err(|_| anyhow::anyhow!("代理地址必须使用 HTTP 或 HTTPS"))?;
            url.set_password(None)
                .map_err(|_| anyhow::anyhow!("代理地址必须使用 HTTP 或 HTTPS"))?;
            next.proxy_url = Some(url.to_string());
            next.username = embedded_username
                .or(input.username)
                .filter(|value| !value.is_empty());
            validate_settings(&next.snapshot())?;
            let old = self.stored_ai_network()?;
            next.password = match embedded_password.or(input.password) {
                Some(password) => (!password.is_empty()).then_some(password),
                None if old.mode == AiProxyMode::Custom
                    && old.proxy_url == next.proxy_url
                    && old.username == next.username =>
                {
                    old.password
                }
                None => None,
            };
        }
        self.conn.execute(
            "INSERT INTO app_settings(key,value_json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
            params![APP_SETTING_KEY_AI_NETWORK_SETTINGS, serde_json::to_string(&next)?, now_iso()],
        )?;
        Ok(next.snapshot())
    }

    pub(crate) fn resolve_ai_network(&self) -> Result<ResolvedAiNetwork> {
        let stored = self.stored_ai_network()?;
        let proxy_url = if let Some(value) = stored.proxy_url {
            let mut url = reqwest::Url::parse(&value)?;
            if let Some(username) = stored.username {
                let encoded = utf8_percent_encode(&username, NON_ALPHANUMERIC).to_string();
                url.set_username(&encoded)
                    .map_err(|_| anyhow::anyhow!("invalid proxy username"))?;
            }
            if let Some(password) = stored.password {
                let encoded = utf8_percent_encode(&password, NON_ALPHANUMERIC).to_string();
                url.set_password(Some(&encoded))
                    .map_err(|_| anyhow::anyhow!("invalid proxy password"))?;
            }
            Some(url.to_string())
        } else {
            None
        };
        Ok(ResolvedAiNetwork {
            mode: stored.mode,
            proxy_url,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NetworkHarness {
        _temp: tempfile::TempDir,
        root: std::path::PathBuf,
        workspace_root: std::path::PathBuf,
    }

    fn setup_database() -> (NetworkHarness, Database) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let workspace_root = root.join("workspace");
        std::fs::create_dir(&workspace_root).unwrap();
        let db = Database::open(
            &root.join("app.sqlite3"),
            &workspace_root,
            Some("test-secret".into()),
        )
        .unwrap();
        (
            NetworkHarness {
                _temp: temp,
                root,
                workspace_root,
            },
            db,
        )
    }

    fn custom(
        url: &str,
        username: Option<&str>,
        password: Option<&str>,
    ) -> AiNetworkSettingsUpsertInput {
        AiNetworkSettingsUpsertInput {
            mode: AiProxyMode::Custom,
            proxy_url: Some(url.into()),
            username: username.map(str::to_owned),
            password: password.map(str::to_owned),
        }
    }

    #[test]
    fn settings_save_reopen_mask_password_and_reach_profile() {
        let (harness, mut db) = setup_database();
        assert_eq!(
            db.ai_network_settings_get().unwrap(),
            AiNetworkSettings::default()
        );
        let saved = db
            .ai_network_settings_upsert(custom(
                " http://127.0.0.1:7890 ",
                Some("a@b"),
                Some("p:%40/密"),
            ))
            .unwrap();
        assert!(saved.has_stored_password);
        assert_eq!(saved.proxy_url.as_deref(), Some("http://127.0.0.1:7890/"));
        let snapshot = serde_json::to_string(&db.ai_settings_get().unwrap()).unwrap();
        assert!(!snapshot.contains("p:%40/密"));
        assert_eq!(
            db.stored_ai_network().unwrap().password.as_deref(),
            Some("p:%40/密")
        );
        assert!(db
            .ai_network_settings_upsert(custom("socks5://localhost:1080", None, None))
            .is_err());
        assert_eq!(db.ai_network_settings_get().unwrap(), saved);
        drop(db);
        let mut db = Database::open(
            &harness.root.join("app.sqlite3"),
            &harness.workspace_root,
            Some("test-secret".into()),
        )
        .unwrap();
        assert_eq!(db.ai_network_settings_get().unwrap(), saved);
        let resolved = db.resolve_ai_network().unwrap();
        let url = reqwest::Url::parse(resolved.proxy_url.as_deref().unwrap()).unwrap();
        assert_eq!(
            percent_decode_str(url.username()).decode_utf8().unwrap(),
            "a@b"
        );
        assert_eq!(
            percent_decode_str(url.password().unwrap())
                .decode_utf8()
                .unwrap(),
            "p:%40/密"
        );
        let profile = db
            .ai_profile_upsert(crate::models::AiProviderProfileUpsertInput {
                id: None,
                name: "Proxy model".into(),
                provider_family: "openai_compatible".into(),
                base_url: "https://provider.example/v1".into(),
                api_key: Some("test-key".into()),
                default_model: "test-model".into(),
                supports_text: true,
                supports_image: false,
                supports_file: false,
                enabled: true,
            })
            .unwrap();
        assert_eq!(
            db.resolve_profile_by_id(profile.id)
                .unwrap()
                .network
                .proxy_url,
            resolved.proxy_url
        );
        let kept = db
            .ai_network_settings_upsert(custom("http://127.0.0.1:7890", Some("a@b"), None))
            .unwrap();
        assert!(kept.has_stored_password);
        assert!(
            !db.ai_network_settings_upsert(custom("http://127.0.0.1:7890", Some("a@b"), Some("")))
                .unwrap()
                .has_stored_password
        );
    }

    #[test]
    fn url_credentials_are_split_and_new_identity_does_not_inherit_password() {
        let (_harness, mut db) = setup_database();
        let saved = db
            .ai_network_settings_upsert(custom("http://user:p%40ss@localhost:8080", None, None))
            .unwrap();
        assert_eq!(saved.username.as_deref(), Some("user"));
        assert!(saved.has_stored_password);
        assert_eq!(saved.proxy_url.as_deref(), Some("http://localhost:8080/"));
        assert_eq!(
            db.stored_ai_network().unwrap().password.as_deref(),
            Some("p@ss")
        );
        assert!(
            !db.ai_network_settings_upsert(custom("http://other:8080", Some("user"), None))
                .unwrap()
                .has_stored_password
        );
        db.ai_network_settings_upsert(AiNetworkSettingsUpsertInput {
            mode: AiProxyMode::Direct,
            proxy_url: None,
            username: None,
            password: None,
        })
        .unwrap();
        assert_eq!(db.resolve_ai_network().unwrap().proxy_url, None);
        let settings = db
            .ai_network_settings_upsert(AiNetworkSettingsUpsertInput {
                mode: AiProxyMode::System,
                proxy_url: None,
                username: None,
                password: None,
            })
            .unwrap();
        assert_eq!(settings, AiNetworkSettings::default());
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("p@ss"));
    }
}
