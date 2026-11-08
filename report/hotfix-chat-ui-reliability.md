# Hotfix chat UI reliability

Base: `98ad75d12ba9688641e33de7a511761a9fec4ee6` on `fix/hotfix-chat-ui-reliability`. No production deploy.

Hotfix commit: `bb60a9a8815eaaaa82abf2028a4bc1649fc3628c`. Its pre-commit hook on `.122` (`/tmp/openfox-hotfix-chat-ui-3`, `node:24-bookworm`) exited 0: check passed, unit 6818 passed / 31 skipped, e2e 375 passed / 49 skipped.

## Send refusal

`sendMessage` returns `{ ok: true }` only after HTTP 2xx. HTTP 409 and 429 set a pane error that says what to do (resume, wait for stop, or wait for the queue) and that the draft and attachments were kept. A send that resumes a running workflow waits for the `runner.launch` ack; a refusal or a disconnected socket keeps the draft and shows the same kind of error. The composer clears only the text and attachments that were posted, keeps anything typed while the request was in flight, and ignores a second click until that request settles. A slash command, including a slash workflow, stays locked until its launch is accepted. A refused launch keeps the draft and shows the error only beside the composer, not again as a transcript banner.

Background-exit cards decode `&amp;`, `&lt;`, and `&gt;` for display, including when the process name contains a quote or a newline. The stored notice stays escaped for the model.

## Background exit

Exit notices are stored as `messageKind: "background-exit"` (queue start, mid-turn drain, and workflow resume). Older notices still stored as `auto-prompt` with the process-output frame render the same inline card. The card stays visible when agent definitions are hidden, in English and French, from a live `chat.message` and from a reloaded `session.state`.

## Verification on .122

Host `ssechao@192.168.71.122`, image `node:24-bookworm`.

Post-review tree, directory `/tmp/openfox-hotfix-chat-ui-3`, commit `bb60a9a8815eaaaa82abf2028a4bc1649fc3628c`: `scripts/test-remote.sh --all` exit 0 (check, unit 6818 passed / 31 skipped, e2e 375 passed / 49 skipped).

Earlier pre-review tree, directory `/tmp/openfox-hotfix-chat-ui-2`:

Isolated smoke: `send-message-refusal`, `ChatFeedItems.background-exit`, `ChatInput.send`, `drain-queue`, `processor` — 37 passed, exit 0.

`OPENFOX_TEST_REMOTE_DIR=/tmp/openfox-hotfix-chat-ui-2 scripts/test-remote.sh --all` exit 0:

- `npm run check`: typecheck, lint, format, duplicate detection passed.
- Unit: 6810 passed, 31 skipped (544 files).
- E2E: 375 passed, 49 skipped (58 files, 3 skipped).

Earlier runs on a shared tree exited 1 because vitest workers aborted in `better-sqlite3` `Statement::~Statement`. A clean tree did not.

Aether: report sent with `ht_send_to_peer` to the peer title `Openfox Hotfix Preflight MEP`. This session title is `Hotfix — Chat UI fiable`. No production deploy.
