# Upstream 2.0.145 integration

## Scope and frozen inputs

- Branch: `merge/upstream-2.0.145`, isolated worktree `OpenFoxFork-upstream-2.0.145`.
- Fork parent: `986ed33e53f1a47f50f48f81f655419f28e3767d`.
- Upstream parent: `21081c66adf59fdefb52fd6cbf7d495587dfe434` (2.0.145).
- Common ancestor: `cfe0c0dd918e502788ef989be57e266c54767c3d` (2.0.143).
- Prepare and validate in isolation. Subsequent user authorization (2026-09-13): commit and push the dedicated branch, then merge and push main. No deployment, runtime restart, user configuration/database changes or paid LLM calls.

## Tracking

- [x] Verify main/upstream and create the isolated branch and worktree.
- [x] Start a no-commit merge; identify five textual conflicts.
- [x] Resolve version metadata, shared prompts and localized update parsing while preserving fork guards and compaction budgets.
- [x] RED: boot continuation must cooperate with snapshot-aware interrupted-message recovery, select only previously running sessions and not finalize twice.
- [x] GREEN: minimally reconcile startup recovery and upstream opt-in continuation.
- [x] Run targeted wrapper, replay/compaction, shell and upstream UI regressions.
- [x] Run check, unit suite and complete test suite with bounded concurrency.
- [x] Review the diff against both parents and mark conflicts resolved.

## Merge decisions

- Version metadata: 2.0.145-fork.0; retain fork build/version and upstream-update protection.
- Agent loop: import shared continuation prompts from upstream; retain the fork's bounded compaction and overflow recovery.
- Auto-update: localized English/French success parser with the injected current-version fallback.
- Store/boot continuation: retain atomic partial-message recovery, snapshot-aware running state and checkpoint recovery. Collect eligible IDs after durable recovery. The upstream opt-in setting remains disabled by default.
- Keep Responses output indices, provider protocol isolation, continuity, images, replay/compaction and explicit IPv4 fixtures from main.
- Upstream's detached-child test used the external `setsid` command, absent on this Mac. Replace only the fixture with Node's detached POSIX spawn and assert the grace-period diagnostic, so both timeout and normal-exit paths are actually tested. Children self-expire after 10 seconds. No shell production change beyond upstream.

## Evidence

RED after syntactic conflict resolution: 7 failures / 89 passes in the three targeted suites (store, auto-continue, auto-update). Three failures establish missing stale-session collection; four establish wrong reminder/snapshot handling. The localization, injected-version fallback and fork-update guards pass.

GREEN: all 96 store/auto-continue/auto-update tests pass. The expanded 20-file regression selection initially gave 426 passes, 1 skip and 1 reproducible failure in upstream's `setsid`-dependent test. `bash -c 'setsid sleep 0'` confirmed command-not-found (exit 127); the isolated test reproduced the same failure. After the portable fixture adaptation, shell-streaming + store + auto-continue pass 101/101.

`npm run check`: exit 0 (server/web/e2e types, lint, format, zero duplicate clones). Initial type errors in the added fixture phase and the planner's last-message typing were corrected; no compiler settings changed.

`npm run test:unit -- --maxWorkers=1`: exit 0, 414 files passed / 2 skipped, 5576 tests passed / 32 skipped, 169.09s. Environment: macOS ARM64, Node v25.6.1, Vitest 4.1.10.

Full `VITEST_MAX_WORKERS=1 npm run test`: exit 0. Second unit pass: 5576 passed / 32 skipped, 162.70s. E2E: 48 files passed / 3 skipped, 346 tests passed / 49 skipped, 149.83s.

No conflict markers or unmerged index entries remain. Package/lockfile changes are root-version metadata only; no dependency updates. The fork agent-loop is identical apart from shared continuation-prompt imports/exports; the CRLF validator is byte-identical to main. EventStore storage, checkpoint and migration implementation is unchanged, as is upstream's boot queue dispatch.

Passing local/mock tests does not constitute a live-provider or deployment verification. At the end of preparation, main was clean at the fork parent and the global binary link still pointed to the previously installed 2.0.143-fork.7 release.

## Delivery gates

- Commit the merge with both frozen parents and the repository hooks enabled. The isolated worktree lacked Husky's generated launchers; `HUSKY=1 npm run prepare` restored them before committing, without disabling any gate.
- No PR existed for this branch at the pre-push audit. Push only to `ssechao/openfox`, never upstream.
- Recheck main and advance it by fast-forward only, preserving any concurrent work. Verify the remote main SHA equals the merge commit after pushing.
- Building, installing and restarting remain separately authorized actions, not part of this delivery.
