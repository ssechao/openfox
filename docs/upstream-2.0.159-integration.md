# Upstream 2.0.159 integration

## Scope and frozen inputs

- Branch: `merge/upstream-2.0.159`, isolated worktree `OpenFoxFork-upstream-2.0.159`.
- Fork parent: `5d5d8fb7` (main tip when the branch was cut).
- Upstream parent: `c4f22489` (`v2.0.159+1`).
- Common ancestor: `21081c66` (2.0.145) — the upstream parent of the previous integration.
- Divergence at the start: 92 commits on the fork side, 94 upstream.
- No deployment, runtime restart, user configuration/database change or paid LLM call.
  Build, install and restart remain separately authorized actions.

## Tracking

- [x] Verify main/upstream, create the isolated branch and worktree, restore the hooks (`HUSKY=1 npm run prepare`).
- [x] Start a no-commit merge; identify the 30 textual conflicts.
- [x] Resolve every conflict, preserving the fork's guards and importing upstream's fixes.
- [x] Repair the two silent merge artifacts (duplicated `case 'turn.snapshot'`, upstream defaults overwriting the fork's display defaults).
- [x] Run the targeted suites of every conflicted area, then `npm run check`, the full unit suite and the complete e2e suite.
- [x] Commit the merge with both frozen parents, hooks enabled, and push the branch, then fast-forward main.

## Merge decisions

- **Version metadata**: `2.0.159-fork.0` in `package.json`, `package-lock.json` (root `version` and `packages[""].version`) and `web/package-lock.json` (`".."` entry). The `-fork.<n>` scheme and its automatic increment in `prebuild:server` are preserved, as is the fork auto-update guard `/-fork(?:\.|$)/i`.
- **Silent regressions repaired**: the merge had taken upstream's values for `DISPLAY_MAX_VISIBLE_ITEMS` (300 → 100) and `DISPLAY_FEED_VIRTUALIZATION` (false → true) without a conflict, and had kept _both_ sides of the second `case 'turn.snapshot'` in `fold-state.ts` (three case labels in one switch). The fork's defaults are restored and the duplicated case is merged into one that keeps the fork's replace semantics for `contextWindows` and upstream's re-seed of `formatRetries`.
- **Agent loop**: the fork's `chainKey` and the upstream `subAgentTags()` helper coexist. Sub-agents keep upstream's scoped measurement (own context tokens and model window) for both the output budget and the compaction gate, while a top-level turn keeps the authoritative window resolved for the turn and the fork's unknown-usage-aware effective tokens. The coalesced stream (fork) carries upstream's asynchronous callback and live `edit_file` context enrichment. The fork's `compactAfterTools` branch is kept and now tags the compaction prompt with `config.subAgentMetadata`, as do the three other prompt sites. Upstream's "tool calls are not possible at this stage" rejection is imported.
- **Responses / provider routing**: `apiProtocol` (fork) and upstream's `logo`/`icon`/`pluginMetadata` are unioned in `shared/types.ts`, `cli/config.ts`, `web/src/stores/config.ts`, `ProviderModal.tsx` and both provider routes of `index.ts`. `LLMCompletionResponse.usage` adopts upstream's `TokenUsage` (with cache attribution) and keeps the fork's `completed?` flag.
- **Event store**: upstream's multi-process retry loop in `appendBatch` is kept, with the fork's per-event selective cache invalidation and `recent_user_prompts` update inside it.
- **MCP manager**: the fork's per-session client resolution (and its explicit refusal without a session id) is kept, on top of upstream's timeout machinery (`effectiveRequestTimeoutSeconds` + `AbortController`); the fork's stdio stderr drain is preserved.
- **Web**: the fork's tri-state `feedVirtualizationMode` (and its `DisplayTab` select) is kept, with upstream's `virtualization` prop override honoured; the feed adopts upstream's document-capture scroll listener (the fork resolved the viewport at attach time, when the OverlayScrollbars instance does not exist yet) and its drift-aware window re-anchor, while keeping the fork's streaming-safe `wrapperStyle`. `OptionalScrollArea` keeps upstream's lazy-upgrade semantics and the client fallback for `useNativeScrollbars` now matches the server default (`false`). The session store keeps the fork's deferred/transition commit and upstream's `trimPaneMessages` bound.
- **Workflows**: the fork's durable `step_done` finalization is kept on top of upstream's per-step agent/client resolution; `TemplateContext`/`TEMPLATE_VARIABLES` now live in `template.js` as upstream moved them, and the fork's `mode` variable was ported into that module.
- **Tests adapted to the merged contracts** (no production behaviour changed to satisfy a test):
  - `execute-tools.test.ts` keeps both the fork's large-tool-call test and upstream's preflight test.
  - `shell-streaming.test.ts` takes upstream's portable orphan command (no `setsid`); the fork's helper was removed.
  - `orchestrator.test.ts`: the mocked `consumeStreamGenerator` now awaits the callback, mirroring the production contract (an async callback may reject).
  - `agent-loop-retry.history.test.ts`: the `TurnMetrics` mock gains `addThinkingTime`.
  - `settings.test.ts`: the fork's `300` default is restored.
  - `ChatFeedItems.test.tsx` / `OptionalScrollArea.test.tsx`: the override describe flushes the settings write before counting observers, and the scroll-area expectations follow upstream's lazy-upgrade component.
  - `messageHandler.test.ts` / `streamingBuffer.test.ts`: the pane cap is asserted as `getMaxVisibleItems() + MESSAGE_CAP_HEADROOM` instead of a hardcoded 125, and the streaming target is re-announced after the bound dropped it.
  - `replay-compaction.integration.test.ts`: the side branch forks the current window's last answer — only the latest context window can be forked (upstream's guard, asserted by `ChatMessage.test.tsx`).

## Evidence

`npm run check`: exit 0 (server/web/e2e/bench types, lint, format, zero duplicate clones).

Full unit suite (`VITEST_MAX_WORKERS=1 … --maxWorkers=1`): exit 0 — 471 files passed / 2 skipped, 6365 tests passed / 32 skipped, 184 s.
Complete e2e suite (`OPENFOX_E2E_MAX_WORKERS=4`): exit 0 — 49 files passed / 3 skipped, 353 tests passed / 49 skipped, 52 s.
Environment: macOS ARM64, Node v25.6.1, Vitest 4.1.10.

No conflict markers and no unmerged index entries remain. Every fork guard is present in the merged tree: `recent_user_prompts`, `idx_events_latest_snapshot`, `createTurnEventSink`, `responsesChainKey`, per-session MCP clients, `apiProtocol`, the tri-state feed virtualization and the stdio stderr drain.

`src/server/tools/path-security.test.ts > confirmation flow > requests path access…` is order/load sensitive: it fails identically on the pre-merge fork tip (`main` at `5d5d8fb7`) and passed in the final full run. It is not a merge regression.

Passing local and mock tests is not a live-provider or deployment verification: no provider call, install or restart was performed.

## Post-merge review adjustments

- **Native scrollbars default**: `DisplayTab` read the setting with a `'true'` fallback and declared `defaultValue: 'true'`, while the server default and the `useDisplaySettings` fallback are `'false'` — the toggle could render ON while the behaviour was OFF. Both are now `'false'`.
- **Feed virtualization default**: the declared default was `'false'` → `'off'`, while the client fallback (`'auto'`) and the Display tab's help text document Auto ("enables this on feeds longer than 50 items"). The declared default is now `'auto'`, guarded by a settings test.
- **Fullscreen slash-command toggle**: it governs the composer's slash popup, so it moved from `FEED_TOGGLES` to `COMPOSER_TOGGLES`, with an assertion added to the Composer section test.
- **Redundant `role="button"`** removed from the `ToggleList` switch (it is already a `<button>`; `aria-pressed` carries the state).
- Left as upstream: the fullscreen popup's positioning magic numbers (`document.querySelector('header')`, `42`, `84px`) come from upstream's commit `246cfff5` and were not touched by the merge; a layout refactor belongs to its own change.
- Known pre-existing gap carried by both parents: the slash autocomplete lists enabled skills, but neither `parseSlashCommand` (web) nor `resolveSlashLaunch` (server) recognises a skill id, so selecting one sends the literal text. Wiring it is a feature (skill launch path), not a merge fix.

## Delivery gates

- Commit the merge with both frozen parents and the repository hooks enabled (no `--no-verify`).
- Push only to `ssechao/openfox` (`origin`), never to `upstream`.
- Advance `main` by fast-forward only, preserving any concurrent work, then verify the remote SHA equals the merge commit.
