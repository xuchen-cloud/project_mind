use super::models::ObjectRef;
use serde::{Deserialize, Serialize};

/// Trusted GUI input. Operations are assigned by the Host, never by a client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionCreateInput {
    pub client_label: String,
    pub workspace_content: bool,
    pub project_ids: Vec<i64>,
    /// Resolve all current, unarchived Projects when each request authenticates.
    #[serde(default)]
    pub all_projects: bool,
    /// Explicit extra operations selected by trusted GUI. The historical field
    /// name includes optional contact.read/contact.write as well as content writes;
    /// contact.write implies contact.read. Omission grants no address-book access.
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
    #[serde(default)]
    pub all_projects: bool,
    pub operations: Vec<String>,
    #[serde(default)]
    pub objects: Option<Vec<ObjectRef>>,
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
