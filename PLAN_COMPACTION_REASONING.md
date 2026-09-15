# Preserve reasoning effort during compaction

## Scope and baseline

- Branch: `fix/compaction-preserve-reasoning`.
- Base: `main` / `origin/main`, `24813c483627dc9b7e23657d4b78dfc43a506c1b`
  (`2.0.145-fork.11`), verified on 2026-09-15.
- Isolated worktree; OpenFox only. No wrapper changes, production database/config
  changes, process restart, or deployment. Implementation was validated before
  the separate commit/push/merge authorization below.
- No paid model calls. Synthetic HTTP requests and temporary test databases only.

## Problem and acceptance criteria

OpenFox overrides the selected Claude/GPT reasoning effort with `low` both when
counting an unknown context and when generating a compaction summary. Changing
global effort can invalidate the provider's prompt cache, even with native resume.

1. Compaction must inherit the resolved client's effort rather than override it.
2. Token counting and generation must use the same effort selection policy.
3. Cover Claude and GPT, including explicitly selected `low` as a valid setting.
4. Preserve the existing summary instructions, output/headroom limits, tool
   restrictions, and post-compaction Responses chain invalidation.
5. Check actual locally captured Responses and Chat Completions request bodies.
6. Do not equate synthetic tests with proof of an Anthropic cache hit. Output
   limits and other cache-sensitive settings are not changed by this patch.

## Tracking

- [x] Inspect source and installed artifact; identify both forced overrides.
- [x] Create isolated branch from the current main/release baseline.
- [x] RED: regression tests fail with the existing forced effort.
- [x] GREEN implementation: remove both overrides and document effort inheritance.
- [x] Verify targeted tests and the real HTTP request matrix.
- [x] Run full unit/E2E suites and `npm run check`; inspect final diff.

## Evidence

The RED matrix covers manual/automatic compaction and unknown-context counting,
plus real local HTTP before/summary/after requests for Claude/GPT and both API
protocols. Explicit `low` and Qwen are controls. The existing GPT Chat Completions
policy (`none` on tool-using requests) is preserved, not changed by this fix.

- RED, before application changes: 10 failed / 5 passed controls. Six failures
  demonstrate forced effort in the agent loop (automatic/manual/counting for
  Claude and GPT), and four show `low` on the actual HTTP summary request where
  `xhigh` was selected. Non-matching tests were filtered out, not executed.
- GREEN targeted: 129/129 tests in five files, including eight complete synthetic
  HTTP before/summary/after scenarios. The summary output cap stays at 8,192;
  tools remain disabled and the next request uses only the compacted window,
  without `previous_response_id` from the old window.
- `npm run check`: exit 0 (server/web/E2E types, lint, format, duplication checks).
- Final application diff: only the two forced effort overrides removed, plus
  explanatory comments; no changes to routing, compaction instructions, history,
  output limits, persistence, or wrapper behaviour.
- Full-suite command:
  `VITEST_MAX_WORKERS=1 OPENFOX_E2E_MAX_WORKERS=4 npm run test`.
  Unit phase: 5,702 passed / 32 skipped, 421 files passed / 2 skipped (170.90 s).
  E2E phase: 346 passed / 49 skipped, 48 files passed / 3 skipped (152.22 s).
  Overall exit 0; no retries or production model calls.
- Final `git diff --check`: clean. Only one application file, two test files and
  this tracking document changed; version and lockfiles untouched. The main
  checkout stayed clean at the baseline during implementation. These validation
  results were obtained before committing, with no deployment.

## Delivery authorization — 2026-09-15

The user subsequently authorized committing, pushing the dedicated branch, and
merging it into `main`. Deployment and restarting OpenFox are not authorized by
that instruction. The pre-push review confirms the four-file scope, unchanged
application/test diff since the full GREEN run, and no open PR for this branch.
Git history and remote branch refs are the source of truth for delivery status.
