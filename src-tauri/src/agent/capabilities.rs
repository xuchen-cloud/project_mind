use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub method: &'static str,
    pub permission: &'static str,
    pub read_only: bool,
    pub implemented: bool,
    pub delivery: &'static str,
}

/// A discovery manifest, not a promise that planned tools can execute.
/// AI-09 will derive CLI/MCP schemas from validated Rust request DTOs here.
pub fn capabilities() -> Vec<Capability> {
    [
        ("context.get", "context.read", true, true, "AI-02"),
        ("context.settings.get", "settings.read", true, true, "AI-02"),
        (
            "context.settings.update",
            "settings.write",
            false,
            true,
            "AI-02",
        ),
        (
            "context.instruction.list",
            "settings.read",
            true,
            true,
            "AI-02",
        ),
        (
            "context.instruction.upsert",
            "settings.write",
            false,
            true,
            "AI-02",
        ),
        (
            "context.instruction.delete",
            "settings.write",
            false,
            true,
            "AI-02",
        ),
        ("changes.list", "changes.read", true, true, "AI-02"),
        ("context.overview.get", "context.read", true, true, "AI-04"),
        (
            "context.overview.refresh",
            "context.refresh",
            false,
            false,
            "AI-04",
        ),
        ("knowledge.search", "context.read", true, false, "AI-04"),
        ("knowledge.get", "context.read", true, false, "AI-04"),
        ("source.search", "source.read", true, false, "AI-03"),
        ("source.read", "source.read", true, false, "AI-03"),
        ("reference.list", "source.read", true, false, "AI-03"),
        ("session.create", "session.write", false, false, "AI-05"),
        ("session.summary.get", "session.read", true, false, "AI-08"),
        (
            "session.messages.read",
            "session.read",
            true,
            false,
            "AI-08",
        ),
        ("run.start", "run.start", false, false, "AI-05"),
        ("run.cancel", "run.cancel", false, false, "AI-05"),
        ("record.create", "content.create", false, false, "AI-07"),
        ("record.blocks.get", "source.read", true, false, "AI-16"),
        ("record.patch", "record.patch", false, false, "AI-16"),
        (
            "record.version.restore",
            "record.restore",
            false,
            false,
            "AI-16",
        ),
        ("file.create", "content.create", false, false, "AI-07"),
        ("file.source.read", "source.read", true, false, "AI-18"),
        ("file.update", "file.update", false, false, "AI-17"),
        (
            "file.version.restore",
            "file.restore",
            false,
            false,
            "AI-17",
        ),
        ("todo.create", "content.create", false, false, "AI-07"),
        ("todo.update", "todo.update", false, false, "AI-19"),
        ("operation.undo", "operation.undo", false, false, "AI-19"),
    ]
    .into_iter()
    .map(
        |(method, permission, read_only, implemented, delivery)| Capability {
            method,
            permission,
            read_only,
            implemented,
            delivery,
        },
    )
    .collect()
}
