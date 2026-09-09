# Session harness formats and OpenFox import

This document is the local reference for importing conversation sessions from Codex, Claude Code, Grok, and OpenCode into OpenFox. Formats may evolve; inspect representative records before converting a previously unseen version.

## Import principles

- Create one OpenFox session per source session unless the user explicitly requests a merge.
- Preserve visible user/assistant text, chronological order, source timestamps, source session ID, source harness, original working directory, and model when available.
- Stream large JSONL files instead of loading them fully into memory.
- Exclude system/developer instructions, encrypted reasoning, hidden thinking, tool calls, and tool outputs unless the user explicitly requests them.
- Never copy authentication stores such as `auth.json`, credentials, cookies, API keys, bearer tokens, private keys, or environment secrets.
- Scan converted text for high-confidence secrets before import and replace matches with explicit redaction markers.
- Do not reconstruct a missing source session from cross-session quotations unless the user explicitly approves a clearly labelled partial reconstruction.
- Use OpenFox's import API rather than writing directly to its SQLite database.
- Keep each HTTP request below the server JSON body limit, currently 75 MiB.
- Do not copy a foreign harness's system prompt into `cachedLayout`; omit `cachedLayout` for converted external sessions.

## OpenFox

### Native persistence

OpenFox uses SQLite. The active database location depends on the installation; determine it from the running instance instead of assuming a path. Relevant tables are:

- `sessions`: session identity, project, workdir, title, provider/model, mode, phase, timestamps, activity and cached prompt metadata.
- `events`: append-only event stream with `session_id`, positive `seq`, millisecond `timestamp`, `event_type`, and JSON `payload`.
- `projects`: target project identity and workdir.

Session state is event-sourced. Direct inserts are unsupported for imports.

### Native export envelope

The accepted export format is `openfox-session` version `1`:

```json
{
  "format": "openfox-session",
  "version": 1,
  "exportedAt": 1788883200000,
  "source": {
    "openfoxVersion": "1.2.3",
    "projectName": "source-project",
    "workdir": "/source/workdir",
    "mode": "planner",
    "providerId": null,
    "providerModel": null,
    "effectiveModel": "source-model"
  },
  "session": {
    "title": "Imported session",
    "providerId": null,
    "providerModel": null,
    "mode": "planner",
    "phase": "plan",
    "createdAt": "2026-09-08T00:00:00.000Z",
    "updatedAt": "2026-09-08T01:00:00.000Z",
    "criteria": [],
    "todos": [],
    "metadataEntries": {}
  },
  "messages": [],
  "events": [
    {
      "seq": 1,
      "timestamp": 1788883200000,
      "sessionId": "source-session-id",
      "type": "session.initialized",
      "data": {
        "projectId": "source-project-id",
        "workdir": "/source/workdir",
        "contextWindowId": "stable-window-id",
        "title": "Imported session"
      }
    }
  ]
}
```

Required source fields are `openfoxVersion`, `projectName`, `workdir`, `mode`, nullable `providerId`, nullable `providerModel`, and `effectiveModel`. Optional source fields are `providerBackend` and `providerUrl`.

The event list must contain `session.initialized`. Event records use:

```text
{ seq: positive integer, timestamp: milliseconds, sessionId: string, type: string, data: any }
```

For compact external conversions, add a `turn.snapshot` event whose `data.messages` contains normalized messages:

```json
{
  "id": "stable-unique-message-id",
  "role": "user",
  "content": "Visible message text",
  "timestamp": 1788883200000,
  "isStreaming": false,
  "tokenCount": 0,
  "contextWindowId": "stable-window-id"
}
```

Assistant messages use `role: "assistant"`. The snapshot should also carry `mode`, `phase`, `isRunning`, `criteria`, `todos`, `metadataEntries`, `contextState`, `currentContextWindowId`, `readFiles`, `sessionInit`, and `pendingConfirmations`.

### Native import API

```http
POST /api/sessions/import
Content-Type: application/json

{
  "projectId": "target-openfox-project-id",
  "payload": { "...": "openfox-session envelope" }
}
```

OpenFox validates the envelope, creates a new target session, preserves event sequence/timestamps, rewrites event `sessionId` to the new session ID, restores state, and appends an import reminder. Confirm the response is HTTP `201`, then verify the new session through `GET /api/sessions`.

Authoritative implementation:

- `src/server/session/export-import.ts`
- `src/server/session/manager.ts`
- `src/server/events/store.ts`
- `src/server/events/types.ts`

## Codex

Typical storage:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl
~/.codex/state_*.sqlite
~/.codex/session_index.jsonl
~/.codex/history.jsonl
```

A rollout is JSONL. Common top-level records:

- `session_meta`: source session ID, timestamp, cwd, originator, CLI version, provider and model metadata.
- `event_msg`: visible events such as `user_message` and `agent_message`, plus task/token events.
- `response_item`: structured `message`, `reasoning`, function/tool call, and function/tool output records.
- `turn_context` and other runtime state records.

For visible conversation import, prefer `event_msg.payload.type == "user_message"` and `"agent_message"`; this avoids duplicating equivalent `response_item` records. If a Codex version lacks those events, fall back to `response_item.payload.type == "message"` with role `user` or `assistant`, extracting `input_text` or `output_text` blocks. Exclude roles `system` and `developer`, reasoning, and tool traffic by default.

Timestamps are normally ISO-8601 strings and must be converted to epoch milliseconds for OpenFox.

## Claude Code

Typical storage:

```text
~/.claude/projects/<encoded-working-directory>/<session-uuid>.jsonl
~/.claude/history.jsonl
```

Each JSONL record has a top-level `type`, commonly `user`, `assistant`, `system`, `attachment`, `file-history-snapshot`, or queue/mode metadata.

Conversation records commonly contain:

```text
{
  type,
  uuid,
  parentUuid,
  isSidechain,
  isMeta,
  timestamp,
  cwd,
  sessionId,
  message: { role, content, model, ... }
}
```

`message.content` may be a string or an array of blocks. Import only visible `text` blocks by default. Exclude `thinking`, signatures, `tool_use`, `tool_result`, meta messages, local command caveats, and sidechains unless explicitly requested. Use the record timestamp and message model when present.

## OpenCode

Typical storage:

```text
~/.local/share/opencode/opencode.db
```

OpenCode uses SQLite. Relevant tables:

- `session`: `id`, `project_id`, `directory`, `title`, version, agent/model metadata, and millisecond `time_created`/`time_updated`.
- `message`: `id`, `session_id`, millisecond timestamps, and JSON `data` containing role and provider/model metadata.
- `part`: `id`, `message_id`, `session_id`, timestamps, and JSON `data`.

Order messages by `message.time_created, message.id`, then parts by `part.time_created, part.id`. Visible text is normally in parts whose JSON has `type: "text"` and a `text` field. Exclude `reasoning`, `tool`, step, snapshot, and patch parts by default.

Read through SQLite in read-only mode and never copy `~/.local/share/opencode/auth.json`.

## Grok CLI

Typical storage:

```text
~/.grok/sessions/<percent-encoded-working-directory>/<session-id>/
```

Common files:

- `chat_history.jsonl`: conversation records such as `system`, `user`, `assistant`, and tool-related entries.
- `summary.json`: session summary and metadata.
- `updates.jsonl`: incremental state updates.
- `plan.json`, `compaction/segment_*.md`, and runtime-specific folders such as `terminal/` and `mcp/`.
- `~/.grok/sessions/session_search.sqlite`: searchable session index with session ID, cwd, title, content, and update time.
- `~/.grok/active_sessions.json`: active process/session references.

In `chat_history.jsonl`, `content` may be a string or an array of typed blocks. Import visible user/assistant text blocks and skip system/tool/runtime data by default. The search index is discovery metadata, not a replacement for a missing `chat_history.jsonl`.

If the indexed session or its directory is absent, report it as unavailable. Do not infer a full conversation from peer messages quoted in another harness without explicit user approval.

## Conversion verification checklist

1. Confirm the source session ID and source file/database before conversion.
2. Record the target OpenFox project ID.
3. Count extracted user and assistant messages and reject an empty conversion.
4. Confirm message timestamps are epoch milliseconds and monotonic after sorting.
5. Scan for secrets and report the number of redactions without exposing matched values.
6. Validate the payload as `openfox-session` version 1 and ensure `session.initialized` exists.
7. Check the serialized request is below 75 MiB; split only by source-session boundaries unless the user approves otherwise.
8. Import with `POST /api/sessions/import`, never direct SQLite writes.
9. Verify title, project, workdir, inactive state, and non-empty message count using the API.
10. Confirm source stores and the target project repository were not modified unless explicitly requested.
