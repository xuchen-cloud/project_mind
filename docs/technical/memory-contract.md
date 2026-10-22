# Memory implementation contract

2026-10-23. Working contract for #109 / #108 / #103 (V1–V5), replacing the unused legacy KnowledgeNode memory representation for the DSH path. Existing Record/File/Todo data is untouched; no legacy memory migration or compatibility layer.

## Product decisions

- Workspace facts retain six categories. Project facts are Overview background/agreements or decisions, never promoted automatically to Workspace. A shared fact/version engine does not change these product identities.
- Explicit remember/correct/forget requests save without a second approval. Only real user messages or GUI actions confer confirmation; quoted source text and model output do not.
- Source deletion does not invalidate a saved conclusion. Source availability and permission to use the conclusion remain separate. Archive is not deletion and does not itself make retained original text unreadable.
- Default organization may change semantics silently, including confirmed facts (user explicitly approved). New machine-written versions are inferred; confirmation belongs to the version actually confirmed. Optional approval protects all organization mutations.
- Undo within 24 hours restores the whole atomic merge unit, not unrelated units. It creates new versions, checks all current revisions, and never overwrites a later user edit/forget. Restored facts are locked against further organization. Immutable operation history supports repeated organization.
- Conditions are P0. Validity excludes out-of-date facts from present-tense use while preserving history. Partial patch distinguishes omitted fields from explicit null.
- Forget preserves a durable fact-specific suppression. Temporary disable does not permit automatic recreation. Re-remember requires an explicit user action. Evidence anchors distinguish independent facts in one message; source/category alone is not fact identity.
- Default context is a budgeted compact snapshot until the required 50–100 real Chinese multi-turn three-arm evaluation passes. Layered retrieval may be exercised experimentally. No claimed performance/quality pass without actual measurements.

## Shared JSON interface

All fields camelCase. Scope uses `{kind:"workspace"}` or `{kind:"project",projectId:number}`. Native store receives a trusted access scope; Project access includes Workspace facts and that Project only. GUI may choose any existing Project. Node does not supply another Project's authority.

Fact: `{id,scope,category,content,condition:string|null,core:boolean,state:"active"|"disabled"|"forgotten"|"superseded",confirmation:"confirmed"|"inferred",revision:number,validFrom:string|null,validTo:string|null,supersededBy:string|null,sources:Source[],locked:boolean,autoOrganizedAt:string|null,rollbackId:string|null}`.

Category: `background|domain|interest|method|preference|knowledge_pointer` (Workspace), `agreement|decision` (Project).

Source: `{kind:"message"|"file"|"record",id:string,scope:Scope,label:string,excerpt:string,sessionId?:string,messageId?:string}`. Sources represent actual native/host captured evidence; models cannot invent them. Native/host appends sources when saving, and GUI details resolve current availability separately.

Request variants:
- `{operation:"list",scope,includeInactive?:boolean}` → `{facts:Fact[],proposals:Proposal[],settings:Settings}`.
- `{operation:"context",scope,query:string,budgetChars:number,strategy:"snapshot"|"layered"}` → `{facts:Fact[],omittedIds:string[],suppressed:Suppression[]}`. Conditions remain explicit in all snapshots; layered mode filters/ranks; backend always enforces scope/state/time.
- `{operation:"apply",requestId:string,changes:Change[]}` → `{facts:Fact[],receipt:string,pending:boolean,proposalId:string|null}`.
- `{operation:"rollback",requestId:string,rollbackId:string}` → apply result.
- `{operation:"approve"|"reject",requestId:string,proposalId:string}` → apply result.
- `{operation:"settings",requireApproval:boolean}` → Settings.

Change variants (each has scope):
- `{action:"add",scope,content,category,condition?:string|null,core?:boolean,validFrom?:string|null,validTo?:string|null}`.
- `{action:"patch",scope,id,expectedRevision,content?,condition?,core?,validFrom?,validTo?}`.
- `{action:"forget"|"disable"|"enable",scope,id,expectedRevision}`.
- `{action:"merge",scope,id,expectedRevision,content,condition?,from:[{id,expectedRevision}]}`. The surviving id is explicit; all source unions and supersession are atomic.

Settings: `{requireApproval:boolean}`. Proposal: `{id,createdAt,changes:Change[]}`. Suppression: `{id,scope,content,condition:string|null}` is a negative constraint, never positive memory. Store access includes `{scope,origin:"user"|"organization",sources:Source[]}`; this is NOT deserialized from a model tool input.

Native public entry: `Database::memory_execute(access: &MemoryAccess, request: MemoryRequest) -> Result<serde_json::Value,String>`. DTOs and service live in `db::memory_facts`. GUI command `memory_execute` takes `{request}` and binds current Workspace; DSH bridge payload `{operation:"memory",sessionId,request, ...trustedHostEvidence}` is handled separately from project file sources.

## Work packages and validation

1. V1 store + DSH: atomic remember/patch/forget, strict project scope, source independence, stable fact identity, next-request context refresh, actual receipts. Public store tests, real DSH runtime/local Provider integration, GUI management tests. No windows during unit tests.
2. V4 organization + management: silent and approval modes, immutable history, merge rollback, concurrency and disable/forget protections; organization running through the real DSH path, without a second memory daemon.
3. V1/V5 retrieval: Chinese lexical ranking, real-source lookup, request adoption transparency and 50–100 real-model three-arm evaluation before default switch. Do not treat mock/provider stubs as semantic validation.

Main agent owns bridge/GUI command wiring, integration and Standards/Spec review. Implementation agents own disjoint files. Existing unrelated Office changes stay in their original checkout.

## DSH rc.2 request admission

The SDK freezes loop-built `llm/stream` options and derives every request from the durable Session surface. Memory therefore uses supported `agent/pre-step` admission and `agent/request` configuration hooks: fetch context using the exact selected model's resolved capacity, append an identified snapshot on first admission, then replace its active surface node. The archive retains previous snapshots for audit; the active surface has one current snapshot. Resume and post-compaction requests fetch current native facts again. Original human messages are never rewritten. Generated assistant recollections/compaction prose are not mechanically erased; the current snapshot explicitly supersedes historical recollections.

Historical memory tool payloads are replaced on the active surface while their actual receipt, pending state and proposal ID remain available. A fresh read remains available during the current turn until a memory mutation invalidates it. Mutation results, including nested programmatic calls and actual native errors, are also carried into the next snapshot as operation results so the model can truthfully report outcomes.

Budgeting resolves `ctx.llm.resolveModelInfo` for the selected provider/model, reserves output and envelope space, and conservatively counts serialized UTF-8 input bytes. Unknown capacity admits zero fact character budget. Whole facts that exceed the final serialized budget become explicit `omittedIds`; conditions, behavior instructions and suppression constraints are never silently truncated. If mandatory content cannot fit, admission reports an explicit budget error.

After the first successful provider chunk, the host sends `{operation:"memoryAdoption",sessionId,turn,step,requestId,strategy:"snapshot",budgetChars,facts:[{id,revision,condition}],omittedIds}` using the SDK's actual turn and step. Failed admission produces no adoption record. The native ledger saves the adopted immutable versions, and the official `conversation.chat.turnTail` extension displays the records belonging to that answer; later edits do not rewrite an old answer's record. `memory_apply` and `memory_organize` optionally accept `source_refs`, forwarded as bridge-envelope `sourceRefs` for native delivered-source validation; refs are never accepted as proof on their own.

`memory_behavior` accepts `{action:"read"|"write",content?,expected_revision?}` and sends `{operation:"memoryBehavior",action,sessionId,mode,origin:"user",userMessage,content?,expectedRevision?}`. The native layer owns the fixed Workspace Skill path, validates real-user write authorization and CAS, and returns `{path,content,revision,receipt?}`. Context responses include the current `behavior` object; the next request adopts edited instructions without changing facts or the actual scheduling configuration.

## Explicit Project history

`Database::memory_project_history(access: &MemoryAccess, query: &str, cursor: Option<&str>, limit: usize, budget_chars: usize) -> Result<Value,String>` is read-only and requires trusted access to one existing Project. It reads existing immutable `agent_overview_versions` and Project agreement/decision `memory_fact_versions`; it creates no log table and never enters routine context.

Response: `{historical:true,scope,changeClassification:"raw_content",events:[{time,origin:"overview"|"memory",id,revision,kind:"added"|"changed"|"removed"|"state",before:Point|null,after:Point|null,sources:Pointer[]}],nextCursor:string|null,requiredBudgetChars:number|null}`. Each `Point` contains `text`, `condition`, `state`, `validFrom`, `validTo`, `supersededBy` and `confirmation`. `revision` identifies the resulting publication/version, including a removal publication. Pointers contain native object/version/locator identities or message IDs, without titles or original excerpts. Reasons are absent because these stores do not record explicit change reasons. The Agent selects meaningful changes from raw content differences; timestamp and normalized-whitespace-only differences are omitted, while validity and confirmation changes remain visible.

Query matches a normalized, case-insensitive substring of either before/after text or condition; empty query lists changes. Chronological keyset pages capture immutable upper version bounds and include an item key for multiple changes in one publication. At most 128 candidates are inspected per call, so a noise-only page may have no events and a continuation cursor. `limit` is 1–100; `budget_chars` is 0–100000 serialized event characters (the small response envelope is separate). A whole event that cannot fit remains unconsumed and `requiredBudgetChars` reports its size; resume with sufficient budget. A cursor is bound to its Project and normalized query. No event is silently skipped at a budget boundary.

Current forgotten/disabled memory heads are excluded from all historical content, including subsequent cursor pages. Only the current Project's Overview is queried; foreign/Workspace source scopes and currently foreign native owners exclude historical Overview item text. Deleted sources retain correctly scoped saved conclusions and pointer identities. Historical results are explicitly past evidence, never present-tense memory.

## Local verification, 2026-10-23

Implementation branch: `codex/memory-system`, based on `32a9c40`. These results apply to this change set; unchanged passing groups were reused after later isolated fixes. Cargo commands below run from `src-tauri`; Node/Vite commands run from the repository root. No application windows were opened. Remote model results and rollout gates are recorded separately in [memory evaluation](memory-evaluation.md).

| Area | Verification and result |
| --- | --- |
| Native facts | `cargo test --lib memory_facts` — 19 passed: scope, CAS, payload receipts, suppression, proposal invalidation, independent undo and atomic merge undo |
| Sources and adoption | Four source-delivery cases plus three adoption cases passed, including accepted-request turn/step history and immutable revisions; these groups overlap earlier delivery runs |
| Project history | `cargo test --lib project_history` — 8 passed, including pagination/budget boundaries, source isolation and validity-only changes |
| Background maintenance | `cargo test --lib memory_maintenance::tests` — 11 passed; the real Provider organization/rollback test also passed after two recorded protocol failures |
| Existing Overview maintenance | `cargo test --lib overview_maintenance` — 26 passed after retiring the old memory candidate publication path |
| Native/Node bridge | `cargo test --lib memory_real_sqlite_node_provider_mutations_behavior_and_scope` — passed against real SQLite, Node and a deterministic local Provider, before the final native failure-termination change; that last change has the separate 14-case Node evidence below |
| DSH memory runtime | `node --test packages/dsh-assistant/test/memory-service.test.mjs packages/dsh-assistant/test/memory.runtime.integration.mjs` — 14 passed, including non-CAS failure termination, next-user recovery, CAS reread and actual source-message lookup |
| Original message boundaries | `node --test packages/dsh-assistant/test/memory-evidence.test.mjs` — 4 passed: original text, Unicode pagination, removed sources and actual ownership |
| GUI | Management 11, behavior editor 3, schedule editor 3, API 1, per-answer adoption 2, chat parents 30 and launcher 5 passed; isolated UI changes reran only the affected group |
| Build and packaging | TypeScript, Vite, DSH syntax, UI standards and bundle boundaries passed. The management dialog loads on demand; the main script is 249 KiB against a 250 KiB budget. Runtime staging's 17 cases passed across the full run and its one corrected fixture rerun. Adapter dependency closure: 39 entries / 1046 modules |

`check:portable-paths` still reports pre-existing absolute paths in unrelated repository documentation/vendor material; no memory change adds one. Vite reports existing third-party `eval` and ineffective dynamic import warnings. Neither warning was hidden or treated as new memory validation. Changed files were checked for accidental inclusion of the evaluation credential, with zero matches.

Standards/Spec self-checks resolved source visibility through shared conclusions, rollback misuse of manual receipts, incomplete organization JSON instructions, per-answer adoption, failure-triggered repair loops, source-read authorization and eager management UI loading. The experimental layered strategy remains gated; these local checks do not establish its semantic quality or cost target, nor complete the separate joint Overview/Workspace publication work.

## Native write failure closure

A non-recoverable native `memory_apply` / `memory_organize` mutation failure pauses all subsequent tool work for that agent and the current real human request. This deliberately also stops unrelated tool work in that request, preventing retry loops and shell, filesystem, PTC, or subagent repair attempts. After the real tool result is committed, `agent/pre-step` throws an explicit host notice containing the native error and asking for a new user message before retry. The SDK records this as `turn/end` with `reason.kind=error`; its official `turn-error` chat node displays the notice. No further Provider request, fabricated assistant message, or success receipt is generated. The archived tool failure and terminal notice remain available after reloading the conversation. Read/context errors alone do not enter this state.

The integration uses the SDK's agent-scoped `tools.restrict`, monotonic `tools.guard`, and `system-prompt/assemble` waterfall. The guard denies remaining same-batch dispatches even for scoped tools and reserved PTC transport. Admission ends the turn before any subsequent model call; `concludeTurn` is intentionally not used because the SDK only permits that marker on successful tool outcomes. Restrictions are released when `agent/inbox/claimed` consumes a different real `source.kind=user` message, before prompt assembly, or when the agent/service is disposed. Synthetic prompts do not release them; other Sessions are unaffected.

The native store's exact `Memory revision conflict` response is recoverable. It does not hide tools: memory mutations are denied until `memory_read` successfully returns current versions. Failed reads do not unblock a retry. Other native write errors, including idempotency conflicts, are not treated as revision CAS conflicts. This classification is an exact service-protocol response, never a keyword classifier over user language.

`memory_read({id,source_id,offset?,limit?})` selects a source only from that fact's current native `sources` projection, then uses the existing Session query SDK to read a message source's actual human message. It returns bounded `original` content marked `historical:true`; saved excerpts are never substituted for unavailable originals. `source_id` requires a fact `id`, offset defaults to 0, and limit defaults to 4000 (maximum 12000 characters). The source's real Session catalog and persisted header must match the current context. File/Record originals continue through their native source-reference reader.
