# Restore reviewed wrapper compatibility fixes

## Scope and provenance

- Base: `main` / `origin/main` at `2c26466e6bf1cfcb864afeb197cc6f0f089994c3`.
- Branch: `fix/restore-reviewed-wrapper-fixes`.
- Isolated worktree: `OpenFoxFork-restore-reviewed-fixes`.
- Reviewed reference: `894e8915`, including `f7fbcc4e` and `1f3d20ce`.
- Restore four omitted fixes on the current code, not a wholesale cherry-pick.
- Do not modify provider data, production configuration, user databases, the
  wrapper, the installed build, or the running server. No paid model calls.
- Initial implementation excluded publication. The user subsequently authorized
  committing this branch, pushing it and merging into `main`; build, deployment
  and restart remain outside that authorization.

## Implementation checklist

- [x] Verify clean main and remote SHA; create a dedicated worktree and branch.
- [x] Restore regression tests first and record discriminating RED failures.
- [x] R1: preserve Responses `output_index` for interleaved tool calls and
      argument deltas; retain fallback 0 when the field is absent.
- [x] R2: preserve CR in heredoc delimiters, matching the actual execution
      shell; test LF/CRLF, quoted/unquoted and mixed terminators.
- [x] R3: providers without an explicit protocol must resolve `auto`, never
      inherit a global `responses` override; preserve explicit per-provider choices.
- [x] R4: bind WS and replay HTTP fixtures explicitly to the same IPv4 address
      as their clients; assert the bound address rather than retrying a flaky test.
- [x] Run targeted GREEN tests and related continuity/compaction regressions.
- [x] Run repository checks and full unit/E2E suites with bounded parallelism.
- [x] Recheck diff, base/main and absence of installation/config changes.

## TDD evidence

RED (2026-09-13): selected restored tests, before any production or fixture fix:

```sh
./node_modules/.bin/vitest run src/server/llm/client-responses-e2e.test.ts src/server/tools/shell.test.ts src/server/provider-manager.test.ts src/server/replay.test.ts src/server/ws/server.test.ts --maxWorkers=1 --reporter=dot --silent=passed-only -t 'keeps parallel interleaved|preserves shell semantics|isolates provider protocol|does not inherit a global Chat|binds the fixture'
```

Exit 1: 13 failed, 11 passed, 207 excluded by the name filter. Discriminating
failures: tool indices all 0 (and concatenated names/invalid arguments), 8/16
shell delimiter cases, two inherited protocol cases, two IPv6 fixture binds.
The shell matrix also checks real shell stdout before checking the validator;
its processes only run `cat` and a bounded builtin `printf` followed by `wait`.

GREEN: same selected command exits 0, 24 passed, 207 excluded by the name filter.

Expanded regression run (all tests in 11 files) exits 0: 383 passed, 1 skipped.
It includes the five changed test files plus `responses-native`,
`responses-continuity`, `responses-image`, `api-protocol-override`,
`session/manager` and `replay-compaction.integration`, using `--maxWorkers=1`.
The interleaved-call test checks actual HTTP, parsed IDs/names/arguments, two
synthetic tool executions and distinct result events. Existing missing-index
streams remain covered by the unchanged single-tool test.

`npm run check`: exit 0 (server/web/E2E typechecks, lint, format and duplicate
checks; zero clones).

`npm run test:unit -- --maxWorkers=1`: exit 0; 413 files passed, 2 skipped;
5,548 tests passed, 32 skipped. Duration 164.48 seconds.

`VITEST_MAX_WORKERS=1 npm run test`: exit 0. Final combined gate:

- Unit: 413 files passed, 2 skipped; 5,548 tests passed, 32 skipped (162.51 s).
- E2E: 48 files passed, 3 skipped; 346 tests passed, 49 skipped (148.81 s).

This Vitest version applies the worker variable to both configurations. No
retries, snapshot updates or expanded limits were used to make the suites pass.

`git diff --check` and final document formatting: clean. No dependency, version,
UI, installed-build or configuration changes. At the pre-publication check,
`main` was clean at the base SHA. The installed version was `2.0.143-fork.6`;
PID 68624 remained the same
OpenFox process started at 00:13:18. Dependencies were copied into the isolated
worktree with copy-on-write; the running checkout's dependencies were not edited.

Limits: local synthetic HTTP/tool results and the actual macOS execution shell;
Windows shell-matrix cases are skipped. No live wrapper/provider call, no paid
model test, and no claim of an actual Sunshine resume after changing its config.

## Delivery

Implementation and validation complete. Eight existing files changed (three
application files, five test files), plus this tracking document.

Publication scope approved on 2026-09-13: commit these nine files on
`fix/restore-reviewed-wrapper-fixes`, push the branch, merge into `main` and push
`main`. Verify the final local and remote commit IDs and clean worktrees. The
review found no additional code changes required; preserve the existing hook
gates rather than bypassing them.

No build, deployment, restart, provider-data change or paid test is included.
A source test or a Git merge does not establish a live Sunshine resume or alter
the existing provider protocol configuration.
