# Stream batching benchmark

Replays a turn the size of the Qwen "Dev" session that blocked the 550 (300 000
thinking fragments in a single turn of 830 model calls) against a real OpenFox
server, and measures how responsive the server stays while it streams.

```bash
npm run bench:stream                                  # this checkout
npm run bench:stream -- --repo=/path/to/other/checkout # any other checkout
```

The script never touches a real OpenFox: it boots `createServerHandle` from the
`--repo` sources in a child process with a temporary `HOME`, `XDG_*` and SQLite
file, and points it at a fake OpenAI-compatible model served by a second child.
The same script therefore measures any checkout, which is how the before/after
numbers below were produced.

## What it does

1. Starts the fake model (chat completions, `reasoning_content` deltas) and the
   OpenFox server, registers the model as a provider, creates a project.
2. Runs a short warm-up turn in a separate session, so first-request costs are
   not attributed to the measured turn.
3. Probes `GET /api/config` for a few seconds at rest (`apiConfigIdleMs`).
4. Sends one message to a fresh session. The fake model answers 830 times: each
   call streams its share of the 300 000 thinking fragments, then requests
   `read_file`; the last call answers with text. The bench waits for the
   `session.running = false` WebSocket message.
5. During the whole turn it probes `GET /api/config` every 25 ms
   (`apiConfigStreamingMs`), polls `GET /api/sessions/:id` every 5 s like an
   open tab (`sessionGetStreamingMs`), counts the `chat.thinking` messages a
   WebSocket client receives, and samples the server's event-loop delay.
6. Prints a JSON report, including the number of events the turn appended to
   SQLite.

## Knobs

`--fragments` (300000), `--calls` (830), `--rate` fragments per second (3000),
`--probe-interval` ms (25), `--session-poll` ms (5000, 0 disables),
`--idle-probe` ms (3000), `--timeout` ms, `--label`, `--out` file. Each has a
`BENCH_*` environment equivalent.

## Measured state (2026-10-20, .122 Docker `node:24-bookworm`, 24 cores, idle host)

Same script, same workload, two checkouts: `main` at `8ebe8abe` (before) and
`perf/stream-batching` (after).

| Metric                                 | Before (8ebe8abe) | After        |
| -------------------------------------- | ----------------- | ------------ |
| `GET /api/config` p50 during the turn  | 1.3 ms            | 0.6 ms       |
| `GET /api/config` p95                  | 547 ms            | 7 ms         |
| `GET /api/config` p99                  | 975 ms            | 15.1 ms      |
| `GET /api/config` max                  | 2 522 ms          | 94 ms        |
| `GET /api/config` samples over 100 ms  | 1 852 / 7 928     | 0 / 5 079    |
| `GET /api/sessions/:id` p99            | 1 760 ms          | 22 ms        |
| Server event-loop delay p99 / max      | 825 / 2 536 ms    | 22.5 / 98 ms |
| Turn duration                          | 925 s             | 125 s        |
| Events appended to SQLite by the turn  | 304 988           | 5 837        |
| `chat.thinking` messages received live | 300 000           | 300 000      |
| `GET /api/config` p99 at rest          | 1.8 ms            | 1.4 ms       |

The fake model and the probes share the host with the server, so absolute
values move with machine load; compare runs from the same batch.
