# Bind Agent operations to Workspace and atomic receipts

Agent domain services receive a trusted RequestContext with a Workspace UUID, open generation, caller, explicit scope grant and request ID. Caller-supplied ObjectRef scope is checked against authoritative business ownership; project and Workspace Record IDs remain distinct. A workspace-content grant does not grant all projects.

Schema 26 uses the existing pre-upgrade backup and a savepoint for its foundation tables and version marker. Existing workspaces stay disabled, with no queued jobs or sessions. QuickNote keeps its existing meaning and storage. New schema batches do not re-enter the retired Activity/Conclusion migration path.

User scope settings and Context Instructions use revision CAS and are writable only from the trusted GUI adapter. Each successful mutation, caller/request payload receipt and metadata outbox entry commits in one short database transaction. Failed transactions leave no receipt or changes. Replays return the original result; reusing a request for a different payload or operation is an explicit conflict. Receipts remain after session deletion.

This establishes the shared transaction boundary for later Record/File/Todo services. It does not relax ADR-0003: only Committed Content can become a version or model input. Knowledge/Overview, Record versions, source indexing, Pi session lifecycle and business-event delivery remain owned by their implementation packages.

## 2026-10-10 target clarification: Harness runtime settings

The [unified AI specification](../requirements/ai-work-context-spec.md) authorizes a narrow future Harness tool or script for structured organization schedule settings. It must bind a trusted user request, actual setting permissions, revision CAS and a native saved result. This does not expose arbitrary scope settings, Context Instructions or connection grants to model writes. The original GUI-only boundary describes the existing implementation; the narrow scheduling path remains to be implemented. Skill-file edits and runtime-setting saves may settle separately with explicit partial results, while shared Context publication keeps its required atomic transaction.
