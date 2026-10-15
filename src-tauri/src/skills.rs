//! Read and manage DSH Skills without starting an assistant or resolving a model.
use std::{path::PathBuf, process::Stdio, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::process::Command;

use crate::{
    agent::models::WorkspaceBinding,
    dsh_assistant::{
        assistant_data_root, assistant_script_command, runtime_data_directory, ProjectContext,
    },
};

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SkillCatalog {
    skills: Vec<Skill>,
    directories: Vec<String>,
    complete: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Skill {
    name: String,
    description: String,
    // Required in the wire contract, while allowing JSON null.
    #[serde(deserialize_with = "Option::<String>::deserialize")]
    path: Option<String>,
    source: String,
    disabled: bool,
    #[serde(deserialize_with = "Option::<String>::deserialize")]
    entry_path: Option<String>,
    #[serde(deserialize_with = "Option::<String>::deserialize")]
    directory: Option<String>,
    can_delete: bool,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SkillAction {
    Enable,
    Disable,
    Delete,
}

impl SkillAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Enable => "enable",
            Self::Disable => "disable",
            Self::Delete => "delete",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct WorkspaceSnapshot {
    binding: WorkspaceBinding,
    root: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
struct CatalogContext {
    workspace: Option<WorkspaceSnapshot>,
    cwd: PathBuf,
    user_data: PathBuf,
}

impl CatalogContext {
    fn resolve(app: &tauri::AppHandle, project_id: Option<i64>) -> Result<Self, String> {
        let data_root = assistant_data_root()?;
        let state = app.state::<crate::AppState>();
        let current = crate::lock_mutex(&state.current_workspace);
        let workspace = current.as_ref().map(|runtime| WorkspaceSnapshot {
            binding: runtime.agent_binding.clone(),
            root: runtime.paths.root_path.clone(),
        });
        let project = if let Some(id) = project_id {
            let runtime = current.as_ref().ok_or("请先打开项目所属的工作区")?;
            let mut db = crate::lock_mutex(&runtime.db);
            Some(ProjectContext::resolve(
                &mut db,
                &runtime.paths.root_path,
                id,
            )?)
        } else {
            None
        };
        let cwd = match (project.as_ref(), workspace.as_ref()) {
            (Some(project), _) => project.directory.clone(),
            (None, Some(workspace)) => workspace.root.canonicalize()
                .map_err(|_| "工作区目录不可用，请重新打开工作区")?,
            _ => data_root.join("workspace"),
        };
        let user_data = match workspace.as_ref() {
            Some(workspace) => {
                runtime_data_directory(&data_root, &workspace.binding.workspace_id, project_id)?
            }
            _ => data_root,
        };
        Ok(Self {
            workspace,
            cwd,
            user_data,
        })
    }

    fn verify(&self, current: &Self) -> Result<(), String> {
        if self != current {
            return Err("工作区或项目目录已切换，请重新读取 Skills".into());
        }
        Ok(())
    }
}

async fn read_catalog(mut command: Command) -> Result<SkillCatalog, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let child = command
        .spawn()
        .map_err(|error| format!("无法启动 Skills 目录进程: {error}"))?;
    let output = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
        .await
        .map_err(|_| "读取 Skills 目录超时".to_string())?
        .map_err(|error| format!("无法读取 Skills 目录: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "读取 Skills 目录失败 ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Skills 目录返回无效 JSON: {error}"))
}

fn configure_catalog_command(
    command: &mut Command,
    context: &CatalogContext,
    management: Option<(&str, SkillAction)>,
) {
    command
        .arg("--cwd")
        .arg(&context.cwd)
        .env("PROJECT_MIND_DSH_USER_DATA", &context.user_data);
    if let Some((entry, action)) = management {
        command
            .arg("--action")
            .arg(action.as_str())
            .arg("--entry")
            .arg(entry);
    }
}

async fn run_catalog(
    app: &tauri::AppHandle,
    project_id: Option<i64>,
    management: Option<(&str, SkillAction)>,
) -> Result<SkillCatalog, String> {
    let context = CatalogContext::resolve(app, project_id)?;
    let mut command = assistant_script_command(app, "skills.mjs")?;
    configure_catalog_command(&mut command, &context, management);
    context.verify(&CatalogContext::resolve(app, project_id)?)?;
    let result = read_catalog(command).await;
    // Resolve against the current native DB again, including canonical directory ownership.
    context.verify(&CatalogContext::resolve(app, project_id)?)?;
    result
}

#[tauri::command]
pub(crate) async fn skills_list(
    app: tauri::AppHandle,
    project_id: Option<i64>,
) -> Result<SkillCatalog, String> {
    run_catalog(&app, project_id, None).await
}

#[tauri::command]
pub(crate) async fn skills_manage(
    app: tauri::AppHandle,
    project_id: Option<i64>,
    entry_path: String,
    action: SkillAction,
) -> Result<SkillCatalog, String> {
    run_catalog(&app, project_id, Some((&entry_path, action))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_requires_exact_wire_shape_and_nullable_path() {
        let valid = r#"{"skills":[{"name":"example","description":"method","path":null,"source":"builtin","disabled":false,"entryPath":null,"directory":null,"canDelete":false}],"directories":["/skills"],"complete":true}"#;
        let catalog: SkillCatalog = serde_json::from_str(valid).unwrap();
        assert!(catalog.skills[0].path.is_none());
        let serialized = serde_json::to_value(&catalog).unwrap();
        assert_eq!(
            serialized,
            serde_json::from_str::<serde_json::Value>(valid).unwrap()
        );
        for invalid in [
            valid.replace("\"path\":null,", ""),
            valid.replace("\"disabled\":false,", ""),
            valid.replace("\"entryPath\":null,", ""),
            valid.replace("\"directory\":null,", ""),
            valid.replace(",\"canDelete\":false", ""),
            valid.replace("\"disabled\":false", "\"disabled\":null"),
            valid.replace("\"canDelete\":false", "\"canDelete\":1"),
            valid.replace("\"complete\":true", "\"complete\":1"),
            valid.replace(
                "\"source\":\"builtin\"",
                "\"source\":\"builtin\",\"unexpected\":true",
            ),
            format!("log line\n{valid}"),
            format!("{valid}\n{valid}"),
        ] {
            assert!(
                serde_json::from_str::<SkillCatalog>(&invalid).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn management_actions_and_command_arguments_follow_wire_contract() {
        let context = CatalogContext {
            workspace: None,
            cwd: "/workspace/project".into(),
            user_data: "/data/projects/one/1".into(),
        };
        for action in ["enable", "disable", "delete"] {
            let parsed: SkillAction = serde_json::from_value(serde_json::json!(action)).unwrap();
            let mut command = Command::new("node");
            configure_catalog_command(
                &mut command,
                &context,
                Some(("/skills/a b/SKILL.md", parsed)),
            );
            let args: Vec<_> = command
                .as_std()
                .get_args()
                .map(|arg| arg.to_str().unwrap())
                .collect();
            assert_eq!(
                args,
                [
                    "--cwd",
                    "/workspace/project",
                    "--action",
                    action,
                    "--entry",
                    "/skills/a b/SKILL.md"
                ]
            );
            assert!(command
                .as_std()
                .get_envs()
                .any(|(key, value)| key == "PROJECT_MIND_DSH_USER_DATA"
                    && value == Some(context.user_data.as_os_str())));
        }
        for invalid in [
            serde_json::json!("remove"),
            serde_json::json!("Enable"),
            serde_json::json!(null),
            serde_json::json!(1),
        ] {
            assert!(serde_json::from_value::<SkillAction>(invalid).is_err());
        }
        let mut command = Command::new("node");
        configure_catalog_command(&mut command, &context, None);
        assert_eq!(
            command.as_std().get_args().collect::<Vec<_>>(),
            ["--cwd", "/workspace/project"]
        );
    }

    #[test]
    fn stale_workspace_generation_root_and_project_path_are_rejected() {
        let original = CatalogContext {
            workspace: Some(WorkspaceSnapshot {
                binding: WorkspaceBinding {
                    workspace_id: "one".into(),
                    generation: "opened".into(),
                },
                root: "/workspace".into(),
            }),
            cwd: "/workspace/project".into(),
            user_data: "/data/projects/one/1".into(),
        };
        assert!(original.verify(&original).is_ok());
        for mutation in 0..6 {
            let mut changed = CatalogContext {
                workspace: original.workspace.clone(),
                cwd: original.cwd.clone(),
                user_data: original.user_data.clone(),
            };
            match mutation {
                0 => changed.workspace = None,
                1 => changed.workspace.as_mut().unwrap().binding.generation = "reopened".into(),
                2 => changed.workspace.as_mut().unwrap().binding.workspace_id = "two".into(),
                3 => changed.workspace.as_mut().unwrap().root = "/other".into(),
                4 => changed.cwd = "/workspace/moved-project".into(),
                _ => changed.user_data = "/different-data".into(),
            }
            assert!(original.verify(&changed).is_err());
            assert!(changed.verify(&original).is_err());
        }
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    async fn one_shot_preserves_stderr_and_rejects_stdout_noise() {
        // The shared resolver selects the same development Node as the assistant.
        let node =
            crate::dsh_assistant::development_node(if cfg!(windows) { "node.exe" } else { "node" })
                .unwrap();
        let mut success = Command::new(&node);
        success.args([
            "--eval",
            "console.log(JSON.stringify({skills:[],directories:[],complete:true}))",
        ]);
        assert!(read_catalog(success).await.unwrap().complete);
        let mut command = Command::new(&node);
        command.args([
            "--eval",
            "process.stderr.write('catalog fixture failed'); process.exit(7)",
        ]);
        assert!(read_catalog(command)
            .await
            .unwrap_err()
            .contains("catalog fixture failed"));
        let mut command = Command::new(node);
        command.args(["--eval", "console.log('unexpected startup log'); console.log(JSON.stringify({skills:[],directories:[],complete:true}))"]);
        assert!(read_catalog(command).await.unwrap_err().contains("JSON"));
    }
}
