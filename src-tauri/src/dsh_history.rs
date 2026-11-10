//! Read-only Session summaries share the Workspace host without preparing a model or CLI.
use super::*;

const HISTORY_FINGERPRINT: &str = "history-only";

fn resolve(app: &tauri::AppHandle, project_id: Option<i64>) -> Result<Identity, String> {
    let state = app.state::<crate::AppState>();
    let current = crate::lock_mutex(&state.current_workspace);
    let runtime = current.as_ref().ok_or("请先打开工作区")?;
    let context = if let Some(id) = project_id {
        AssistantContext::Project(ProjectContext::resolve(
            &mut crate::lock_mutex(&runtime.db),
            &runtime.paths.root_path,
            id,
        )?)
    } else {
        let directory = runtime
            .paths
            .root_path
            .canonicalize()
            .map_err(|_| "工作区目录不可用")?;
        if !directory.is_dir() || directory.to_str().is_none() {
            return Err("工作区目录不可用".into());
        }
        AssistantContext::Workspace { directory }
    };
    Ok(Identity {
        workspace_id: runtime.agent_binding.workspace_id.clone(),
        workspace_generation: runtime.agent_binding.generation.clone(),
        root: runtime.paths.root_path.clone(),
        fingerprint: HISTORY_FINGERPRINT.into(),
        context,
    })
}

pub(super) fn is_history(identity: Option<&Identity>) -> bool {
    identity.is_some_and(|identity| identity.fingerprint == HISTORY_FINGERPRINT)
}

fn validate(app: &tauri::AppHandle, identity: &Identity) -> Result<(), String> {
    let current = resolve(app, identity.project_id())?;
    if current.workspace_id != identity.workspace_id
        || current.workspace_generation != identity.workspace_generation
        || current.root != identity.root
        || current.context != identity.context
    {
        return Err("工作区或助手范围已变化，请重试".into());
    }
    Ok(())
}

impl ScopedRuntimes {
    async fn ensure_history(
        &mut self,
        app: &tauri::AppHandle,
        project_id: Option<i64>,
    ) -> Result<&mut RuntimeState, String> {
        let target = resolve(app, project_id)?;
        let same_workspace = self.host_identity.as_ref().is_some_and(|host| {
            host.workspace_id == target.workspace_id
                && host.workspace_generation == target.workspace_generation
                && host.root == target.root
        });
        let alive = self.active_count()? > 0;
        let moved = self
            .scopes
            .values()
            .filter_map(|scope| scope.process.as_ref())
            .any(|process| process.context_directory_changed(&target));
        if !same_workspace || !alive || moved {
            if alive {
                self.scopes
                    .values_mut()
                    .find(|scope| scope.process.is_some())
                    .expect("live host")
                    .reject_running_replacement()
                    .await?;
            }
            self.stop().await?;
            let host = resolve(app, None)?;
            let mut command = workspace_runtime_command(app, &host)?;
            command.arg("--history-only");
            let scope_key = if host.project_id().is_some() {
                "project"
            } else {
                "workspace"
            };
            let mut message = serde_json::json!({"type":"configure","historyOnly":true,"contexts":[host.context_message(),target.context_message()]});
            message[scope_key] = host.context_message();
            let state = app.state::<DshAssistantState>();
            let mut process = state
                .boot
                .run(AssistantProcess::launch(command, &message))
                .await?;
            if let Err(error) = validate(app, &target) {
                process.stop().await?;
                return Err(error);
            }
            self.generation += 1;
            process
                .context_directories
                .insert(None, host.directory().to_path_buf());
            process
                .context_directories
                .insert(project_id, target.directory().to_path_buf());
            self.host_identity = Some(host.clone());
            self.scopes.insert(
                None,
                RuntimeState {
                    process: Some(process),
                    identity: Some(host),
                    generation: self.generation,
                    ..Default::default()
                },
            );
        }
        let mut target = target;
        target.fingerprint = self
            .host_identity
            .as_ref()
            .ok_or(TRANSPORT_ERROR)?
            .fingerprint
            .clone();
        let generation = self.generation;
        self.scopes
            .entry(project_id)
            .or_insert_with(|| RuntimeState {
                generation,
                ..Default::default()
            });
        let scope = self.scope_mut(project_id)?;
        if scope.identity.as_ref() != Some(&target) {
            let process = scope.process.as_mut().ok_or(TRANSPORT_ERROR)?;
            session_request(
                &process.url,
                &process.session_http,
                &mut process.session_cookie,
                SessionRequest::Private {
                    method: "mind/context".into(),
                    request: serde_json::json!({"context":target.context_message()}),
                },
            )
            .await?;
            validate(app, &target)?;
            process
                .context_directories
                .insert(project_id, target.directory().to_path_buf());
            scope.identity = Some(target);
        }
        Ok(scope)
    }
}

#[derive(Serialize)]
pub(crate) struct SessionSummaries {
    revision: String,
    items: Vec<AssistantSession>,
}

// Admission/identity changes stay serialized; the catalog request owns cloned
// transport data and does not hold the global runtime mutex across storage I/O.
#[tauri::command]
pub(crate) async fn dsh_assistant_session_summaries(
    caller: Webview,
    state: State<'_, DshAssistantState>,
    project_id: Option<i64>,
    expected_binding: crate::agent::models::WorkspaceBinding,
) -> Result<SessionSummaries, String> {
    authorize_caller(&caller)?;
    authorize_scope_label(caller.label(), project_id)?;
    let (identity, generation, url, client, mut cookie, mut closed) = {
        let mut runtimes = state.inner.lock().await;
        if state.stopping.load(Ordering::SeqCst) {
            return Err("应用正在退出".into());
        }
        let current = resolve(caller.app_handle(), project_id)?;
        if !current.matches_workspace(&expected_binding, &current.root) {
            return Err("工作区已变化，请重试".into());
        }
        let scope = runtimes
            .ensure_history(caller.app_handle(), project_id)
            .await?;
        let identity = scope.identity.clone().ok_or(TRANSPORT_ERROR)?;
        if !identity.matches_workspace(&expected_binding, &identity.root) {
            return Err("工作区已变化，请重试".into());
        }
        let process = scope.process.as_mut().ok_or(TRANSPORT_ERROR)?;
        authenticate(
            &process.url,
            &process.session_http,
            &mut process.session_cookie,
        )
        .await?;
        (
            identity,
            scope.generation,
            process.url.clone(),
            process.session_http.clone(),
            process.session_cookie.clone(),
            process.closed.subscribe(),
        )
    };
    let value = tokio::select! {
        biased;
        _ = closed.changed() => return Err("助手已停止，请重试".into()),
        result = session_request(&url, &client, &mut cookie, SessionRequest::Private {
            method: "mind/session/summaries".into(), request: serde_json::json!({"context":identity.context_message()})
        }) => result?,
    };
    validate(caller.app_handle(), &identity)?;
    let runtimes = state.inner.lock().await;
    let scope = runtimes.scopes.get(&project_id).ok_or(TRANSPORT_ERROR)?;
    if state.stopping.load(Ordering::SeqCst)
        || scope.generation != generation
        || scope.identity.as_ref() != Some(&identity)
    {
        return Err("助手范围已变化，请重试".into());
    }
    drop(runtimes);
    let revision = value["revision"]
        .as_str()
        .filter(|revision| !revision.is_empty())
        .ok_or(SESSION_ERROR)?
        .to_owned();
    Ok(SessionSummaries {
        revision,
        items: parse_session_list(value, identity.directory())?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn history_transport_reads_without_provider_or_cli_and_enforces_scope() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().canonicalize().unwrap();
        let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../packages/dsh-assistant");
        let mut command = Command::new(
            development_node(if cfg!(windows) { "node.exe" } else { "node" }).unwrap(),
        );
        command
            .arg(package.join("scripts/runtime.mjs"))
            .args([
                "--embedded",
                "--history-only",
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--no-open",
            ])
            .env("PROJECT_MIND_DSH_USER_DATA", directory.join("history"))
            .env("PROJECT_MIND_DSH_PROFILE_DIR", directory.join("profile"))
            .env_remove("PROJECT_MIND_DSH_PATCH");
        let config = serde_json::json!({"type":"configure","historyOnly":true,"project":{"id":1,"name":"History fixture","directory":directory}});
        let mut process = AssistantProcess::launch(command, &config).await.unwrap();
        let result = session_request(
            &process.url,
            &process.session_http,
            &mut process.session_cookie,
            SessionRequest::Private {
                method: "mind/session/summaries".into(),
                request: serde_json::json!({"context":{"kind":"project","id":1}}),
            },
        )
        .await
        .unwrap();
        assert!(result["revision"]
            .as_str()
            .is_some_and(|revision| !revision.is_empty()));
        assert!(parse_session_list(result, &directory).unwrap().is_empty());
        assert!(session_request(
            &process.url,
            &process.session_http,
            &mut process.session_cookie,
            SessionRequest::Private {
                method: "mind/session/summaries".into(),
                request: serde_json::json!({"context":{"kind":"project","id":2}})
            }
        )
        .await
        .is_err());
        process.stop().await.unwrap();
    }
}
