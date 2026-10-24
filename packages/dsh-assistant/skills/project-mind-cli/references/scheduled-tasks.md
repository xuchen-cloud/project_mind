# Scheduled Tasks

A Scheduled Task sends instructions into its original Workspace conversation at its scheduled time, and AI executes them with the Workspace model and permissions. It differs from a Todo: a Todo tracks an action; a Scheduled Task automatically starts work.

## Use the current Workspace Session

Use the supplied native Workspace/connection binding. `PROJECT_MIND_SESSION_ID` is supplied by the native shell adapter for the actual conversation; use it as `sessionId`, without guessing or selecting a similarly titled conversation. Creation from a Project conversation is denied: ask the user to use a Workspace conversation. Standalone CLI callers may select an existing Workspace Session from `mind session list --workspace-scope`; do not use Project Session IDs.

Require `schedule.read` for listing and `schedule.manage` for mutations. Read-only execution cannot create, edit, pause or delete tasks. External connections must explicitly grant task management for the whole Workspace; ordinary content write access is insufficient.

```sh
mind schedule --help
mind schema schedule.create --json
mind schedule list --workspace "$WORKSPACE" --connection "$CONNECTION" --json
```

When the user asks in natural language to schedule work, resolve the name, instruction, local first date/time and repetition, then create it through the CLI. Ask only for information that materially affects the requested schedule. Do not just promise to remember or create a Todo. The Host supplies the system's local IANA time zone; do not invent a `timeZone` field.

## Inputs and recurrence

Create takes `{ "requestId": "stable-id", "input": { "title": "...", "prompt": "...", "sessionId": "...", "enabled": true, "rule": { ... } } }`.

All rules require `startDate` (`YYYY-MM-DD`) and `time` (`HH:mm`). Choose exactly the fields for the selected rule:

| kind | Additional fields | Meaning |
| --- | --- | --- |
| `hours` | `interval`: positive integer | Every N hours from the first date/time, using fixed elapsed time. |
| `days` | `interval`: positive integer | Every N local calendar days at the chosen time. |
| `weekdays` | none | Monday through Friday at the chosen time; public holidays are included. |
| `weeks` | `interval`: positive integer; `weekdays`: ISO weekday array (Monday=1, Sunday=7) | Selected weekdays every N weeks, anchored to the week containing startDate. |
| `monthly` | `dayOfMonth`: 1–31 | That date each month; months without the date are skipped. |

Calendar rules skip missing daylight-saving times and use only the earlier instant for repeated times. An hourly rule preserves its fixed duration across daylight-saving changes.

Example JSON for weekdays at 09:00 (replace the date, request ID and Session with actual values):

```json
{
  "requestId": "weekly-summary-unique-request",
  "input": {
    "title": "项目日报",
    "prompt": "查看本工作区各项目的最新记录与待办，汇总今天需要关注的事项。",
    "sessionId": "ACTUAL_PROJECT_MIND_SESSION_ID",
    "enabled": true,
    "rule": { "kind": "weekdays", "startDate": "2026-10-26", "time": "09:00" }
  }
}
```

Send JSON with `--input-file -` on stdin and the supplied Workspace/connection flags; omit shorthand `--workspace-scope`/`--project` when using JSON input. Retain the same requestId and exact payload if an outcome is uncertain: replay is idempotent, and reusing the ID for a different payload is rejected.

## Manage and verify

Use `schedule.list` to obtain actual task IDs and current fields. Update takes `{ "requestId": "...", "input": { "id": "...", "task": { ...complete task input... } } }`. Preserve the original `sessionId`. Set `enabled:false` to pause and `enabled:true` to resume; do not delete/recreate for an edit.

Delete takes `{ "requestId": "...", "input": { "id": "..." } }` and stops future triggers while retaining existing conversation messages. `mind schema schedule.update --json` and `mind schema schedule.delete --json` expose the precise DTOs.

Verify success by reading `schedule.list` and report the saved title, local time zone and next occurrence. Scheduled Tasks have persistent request replay rather than a native Record/Todo Operation Receipt. Never claim creation from an unsaved draft or tool intent.

The application must be running with that Workspace open and unlocked. On recovery only the latest missed occurrence is caught up. The feature does not run in the cloud or while the computer is off. Errors appear in task management; receipt of a scheduled message does not prove AI completed the work.
