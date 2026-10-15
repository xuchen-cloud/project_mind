//! Read the DSH Skills catalog without starting an assistant or resolving a model.
use std::{path::PathBuf, process::Stdio, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tokio::process::Command;

use crate::{
    agent::models::WorkspaceBinding,
    dsh_assistant::{
        assistant_data_root, assistant_script_command, project_data_directory, ProjectContext,
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
#[serde(deny_unknown_fields)]
struct Skill {
    name: String,
    description: String,
    // Required in the wire contract, while allowing JSON null.
    #[serde(deserialize_with = "Option::<String>::deserialize")]
    path: Option<String>,
    source: String,
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
        let cwd = project
            .as_ref()
            .map(|project| project.directory.clone())
            .or_else(|| workspace.as_ref().map(|workspace| workspace.root.clone()))
            .unwrap_or_else(|| data_root.join("workspace"));
        let user_data = match (workspace.as_ref(), project_id) {
            (Some(workspace), Some(id)) => {
                project_data_directory(&data_root, &workspace.binding.workspace_id, id)?
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

#[tauri::command]
pub(crate) async fn skills_list(
    app: tauri::AppHandle,
    project_id: Option<i64>,
) -> Result<SkillCatalog, String> {
    let context = CatalogContext::resolve(&app, project_id)?;
    let mut command = assistant_script_command(&app, "skills.mjs")?;
    command
        .arg("--cwd")
        .arg(&context.cwd)
        .env("PROJECT_MIND_DSH_USER_DATA", &context.user_data);
    let result = read_catalog(command).await;
    // Resolve against the current native DB again, including canonical directory ownership.
    context.verify(&CatalogContext::resolve(&app, project_id)?)?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_requires_exact_wire_shape_and_nullable_path() {
        let valid = r#"{"skills":[{"name":"example","description":"method","path":null,"source":"builtin"}],"directories":["/skills"],"complete":true}"#;
        let catalog: SkillCatalog = serde_json::from_str(valid).unwrap();
        assert!(catalog.skills[0].path.is_none());
        for invalid in [
            valid.replace("\"path\":null,", ""),
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
