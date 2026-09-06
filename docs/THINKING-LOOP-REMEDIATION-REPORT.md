# Thinking Loop Remediation Report

## Scope and delivery

- Worktree: `/Users/sechaosouchiam/Source/github.com/OpenFoxFork-recovery`.
- Branch: `feat/fork-port-2.0.137-recovery`.
- Base: `fa2199a4ea865bb2eda2dcc90f36c3064ad6fab0` (fork on upstream 2.0.137).
- Final tranche starts at `e725913601fa97d164916d86ea2a739ab082750a`.
- Shell follow-up: `141e004b3705f108669bc1cc2aea35436a585ed2`.
- Server persistence/recovery: `4091162d2d2e166ade4438d60d6d0213c825cf4e`.
- The accompanying UI commit contains the nested-history changes and this report.
- No push, merge, deployment, service restart, production database access or user configuration change. Only the synthetic crash-test child process was killed. No changes were made to the peer worktree.

## Findings and executable evidence

| Finding | Defect and correction                                                                                                                                                                                                                                                                              | RED / GREEN evidence                                                                                                                                                                                                                                                                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A       | Regex-based background detection treated heredoc data as shell operators. The state machine now recognizes delimiter words, quoting, escapes, comments and substitutions; ambiguous supported-boundary cases fail closed.                                                                          | Original heredoc cases failed. Follow-up tests also exposed escaped/spaced delimiters and hidden background substitutions. `shell.test.ts` now accepts Rust references as data and rejects real background operators before/after heredocs and inside executable substitutions.                                                                                                   |
| B       | A final line without a newline was discarded; malformed stream JSON was silently skipped. Flush the decoder/tail and raise explicit parsing errors instead.                                                                                                                                        | Two HTTP-stream fixture failures reproduced before the initial correction. Large arguments remain identical and dispatch once. The final tranche additionally proves malformed-call recovery stops after three consecutive malformed responses, without executing those invalid calls.                                                                                            |
| C       | Exceptional exits omitted `message.done`; callbacks could stop cleanup before other messages closed; EOF could be mistaken for success outside Responses. Persist closures before notification, reject missing terminal events, persist definitive failures and stop producers on callback errors. | Tests reproduced absent closures, a false-success EOF, one of two messages left open by a throwing callback, an un-aborted producer, and a swallowed persistence error. These paths now pass.                                                                                                                                                                                     |
| D       | Thinking Markdown did not receive `isStreaming`, retaining intermediate prefixes in the immutable cache.                                                                                                                                                                                           | 200 prefixes filled the 100-entry cache before correction; streaming now leaves zero entries and completion creates one reusable entry.                                                                                                                                                                                                                                           |
| E       | A no-op pane updater cloned state and notified Zustand subscribers for buffered, unpublished deltas. Preserve state identity.                                                                                                                                                                      | 50 raw deltas produced 50 notifications before correction; now zero before flush and one after flush. Ordering and forced terminal publication are tested.                                                                                                                                                                                                                        |
| F       | Polling and uncoalesced scroll callbacks, repeated ANSI parsing and repeated history scans amplified work. Nested groups mounted their entire history.                                                                                                                                             | Grouping: 20,200 visits became 200 for 200 messages. Idle scroll writes: three became zero over the controlled idle interval. Twenty mutation callbacks produce one follow write in the deterministic scheduler test. A timer rerender of 100 chunks causes zero ANSI reparses; one appended chunk causes one parse. Nested history mounts 30 rather than 400 messages initially. |
| G       | This lineage has no `message.checkpoint`; every raw delta went through a synchronous `EventStore.append`. Restart reset running state but left assistant messages streaming.                                                                                                                       | 4,000 thinking deltas caused 4,000 SQLite INSERTs before coalescing; four controlled flush windows now produce four INSERTs with identical content. A real child process is killed after a durable flush and its database reopened: partial thinking survives, streaming/running flags close, and recovery is idempotent and resumable.                                           |

The reproduced parsing defects are proven defects in the relevant path, not proof that either caused the exact original incident at JSON position 15,059. The original raw provider bytes were not available for comparison.

## Persistence design

`coalesce-stream.ts` sits before the agent loop's EventStore append path. It merges adjacent compatible text/thinking/tool-output events and replaces adjacent cumulative tool-preparing snapshots. It flushes on a 50 ms deadline, a 64 Ki-character content bound, target/type changes, completion or producer error.

This deliberately preserves the existing append-only schema rather than introducing a mutable checkpoint protocol absent from this branch. Live subscriptions and fetched replay consume the same persisted event shapes. There is at most one buffered event per coalesced stream, no new checkpoint rows, and no full-session snapshot per token. Alternating event types or targets force earlier flushes to preserve ordering: the four-write measurement is for four controlled homogeneous batches, not an unconditional bound for every possible event sequence.

A crash can lose an unpublished pending fragment; it cannot recover bytes never flushed to disk. The nominal pending window is 50 ms, subject to event-loop scheduling. A durable terminal event is emitted on normal shutdown; startup recovery atomically appends partial closures, an appropriate recoverable error and `running.changed=false` for interrupted sessions. No database schema migration was added.

## Final tranche files

- `src/server/tools/shell.ts`, `shell.test.ts`: delimiter boundaries and executable substitutions.
- `src/server/chat/coalesce-stream.ts`, `coalesce-stream.test.ts`: buffering, real SQLite statement counters, ordering, tail flush, producer errors and child-process crash test.
- `src/server/chat/agent-loop.ts`: production coalescer integration, bounded malformed-tool recovery, durable final errors and per-attempt abort on callback failure.
- `src/server/chat/stream-pure.ts`: close the underlying producer when leaving the stream.
- `src/server/chat/orchestrator.ts`, `orchestrator.test.ts`: propagate persistence failures unless the session was deleted; backend/disconnect/timeout/abort and replay/client closure tests.
- `src/server/chat/terminal-cleanup.ts`, `terminal-cleanup.test.ts`: persist all closures before client callbacks; repeated cleanup does not duplicate them.
- `src/server/events/store.ts`, `store.test.ts`: close interrupted messages at startup and verify idempotence and resume.
- `src/server/llm/client.ts`, `stream-integrity.test.ts`: terminal EOF guard for all adapted protocols; explicit truncated-argument and interrupted-thinking cases.
- `src/server/chat/agent-loop-retry.history.test.ts`: real HTTP/parser/agent-loop/SQLite/tool recovery fixture and callback producer cleanup.
- `src/server/session/manager.execution-context.test.ts`: replace a non-generator stream mock with a generator matching the production contract.
- `src/server/workflows/executor-retry.test.ts`: verify persisted and client-delivered closure of an interrupted workflow step.
- `web/src/components/plan/SubAgentContainer.tsx` and its two test files: recent-message window, on-demand older history and preservation of explicitly revealed content.
- `web/src/hooks/useAutoScroll.test.ts`: explicit observer/frame scheduler for deterministic layout-write assertions.
- `web/src/stores/session/streamingBuffer.test.ts`: combined long-history Zustand and Markdown accounting.

## Regression fixtures

The server fixture seeds 674 history messages, receives 68,000 thinking characters over 4,000 HTTP deltas, reconstructs a tool argument larger than 15 KiB, persists one controlled tool failure, feeds that result into a model recovery request, executes a real heredoc command successfully and resumes in a later turn. Invalid JSON and abrupt EOF variants assert non-execution where appropriate, persisted error, bounded recovery and closed messages.

The frontend fixture runs 4,000 thinking deltas against a real Zustand store with 674 messages: four scheduled flushes produce four publications in order, streaming Markdown adds no immutable entries, and terminal rendering adds one entry. Session and message terminal flags are checked.

These are complementary executable fixtures, not one browser-driven production session. The server harness uses scripted HTTP responses, a mocked session manager and one controlled tool error; the actual parser, stream pipeline, agent loop, SQLite and successful shell tool run normally. The frontend harness injects protocol messages directly. The crash test uses its own temporary on-disk database and process.

## Validation and deviations

- `npm run typecheck`, `npm run lint` and `npm run check` passed. The latter includes formatting and duplicate detection; both duplicate scans reported zero clones.
- The complete `VITEST_MAX_WORKERS=2 npm run test` passed: **390 unit files, 5,203 passed / 32 skipped (5,242 reported total); 45 E2E files, 336 passed / 49 skipped (385 reported total)**. Vitest also reports two skipped unit files and three skipped E2E files.
- The unit half of that command is identical to `npm run test:unit`. Separate unit runs exposed the test changes listed below and intermittent failures before the final full-suite success.
- The shell and server commits passed their full hooks with two workers; hooks were not disabled or changed. Reducing worker count changes scheduling only, not test selection or assertions.
- One complete run was stopped by the tool's 120-second timeout after the unit suite had passed. It was rerun with a 600-second tool timeout and completed both phases successfully.
- `ws/server.test.ts` produced an intermittent WebSocket 404; its isolated file passed 24 tests with one skipped. `path-security` and `git-status-watcher` failed under full load and their isolated files passed 15/15. No test in those files was altered in this tranche. The known `session-rest` cancellation failure did not appear in the final run.
- The existing workspace test returned a plain object from its mocked generator; coalescing exposed this invalid mock. It now implements the actual generator contract.
- The existing sub-agent performance test required mounting all 311 messages. It was changed deliberately: initial mounts are bounded, and explicit reveal still reaches all 311.
- The earlier auto-scroll growth test remained timing-sensitive even after using `waitFor`. The final counter tests drive observer callbacks and animation frames explicitly; they count writes, not elapsed rendering time. A scroll write is not itself a measurement of a browser's actual reflow cost.
- A temporary stash parked other intended files during each selective commit because the repository hook runs `git add -u`. The parked changes were restored; no hook or index workaround bypassed validation.

## Limits

- The shell recognizer is bounded, not a complete shell grammar. ANSI-C/localized heredoc delimiters and ambiguous command substitutions are conservatively rejected rather than guessed. It is not a general shell security sandbox.
- The nested history window bounds initial/following mounts; explicitly revealed history remains mounted so reading older content is not interrupted. This is not a constant-memory cap on history a user explicitly opens.
- Browser layout, real provider behavior and deployment were not measured in this tranche. The controlled HTTP, store, component and process-crash fixtures establish the stated guarantees; they do not substitute for production load or browser profiling.
- Generic provider/network failures retain the existing retry policy. The new three-attempt limit specifically addresses consecutive malformed tool arguments, not every possible legitimate tool-use sequence.
- Startup recovery has to inspect persisted session histories. Very large-database startup cost was not benchmarked against a user database.

## Plan disposition

- [x] A: heredoc false positives and tested boundary/substitution failures corrected.
- [x] B: valid large arguments and invalid/EOF cases exercised without silent JSON repair.
- [x] C: terminal cleanup, persisted errors and producer cancellation strengthened and tested.
- [x] D: streaming thinking excluded from immutable Markdown cache.
- [x] E: no-op raw deltas preserve Zustand identity; final publication proven.
- [x] F: grouping, parsing, layout scheduling and nested initial mounting bounded by the tested contracts.
- [x] G: persistence measured, coalesced without schema changes, crash recovery exercised.
- [x] Long-session success, controlled failure, malformed response and resume fixtures pass.
- [x] Typecheck, lint, formatting, duplicate checks and full tests pass.
- [x] Evidence, changed tests and remaining validation limits recorded here.
