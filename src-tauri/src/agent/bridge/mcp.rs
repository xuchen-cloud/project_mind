//! Stdio MCP adapter for methods exposed by the local bridge registry.
use super::{client::BridgeClient, registry};
use crate::agent::{
    errors::{AgentError, AgentResult, ApiResponse, ErrorCode},
    models::WorkspaceBinding,
};
use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult,
        PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig, Tool,
        ToolAnnotations,
    },
    service::{RequestContext, RoleServer},
    ErrorData, ServerHandler, ServiceExt,
};
use serde_json::{Map, Value};
use std::{borrow::Cow, path::Path, sync::Arc};

type BridgeCall = dyn Fn(&str, Value, &str) -> AgentResult<Value> + Send + Sync;


pub struct MindMcp {
    call: Arc<BridgeCall>,
}

impl MindMcp {
    fn with_call(call: Arc<BridgeCall>) -> Self {
        Self { call }
    }

    /// Discover and authenticate once. Every later call uses this exact binding.
    pub async fn connect(workspace: &Path, grant_id: &str) -> AgentResult<Self> {
        let workspace = workspace.to_path_buf();
        let grant_id = grant_id.to_owned();
        tokio::task::spawn_blocking(move || {
            let client = BridgeClient::discover(&grant_id)?;
            let binding = client.connect(&grant_id, &workspace, &new_request_id())?;
            Ok(Self::bound(client, binding, grant_id))
        })
        .await
        .map_err(|_| AgentError::new(ErrorCode::RuntimeUnavailable, "MCP connection task failed"))?
    }

    pub(crate) fn bound(client: BridgeClient, binding: WorkspaceBinding, grant_id: String) -> Self {
        Self::with_call(Arc::new(move |method, params, request_id| {
            client.call(&grant_id, &binding, method, params, request_id)
        }))
    }

    pub async fn serve_stdio(self) -> Result<(), String> {
        let service = self
            .serve(rmcp::transport::stdio())
            .await
            .map_err(|error| error.to_string())?;
        service.waiting().await.map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn new_request_id() -> String {
    format!("mcp-{:032x}", rand::random::<u128>())
}

fn tool_name(method: &str) -> String {
    format!("mind_{}", method.replace('.', "_"))
}

fn method_for_tool(name: &str) -> Option<&'static str> {
    registry::registered_methods()
        .into_iter()
        .find(|entry| tool_name(entry.method) == name)
        .map(|entry| entry.method)
}

fn tools() -> Vec<Tool> {
    registry::registered_methods()
        .into_iter()
        .map(|entry| {
            let schema = entry
                .parameters
                .as_object()
                .expect("registered object schema")
                .clone();
            Tool::new(tool_name(entry.method), entry.description, schema)
                .with_annotations(ToolAnnotations::new().read_only(entry.read_only))
        })
        .collect()
}

fn validate(method: &str, arguments: Option<Map<String, Value>>) -> Result<Value, AgentError> {
    let params = Value::Object(arguments.unwrap_or_default());
    registry::validate(method, &params)?;
    Ok(params)
}

fn result(request_id: String, value: AgentResult<Value>) -> CallToolResult {
    let is_error = value.is_err();
    let response =
        serde_json::to_value(ApiResponse::from_result(request_id, value)).expect("response JSON");
    let mut result = if is_error {
        CallToolResult::error(vec![ContentBlock::text(response.to_string())])
    } else {
        CallToolResult::success(vec![ContentBlock::text(response.to_string())])
    };
    result.structured_content = Some(response);
    result
}

impl ServerHandler for MindMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_protocol_version(ProtocolVersion::V_2025_11_25)
            .with_server_info(rmcp::model::Implementation::new(
                "project-mind",
                env!("CARGO_PKG_VERSION"),
            ))
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(ProtocolVersion::known_up_to(&ProtocolVersion::V_2025_11_25))
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(tools()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let Some(method) = method_for_tool(&request.name) else {
            return Err(ErrorData::new(
                rmcp::model::ErrorCode::METHOD_NOT_FOUND,
                "Unknown tool",
                None,
            ));
        };
        let validation_id = new_request_id();
        let params = match validate(method, request.arguments) {
            Ok(params) => params,
            Err(error) => return Ok(result(validation_id, Err(error)).into()),
        };
        let request_id = if registry::is_read_only(method) == Some(false) {
            // The caller's stable ID is the native mutation receipt identity.
            // Registry validation already requires 1–128 bytes for every write.
            params["requestId"].as_str().expect("validated write requestId").to_owned()
        } else {
            validation_id
        };
        let call = Arc::clone(&self.call);
        let method = method.to_owned();
        let call_id = request_id.clone();
        let value = tokio::task::spawn_blocking(move || call(&method, params, &call_id))
            .await
            .unwrap_or_else(|_| {
                Err(AgentError::new(
                    ErrorCode::RuntimeUnavailable,
                    "MCP bridge call failed",
                ))
            });
        Ok(result(request_id, value).into())
    }
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;
