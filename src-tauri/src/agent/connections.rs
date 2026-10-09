use serde::{Deserialize, Serialize};

/// Trusted GUI input. Operations are assigned by the Host, never by a client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionCreateInput {
    pub client_label: String,
    pub workspace_content: bool,
    pub project_ids: Vec<i64>,
    pub session_read: bool,
    /// Explicit trusted GUI selection; the Host accepts only implemented Record operations.
    #[serde(default)]
    pub write_operations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionGrant {
    pub id: String,
    pub client_label: String,
    pub workspace_id: String,
    pub workspace_content: bool,
    pub project_ids: Vec<i64>,
    pub operations: Vec<String>,
    pub enabled: bool,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProject {
    pub id: i64,
    pub name: String,
}
