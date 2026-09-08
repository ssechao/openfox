# Review follow-up for 6a487e69

## Worktree and safety

- Worktree: `/Users/sechaosouchiam/Source/github.com/OpenFoxFork-recovery`.
- Branch: `feat/fork-port-2.0.137-recovery`.
- HEAD before and after: `6a487e69f4eead6f877a4729e1a5b4af5863d0aa`.
- Git state before editing: clean. Source changes and these delivery artifacts remain uncommitted and unstaged.
- No commit, push, merge, installation, deployment or service restart. No production, user DB/config, port 450 or wrapper service access. Tests use local HTTP fixtures, temporary configuration files and test databases.
- Other peers' worktrees were not modified. Historical reference: the local Git objects for `6f6b4f81`, inspected file by file, without cherry-picking.

## Separate diffs

Apply the patches in this order to the reviewed SHA. They are already reflected in this worktree; do not reapply them here.

1. [Shell CRLF](01-shell-crlf.patch): `shell.ts` and `shell.test.ts`.
2. [Responses call indices](02-responses-indices.patch): only the two index translation sites in `responses-native.ts`, plus the HTTP/dispatch fixture.
3. [Fork compatibility](03-fork-compatibility.patch): provider configuration/routing, scoped continuity, client ownership, compaction wiring, images and associated tests.

The third patch starts from the result of the second patch for their shared adapter file. Both forward application against the unchanged index and reverse application against the edited worktree passed dry-run validation:

```bash
git apply --cached --check docs/review-6a487e69/01-shell-crlf.patch docs/review-6a487e69/02-responses-indices.patch docs/review-6a487e69/03-fork-compatibility.patch
git apply --check --reverse docs/review-6a487e69/03-fork-compatibility.patch docs/review-6a487e69/02-responses-indices.patch docs/review-6a487e69/01-shell-crlf.patch
```

These checks do not stage or change files.

## Lot 1: shell delimiter symmetry

The delimiter scanner used `\\s`, which treats CR as a separator, while the closing-line comparison retained CR. The actual shell retains CR in the opening delimiter too. A CRLF heredoc could consequently hide an executable background operator from the validator.

The correction only changes the delimiter's word-separator character class to space/tab/LF and shell operators. It does not normalize the command or remove CR from data.

- RED: 8 of 16 differential cases failed before correction, including real background execution accepted by the validator.
- GREEN: 91 shell tests passed, including all 16 quoted/unquoted, LF, CRLF and mixed-ending cases.
- The differential fixture uses `spawnShellProcess`, the same launcher as `run_command`. The shell measured on this machine is `/bin/zsh`.
- A builtin `printf` runs in the background and is reaped by `wait`; output distinguishes actual execution from literal heredoc data. Embedded CR bytes are also asserted unchanged.

## Lot 2: parallel Responses calls

`response.output_item.added` and `response.function_call_arguments.delta` both hard-coded index zero. The real HTTP fixture reproduced six zero indices, the merged name `read_fileglob`, and corrupted concatenated arguments.

Both events now retain the standard `output_index`. The fixture places a reasoning item at index zero and interleaves calls at indices one and three. It exercises the LLM client and `executeTools`, asserting distinct IDs, names, parsed arguments and persisted results.

- RED: indices `[0,0,0,0,0,0]` instead of `[1,3,3,1,3,1]`.
- GREEN: 43 tests passed across the adapter, HTTP client and tool execution tests.

## Lot 3: restore missing fork compatibility only

The reviewed tree already had backend-aware protocol resolution and terminal protections. It lacked the provider override plumbing, persisted override schema, Responses continuity and the shared session client ownership present in the historical fix.

- `Provider.apiProtocol` is retained through schema load/save, REST POST/PUT and ProviderManager. A provider without an override keeps automatic routing rather than inheriting another provider's override.
- Continuity is managed at the Responses adapter using standard `store` and `previous_response_id`. Instructions and tools remain on every request; only the verified new suffix goes into `input`.
- Prefix verification includes the previous assistant output and tool calls. Valid JSON formatting differences in tool arguments are compared semantically for the digest only; outbound arguments are not rewritten or repaired.
- One current client selection per session is shared by WS, queued turns and agent overrides. Switching A to B to A creates a new A client instead of retrieving an old chain. Direct model/backend changes clear the adapter's chains too.
- Scope keys stay internal to the client call, never in HTTP headers or bodies. Sub-agents use their run ID, not just their type. Compaction resets the exact key used by the stream.
- Text/image parts use `input_text` and `input_image`, preserving image URL/data bytes. Parallel tool results use their original `call_id`.
- Failed, incomplete, aborted or reset-in-flight responses do not establish a continuation. An explicit retention refusal causes subsequent attempts to use stateless full history.
- No proprietary completion flag, session/affinity header, `conversation` field or other extra wire field was introduced. Qwen/vLLM stays on Chat Completions with full `messages` and no chain fields.
- Existing EOF/error handling, coalescing, terminal cleanup and rendering optimizations remain in place.

RED measurements before the missing wiring was restored: ten failing protocol/continuity/provider tests, then five further failures for config persistence, compaction scope and missing session-client ownership. A spaced-JSON tool response additionally exposed a prefix-digest mismatch, fixed without changing wire bytes.

Final targeted verification:

- Ten related unit/integration files: **235 passed, 1 skipped**.
- Provider REST file with POST/PUT/reload coverage: **13 passed**.
- The real agent pipeline fixture verifies `previous_response_id` and result-only input after tool execution, not just direct client calls.
- WS and queue test doubles were extended for the restored session-cache methods. Production code was not given compatibility fallbacks for incomplete mocks.

## Global verification

- `npm run check`: passed (TypeScript, lint, formatting, duplicate detection).
- `git diff --check`: passed for source changes.
- `VITEST_MAX_WORKERS=1 npm run test:e2e`: **337 passed, 49 skipped**, 45 passing files / 3 skipped files.
- **The full unit suite is not green.** Latest `VITEST_MAX_WORKERS=1 npm run test:unit`: **5242 passed, 3 failed, 32 skipped**.

The latest unit failures are:

1. `src/server/replay.test.ts`: system-generated message case, unexpected end of JSON input.
2. `src/server/tools/shell-streaming.test.ts`: abort after 300 ms before the expected `ready` output.
3. `web/src/components/shared/ProviderModal.test.tsx`: reasoning-effort selector absent at assertion time.

Earlier complete runs also failed in different replay/ProviderModal cases. The replay file passed 12/12 in isolation. A combined isolated shell/ProviderModal run passed 60/61 but failed a different ProviderModal case. The measured machine load ranged from about 28 down to 15. These observations suggest timing sensitivity, but do not prove the failures are pre-existing: no complete baseline-only control run was performed.

The failing files and the ProviderModal component are unchanged from HEAD. They were not patched, skipped or given weaker assertions. Because `npm test` stops after a failing unit phase, the full E2E phase was also run separately. Global green validation remains an explicit delivery limitation, not a claimed success.

## Remaining limits

- Differential shell execution was verified on macOS `/bin/zsh`; the fixture is skipped on Windows, which may use cmd/PowerShell rather than heredocs.
- Distinct parallel Responses calls require the protocol's `output_index`. The pre-existing zero fallback for a single unindexed stream is retained.
- Provider checks use real localhost HTTP fixtures, not a production provider or wrapper.
- Continuity is process-local. History/config mismatches, explicit resets, client replacement, eviction or errors safely re-prime full history. Provider-side retention is required for actual chaining.
- There are no new commits. The index and reviewed HEAD remain unchanged; the source changes, two new test files and delivery directory are left for review.
