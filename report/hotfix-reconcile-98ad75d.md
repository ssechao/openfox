# Hotfix reconcile UI — 98ad75d

Base `98ad75d12ba9688641e33de7a511761a9fec4ee6`. No MEP.

## RED

`src/server/session/worker/reconcile-red.test.ts` is in `npm test` (no exclude).

Vitest 4.1.10, 2026-11-08 15:22Z, direct run: 5 passed, exit 0.

`head-98ad75d/` holds the `git show HEAD:` bytes of crash.ts, auto-continue.ts, execute-tools.ts, fold-messages.ts, and apply-events.ts. SHA-256: crash `b23f6776…`, auto-continue `41846a73…`, execute-tools `4e9392f5…`, fold-messages `6d7418c1…`, apply-events `e2a1ac9b…`. The remote tree has no `.git`, so the runner loads these files and executes them. They produce:

- R-1: `findPendingToolReconciliations` plus `prepareSessionInterruptionEvents` leave `call-1` pending. `runBootAutoContinuations` returns 0. The branch settles the call and returns 1.
- R-2: HEAD boot returns 0 while `tool.reconciliation_required` is set. HEAD `executeTools` sets `reconciliationRequired` and does not execute `run_command`. The branch resumes and executes it.
- R-3: HEAD fold keeps 2 tool messages. HEAD `attachToolResultToMessage` replaces the terminal result with `{success:true, output:late}`. The branch keeps one message and `{success:false, outcomeUnknown:true}`.

## Gate

`pipefail` `--all` at 16:28Z exited 0. Unit 543 files, 6814 passed, 31 skipped. E2E 58 files, 375 passed, 49 skipped. `git diff 98ad75d` at that run is `c29a1fbb4f2fbe4f73ea475ffc16340992efb22204821f9f4deaffe495f888c3` (30 files, +638/-366). The same worktree also contained the untracked settle, reconcile-red, and head-98ad75d files. No architecture change after that gate.

## Revue Aether

Peer `Astra revue OpenFox preflight drain 98ad75d1` was interrupted (`interrupted_at=2026-11-07T23:21:41.533Z`), so production returned 409 and earlier injections were `Failed`. `POST /resume-interruption` cleared that marker. Message #1794148658998 landed. Astra replied: reprise bloquée on tool `exec-ea6ddce0-4c86-4f2b-99b3-af53c17092b8`; the previous GO covers only `eea07de3..98ad75d1`, not the uncommitted diff; it needs the worktree and the exact diff. That is not a GO. Follow-up #1794148752766 was received. Astra read the worktree, `AGENTS.md`, `report/`, `.git/HEAD` (`fix/hotfix-reconcile-ui`), and `report/hotfix-reconcile-98ad75d.md`. `git status` was then blocked: production still refuses an effectful tool while a reconciliation is pending, and the turn ended with `Tool reconciliation is required`. Those pending items were resolved (`pendingToolReconciliations` empty). Astra wrote `VERDICT: NO-GO` while saving `reconcile-ui-98ad75d-review-astra.md`. Four blockers: a forced Stop still queued a chat plan; resume ignored `orphanCheck.clean === false`; `processEventsForConversation` settled a live tool call; a late `chat.tool_result` replaced the first result in the live UI. Those four are now changed: Stop clears the marker and does not queue; resume waits for `clean: true`; context assembly no longer settles open calls; the client keeps the first tool result. An inherited process group, including container init group 1, is not an exclusive orphan. Only a group led by the tracked process blocks resume. Astra then named two leftovers on the later tree: one MCP timeout settled every open call, and boot resumed an interruption whose orphan proof was not clean. A timeout now settles only that call. A failed proof writes `worker.recovery_blocked`, and boot leaves that interruption stopped. Boot resumes only after `worker.recovery_clean` for that `interrupted_at` is persisted. A user Stop does not queue a new turn. One interrupted call gets one `outcomeUnknown` result and is not retried. No resume button. Preparation GO only: commit this tree, no MEP.
