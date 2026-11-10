# File working content implementation notes

This native slice implements the GUI working-content / immutable-history split for the save-session work package. It retains the existing File identity, real live path, Project/File leases, Workspace commit fence, operation receipt store and source change log. It does not change existing File Version IDs, numbers, hashes or retained bytes.

## Native contract

All commands use the standard `{binding, requestId, data}` GUI envelope with camelCase DTOs and unknown-field rejection.

- `file_working_open`: `{object}` → current `revision`, `contentHash`, `archivedVersionNumber`, archive status, fixed `sessionId`, `name`, `base64`, nullable `format` and `model`. Markdown receives bytes in `base64`; Office returns its editor model and leaves duplicate `base64` empty. The immutable editing base stays native.
- `file_working_save_text`: `{object,sessionId,expectedRevision,expectedContentHash,text}` → working status.
- `file_working_save_office`: `{object,sessionId,expectedRevision,expectedContentHash,edits}` → working status. `edits` always describe the cumulative changes against that session's fixed base; successful saves neither replace the base nor return another interaction model.
- `file_working_recalculate`: `{object,sessionId,recalculation}` → existing recalculation result, evaluated against the fixed editing base.
- `file_working_activity`: `{object,sessionId}` → status with updated native activity time. It authorizes session metadata and updates the deadline without loading base bytes or hashing the live File.
- `file_working_close`: `{object,sessionId}` → null; releases the editing base without archiving.
- `file_working_tick` / `file_working_archive`: `{object}` → status; the former honors the 15-minute deadline, the latter explicitly hands current content to an independent operation.
- `file_working_recovery_read`: `{object}` → `{object,revision,contentHash,name,base64}` for the single latest successful working save. It never overwrites an external change.

Working status is `{object,revision,contentHash,archivedVersionNumber,pendingArchive,lastActivityAtMs,archiveDueAtMs,noChange}`. Revision CAS and hash CAS are both required. Save receipts are atomic with current-content metadata and the durable outbox. Exact retries replay before accessing an editing session or invoking an Office worker, including after session close. Different payloads for the same request remain conflicts.

The existing remote-image input additionally accepts top-level `workingSessionId`; this authorizes the DOCX session instead of treating its editing model as a newly archived source. The previous fixed-history input remains supported.

## Persistence and recovery

Schema 40 adds current working state and a single latest-content recovery BLOB keyed by existing `documents.id`, plus bounded fixed editing sessions. Session bases are removed on close or when opening a new Workspace generation; at most 16 are open. Legacy managed-copy heads are frozen with identical bytes before their first working edit, retaining their existing version identity and original live location.

Working saves replace the real File through an owned new/old journal, using the existing native filesystem primitives and Project → File → SQLite lock order. FULL-or-stronger SQLite synchronization protects the durable intent and state/receipt transition; owned files and directories are synchronized as in the native File pipeline. The pre-commit backup is removed after recovery and is never a hidden File Version. The current recovery BLOB is overwritten rather than appended. Startup rolls back incomplete replacements or cleans committed replacements according to the atomic state transition; foreign live bytes are retained and reported as conflicts.

The native scheduler runs every five seconds while a Workspace is open. It checks persisted per-File activity deadlines, so closing a Tab or restarting the app does not force a version and overdue work produces at most one archive. Archive and new activity/save operations serialize on the same File lease. Archive errors include `{binding,error}`, are deduplicated until success and remain visible; worker panics are reported too.

Directory refresh and registration recognize known working writes rather than treating each own write as an external version. Fixed-history reads continue to use immutable version bytes. External changes are rejected at open, save and archive boundaries, and the latest working recovery bytes remain available separately.

## AI handoff

An explicit current-File `SourceService.read_file_verified` request checkpoints pending GUI content before obtaining a fixed source. It uses the original caller's actual `source.read` ownership, policy and connection grant, including a read-only Agent connection. Background indexing, inventory and normal listing do not checkpoint. Explicit old File Version reads retain their original bytes. AI writes and history restore with an old CAS remain rejected until the caller reacquires the new fixed source; successful older receipts replay before the pending-work check. GUI reference actions can use `file_working_archive` at their explicit handoff boundary.

## Validation evidence

No Tauri application or window was started. Targeted verification is recorded in the implementation-agent handoff; temporary raw logs use the `mind-working-*` and `mind-rust-*` prefixes in the session's temporary directory. Tests cover repeated saves without versions, immutable bases/history, exact replay and stale CAS, no-op, native ownership/generation, external changes and recovery bytes, close/restart/deadline catch-up, new activity, managed-copy migration, schema 39 upgrade, read-only Agent source handoff and actual SIGKILL at all four working-replacement phases. A separate opt-in test uses the packaged real DOCX/XLSX/PPTX workers through working open, two saves, independent reopen, one archive and fixed historical reads.

## Native safety contract (G03 / #306)

Host-backed working operations acquire leases before lifecycle admission:
recovery scan → Project/owner lease → File lease → Workspace commit fence →
SQLite transaction. Recovery scans enter admission separately for each File;
import/metadata/delete/relocate/version scanners also admit after their leases;
no caller may retain a fence permit while waiting for leases or starting a
workspace-wide recovery scan. The independent Host connection carries its
Workspace fence, so session creation, activity, close, journal recovery, save
and archive all check admission at their own mutation boundary. An invalidated
Workspace rejects operations waiting for a File lease before they mutate it.
Source checkpoints on the selected Host remain serialized by its existing
selection/database boundary.

File creation withdrawal/restoration use the same lease-before-admission boundary.
Creation batches scan recovery once before acquiring any lease, take distinct
owner leases before sorted File leases, guard retained journals per target, and
admit once before their atomic transaction. A replan cannot mutate a File for
which the batch did not acquire a lease.
An owner root cannot be renamed or removed while one of its Files retains a
working journal; this check runs under the exclusive owner lease.

An external conflict in a working replacement is local to that File. Startup
and global scans preserve its journal, owned artifacts and recovery BLOB and
continue to unrelated Files. Target open/save/archive still return a conflict;
`file_working_recovery_read` remains the non-destructive way to retrieve the
latest successful content. Invalid journal structure, ownership, database and
I/O failures remain errors. A committed state/receipt is authoritative even if
an external editor changes the live path before cleanup; cleanup only removes
artifacts whose owned path, identity and hash match the journal.

After directory registration accepts a same-content physical replacement,
a non-pending, journal-free working state adopts that verified identity,
advances its revision and expires previous editing sessions. This creates no
File Version. Pending content and unregistered/different-content replacements
continue to fail identity/hash CAS.

The focused native safety tests use actual filesystem leases, production
runtime connections and persisted journal fault fixtures on macOS. Windows
acceptance remains in #192: run these cases on Windows with the application
build/OS and results recorded, including file sharing and process interruption.
