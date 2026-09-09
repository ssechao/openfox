# OpenFox Thinking Loop and Streaming Performance Remediation Plan

## Status and ownership

- Status: ready for implementation in a dedicated worktree.
- Scope: OpenFox only.
- Current repository: `/Users/sechaosouchiam/Source/github.com/OpenFoxFork`.
- The implementation must not modify the active worktree used by another session.
- Do not modify `agent-openai-api`, the `.122` services, or the OpenAI/Anthropic protocols.
- Do not merge, push, deploy, or change production configuration without explicit authorization.
- Follow repository `AGENTS.md`, including TDD and the full validation suite.

## Objective

Eliminate the failure mode where an agent repeatedly reasons around failed tool calls, the backend stream stops without a terminal event, and OpenFox leaves the turn displayed as active. At the same time, remove the render, state-update, and persistence amplification that makes long thinking streams disproportionately expensive.

The work must fix root causes. It must not hide the thinking panel, silently swallow errors, disable fail-closed tool checks, or periodically reset the UI.

## Evidence from the observed incident

Observed session:

- Title: `Qwen llm-aether Dev`.
- Session ID: `f4b2ddf5-dbf1-42d1-aaf4-be89b923f156`.
- Approximately 674 messages: 300 loaded and 374 hidden at the time of inspection.
- More than 1.1 million accumulated thinking characters.
- The session remained `isRunning=true` after its last checkpoint stopped progressing.

Observed terminal sequence:

1. An assistant message produced approximately 71,971 thinking characters.
2. A `write_file` call failed with `Failed to parse tool call arguments: Unterminated string in JSON at position 15059`.
3. The model attempted to use a heredoc through `run_command`.
4. The command validator interpreted Rust references such as `&self` and `&mut` inside the heredoc as background-process operators and rejected the command with the instruction to use `background_process`.
5. A third assistant message started streaming thinking, then its checkpoint stopped progressing.
6. OpenFox retained `isRunning=true` and `isStreaming=true` despite the lack of a live producer.

This is not one single bug. It is a chain containing a tool-validation false positive, an unproven tool-argument truncation/parse failure, unbounded recovery behavior, missing terminal cleanup, and expensive rendering/state persistence.

## Worktree and safety procedure

Before implementation:

1. Create or enter a dedicated Git worktree from the agreed base commit.
2. Record the source branch and base commit.
3. Verify the dedicated worktree is clean.
4. Confirm no command will operate on the primary worktree.
5. Inspect repository instructions before changing files.
6. Add failing executable tests before each correction.

Do not kill an existing OpenFox development server. Use the repository-supported development-server mechanism if a test server is required.

## Finding A: false background-process detection

### Problem

The `run_command` validator appears to recognize `&` lexically across the entire command. That incorrectly treats data as shell syntax when an ampersand occurs in:

- a heredoc body;
- a single-quoted or double-quoted string;
- escaped content;
- source code such as Rust `&self` and `&mut`;
- a URL query string.

The validator must still reject a real top-level shell background operator.

### Implementation requirements

- Locate the exact background-command validation path.
- Replace naive substring or regex matching with a bounded parser/state machine aware of:
  - single and double quotes;
  - escapes;
  - comments where applicable;
  - heredoc declarations, quoted delimiters, bodies, and terminators;
  - restoration of normal shell parsing after a heredoc terminator.
- Preserve fail-closed rejection of actual background execution.
- Do not solve this by accepting all ampersands.

### Required RED tests

- A heredoc containing `&self` and `&mut value` is accepted.
- Single-quoted and double-quoted ampersands are accepted.
- An escaped ampersand is accepted.
- A URL query string containing `&` as data is accepted.
- `sleep 10 &` is rejected.
- `command & disown` is rejected.
- Multiple heredocs and quoted delimiters are parsed correctly.
- Shell content after a heredoc terminator is analyzed normally.

## Finding B: large tool-call argument integrity

### Problem

The observed `write_file` tool call reached the tool layer as invalid JSON and was reported as an unterminated string at position 15,059. The source of the corruption has not been proven. It may originate in model output, streaming accumulation, transport, size handling, or parsing.

### Investigation requirements

Trace byte and event boundaries through:

1. backend stream reception;
2. tool-call delta accumulation;
3. finalized tool-call payload;
4. JSON parsing;
5. tool dispatch.

Record where the first divergence occurs. Do not infer the cause from the final parser error.

### Required tests

Create a valid tool-call fixture larger than 15 KiB containing:

- newlines;
- quotes and escaped quotes;
- backslashes;
- Unicode;
- Rust code;
- ampersands;
- content split across many streaming deltas.

The valid path must preserve the arguments byte-for-byte and dispatch the tool exactly once.

Create an invalid/incomplete backend fixture and prove:

- no tool is executed;
- the error is explicit and persisted;
- the runner reaches a terminal state;
- the same failed call is not retried indefinitely by OpenFox;
- the session remains resumable.

Do not silently repair or guess malformed JSON.

## Finding C: stale `isRunning` and `isStreaming`

### Problem

A turn can lose its producer while remaining marked as running and streaming. The UI then presents a frozen message as active thinking.

### Required terminal paths

Centralize and prove cleanup for:

- normal completion;
- backend error;
- invalid tool call;
- stream disconnect;
- unexpected EOF;
- user abort;
- idle or turn timeout;
- callback exception;
- workflow/executor shutdown.

### Required postconditions

After every terminal path:

- session `isRunning` is false;
- active message `isStreaming` is false;
- a terminal error event is persisted when appropriate;
- no turn appears active without a live producer;
- a later resume can proceed normally;
- cleanup is idempotent and cannot emit multiple contradictory terminal states.

### Required tests

Inject every terminal path, including a stream that emits a partial thinking fragment and then ends without a completion message. Assert both persisted state and the state delivered to the web client.

## Finding D: thinking Markdown rendered as immutable content

### Observed path to verify

- `web/src/components/chat/AssistantMessage.tsx` passes `isStreaming` to normal text Markdown.
- `web/src/components/chat/ThinkingBlock.tsx` does not pass the streaming state to its Markdown renderer.
- `web/src/components/shared/Markdown.tsx` therefore preprocesses and caches each growing thinking prefix as if it were final content.

### Implementation requirements

- Propagate the real streaming state through `ThinkingBlock` to `Markdown`.
- Do not cache intermediate prefixes of a growing thinking stream.
- Render and cache the final thinking content normally after completion.
- Preserve the current expanded/collapsed thinking behavior.

### Required tests

- Hundreds of deltas for one thinking message must not create hundreds of immutable Markdown cache entries.
- Completing the message must render the final content and allow one reusable final cache entry.
- Existing non-streaming Markdown behavior must remain unchanged.

## Finding E: unnecessary Zustand work per raw delta

### Paths to inspect

- `web/src/stores/session/messageHandler.ts`
- `web/src/stores/session/store.ts`
- `web/src/stores/session/streamingBuffer.ts`
- `web/src/stores/session/panes.ts`

### Problem

The streaming buffer coalesces visible flushes, but raw deltas may still call Zustand `set()` and clone the panes map even when no committed state has changed.

### Implementation requirements

- Raw deltas may update a private accumulator without publishing Zustand state.
- Publish at most one state update per scheduled flush.
- Do not clone the panes map or full messages array for a delta that has not been flushed.
- Preserve exact delta ordering.
- Force a final flush before completion/error cleanup.

### Required tests

Use deterministic counters, not timing-sensitive benchmarks:

- N raw deltas before one flush produce one observable Zustand commit.
- A terminal event forces the final pending content to be published.
- Subscribers see monotonically ordered content with no missing or duplicated delta.
- No-op updater paths preserve object identity.

## Finding F: repeated grouping and forced layout

### Paths to inspect

- `web/src/components/plan/PlanPanel.tsx`
- `web/src/components/chat/MessageList.tsx`
- the relevant `useAutoScroll.ts`
- `web/src/components` implementation of `RunCommandView`
- `web/src/components` implementation of `SubAgentContainer`
- `web/src/components` implementation of `ChatFeedItems`

### Risks to verify

- `groupMessages(messages, previousItems)` is recomputed for every streaming update.
- more than one auto-scroll mechanism reads and writes layout for the same delta;
- a global `MutationObserver`, animation frame, and periodic timer duplicate scroll work;
- `RunCommandView` repeatedly joins and reparses all output chunks;
- a collapsed sub-agent still mounts all internal messages;
- outer virtualization counts a large nested group as a single cheap row.

### Implementation requirements

- Establish one auto-scroll authority per pane.
- Remove permanent polling for scroll when event-driven scheduling suffices.
- Batch DOM reads before writes and schedule at most once per frame.
- Incrementally process command-output chunks or memoize stable prefixes.
- Do not mount all descendants of a collapsed sub-agent.
- Preserve user-controlled scroll position and the expected stick-to-bottom behavior.
- Preserve streaming/fetched-data rendering parity.

### Required tests

Prefer render, grouping, parsing, and layout-call counters over wall-clock thresholds. Prove bounded work as the number of deltas grows while the number of messages stays fixed.

## Finding G: SQLite checkpoint amplification

### Contract to verify before editing

OpenFox uses event sourcing. During the observed stream, one `message.checkpoint` payload appeared to be updated as content grew. Verify the implementation rather than assuming one row is inserted per token.

### Required behavior

- At most one mutable checkpoint exists per active message.
- Checkpoint persistence is coalesced rather than one synchronous transaction per token.
- A durable terminal `message.done` or error event closes the turn.
- The active checkpoint is removed or marked closed coherently.
- Large snapshots are not duplicated for every streaming delta.
- Crash recovery cannot reconstruct a permanently running phantom turn.

### Required tests

- Stream thousands of deltas and count SQLite writes/transactions.
- Assert the count is bounded by configured flushes, not proportional to token chunks.
- Kill the synthetic stream between checkpoint and completion, reload state, and verify a recoverable non-running terminal representation.
- Prove final fetched state equals the last state streamed to the client.

Do not change the database schema unless executable evidence shows the existing schema cannot meet this contract.

## End-to-end regression fixture

Build a local deterministic fixture that performs:

1. a long session history;
2. a thinking stream of tens of thousands of characters;
3. a tool call larger than 15 KiB;
4. one controlled tool failure;
5. a model recovery turn;
6. a successful tool call;
7. normal final completion.

Add failure variants for malformed tool JSON and abrupt stream termination.

The fixture must prove:

- no infinite recovery loop;
- no stale running or streaming state;
- no tool-call corruption;
- no false background rejection for ampersands in heredoc data;
- bounded Zustand commits;
- bounded Markdown cache growth;
- bounded SQLite checkpoint writes;
- successful session resume;
- no regression in normal tools, sub-agents, streaming, and fetched-state replay.

## Validation sequence

Run targeted tests while developing. Before declaring completion, run all repository-required checks without piping output through `grep`, `tail`, or similar filters:

```bash
npm run test:unit
npm run typecheck
npm run lint
npm run check
npm run test
```

If any command is inapplicable or already included by another command, document that fact with its exact output rather than silently omitting it.

## Completion report

The implementation handoff must contain:

1. the dedicated worktree path, branch, and base commit;
2. the proven root cause of each finding;
3. the RED test that reproduced each defect;
4. the diff summarized by file;
5. targeted and full-suite test results;
6. deterministic performance counters before and after;
7. unresolved limitations or deferred findings;
8. final `git status`;
9. the prepared commit hash, if committing was explicitly requested.

A finding is not closed by a source-string assertion alone. Tests must execute the affected behavior.

## Progress tracker

- [ ] Dedicated worktree created and base recorded.
- [ ] Finding A reproduced with failing tests.
- [ ] Finding A fixed without permitting real background commands.
- [ ] Finding B corruption boundary identified.
- [ ] Finding B valid and invalid streaming fixtures pass.
- [ ] Finding C terminal cleanup centralized and proven.
- [ ] Finding D streaming-thinking Markdown behavior corrected.
- [ ] Finding E raw-delta state churn removed.
- [ ] Finding F render/layout amplification reduced.
- [ ] Finding G persistence behavior measured and corrected if needed.
- [ ] End-to-end long-session fixture passes.
- [ ] Unit tests pass.
- [ ] Typecheck, lint, and repository checks pass.
- [ ] Full test suite passes.
- [ ] Completion report written.
