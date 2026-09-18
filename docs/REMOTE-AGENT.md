# Remote-Agent (Headless-Agent) Architecture

OpenFox can drive **remote machines** by executing its environment tools
(`run_command`, `read_file`, `write_file`, `edit_file`, `background_process`,
`dev_server`, …) on a **headless-agent** daemon running on that machine. The
agent has **no LLM, no UI, no session server** — it is a pure tool executor.
The brain (LLM) and the UI stay on the local OpenFox server; only execution is
delegated.

This feature spans **two repositories**:

| Repo                          | Role                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `OpenFoxFork` (this repo)     | The headless-agent daemon, the `remote` routing, the `remote_agents` tool, and the hub client. |
| `llm-aether` (the aether hub) | The registry of headless-agents, signed enrollment, the execution proxy, and scoped tokens.    |

## The two kinds of hub clients

The aether hub accepts two kinds of clients:

- **`peer`** — owns its own LLM (Claude Code, Codex, an OpenFox session). Talks
  to the hub with async messaging (prompt queue + SSE).
- **`headless-agent`** — no LLM. Executes tools/MCP only, via request/response.
  This is the remote-agent.

Both are entries in the hub's peer registry (enumerable, TTL, title/task). The
difference is the `peer_type` and the channel.

## Security model (keys + tokens)

- **Ed25519 identity per agent.** Each headless-agent generates an Ed25519
  keypair at first start. The private key never leaves the machine; the public
  key is registered with the hub. The peer id is **stable** — derived from the
  public key (SHA-256), so the same key resumes the same identity across
  prunes and hub restarts.
- **Signed enrollment.** To register, the agent signs a **full enrollment
  payload** (title, public key, workdir, hostname, canonical capabilities +
  a fresh nonce + the hub's startup **epoch**, fetched via `GET /ra/epoch`
  first) with its private key. The hub verifies the signature against
  the supplied public key before storing anything, then **consumes the nonce**
  (single-use) — a captured enrollment cannot be replayed, nor with modified
  metadata, nor after a hub restart (the epoch changed).
- **Mutual authentication.** The hub signs every execution envelope it relays
  to an agent (hub's Ed25519). The agent verifies the signature with the hub's
  public key (received at enrollment) before executing anything.
- **Agent-signed proofs (anti-impersonation).** The hub Bearer is a shared
  secret, so every _agent_ request (`/ra/poll`, `/ra/heartbeat`, `/ra/result`)
  additionally carries a **proof signed by the agent** (its private key over
  `agent_proof_payload(op, public_key, fresh nonce, hub_epoch, extra)`, where
  `extra` is the operation's **full mutable body**: empty for `/ra/poll`;
  `title|workdir|hostname|capabilities` for `/ra/heartbeat`;
  `request_id|token|result_canonical` for `/ra/result`). The hub verifies the
  proof against the **stored** public key and consumes the nonce. A holder of
  the Bearer who does not possess the agent's private key cannot poll another
  agent's queue, submit results for it, or refresh its liveness with modified
  metadata. The hub stores/delivers `result_canonical` (the signed string), not
  a re-serialized field.
- **Injective canonical encoding.** Every canonical payload (enrollment,
  agent-proof, heartbeat/result `extra`, execution envelope) is built by
  **length-prefixing each field** (u32 big-endian) before its UTF-8 bytes —
  never by joining with a delimiter byte. Field boundaries are therefore
  unambiguous: a `0x1f` (or any other byte) inside a field can never be
  confused with a field separator, so two distinct field lists can never
  produce the same canonical bytes. The hub and the daemon implement the same
  byte-for-byte encoding.
- **Unicode-safe `extra`.** The proof's `extra` is handled as **raw bytes** on
  both sides (no string round-trip on the agent side). Non-ASCII metadata
  (e.g. `é` = UTF-8 `c3 a9`) is preserved exactly, so heartbeats and results
  with Unicode titles/workdirs/paths/outputs verify and round-trip intact.
- **Hub epoch (replay-proof across hub restarts).** Each hub process generates
  a random **startup epoch** (UUID v4) at boot. The agent fetches it via
  `GET /ra/epoch` **before enrolling** and binds it into its enrollment
  signature, and into every subsequent agent-proof payload. The hub
  reconstructs each payload with **its own** epoch, so a captured enrollment
  or proof from a previous hub process fails verification after a restart —
  even though the nonce is still inside the replay window and the nonce cache
  is empty. The daemon re-enrolls on a 401 to pick up the new epoch.
- **Timestamped nonces + replay window.** Nonces are `<unix_ms>-<random>`
  (random via `crypto.randomBytes`, not `Math.random`). The hub accepts a nonce
  only while its timestamp is within a 5-minute replay window, and the
  consumed-nonce cache covers the full window — so a captured request is
  rejected once the window has elapsed, even after a cache prune. (A hub
  restart is additionally covered by the **hub epoch** above.) The same window
  applies to enrollment nonces.
- **Scoped ephemeral tokens.** Each execution call is bound to a
  `(session, agent)` pair by a hub-issued, single-use, short-lived token. The
  agent must present the token when it submits the result
  (`POST /ra/result`); the hub validates it against the session the request
  was actually queued for (its own binding, not a session the agent claims)
  and consumes it. The hub also compares `bound_agent == agent.peer_id`
  strictly before consuming. A token cannot be replayed, and cannot be used
  against a different session or agent. A retried submission of an
  already-resolved request is acknowledged idempotently (the original result
  is preserved), and the result is kept until its TTL so a retried `/ra/await`
  after a lost response still recovers it.
- **Principal auth + control-plane credential.** The OpenFox server
  authenticates to the hub with a Bearer token (its own principal), distinct
  from the agents' keys. The **control routes** (`/ra/execute`, `/ra/await`,
  `/ra/agents`) — the RCE surface — authenticate with a **distinct control
  credential** (`AETHER_RA_CONTROL_TOKEN` on the hub, `controlToken` in the
  OpenFox config). ONLY that credential is accepted on those routes: the
  shared hub Bearer is rejected (401), so a peer or headless-agent holding the
  hub token cannot enumerate remote-execution targets or drive executions.
  The routes **fail closed**: when no control token is configured, EVERY
  request is rejected (401) — the hub Bearer is never a fallback, so an
  unconfigured hub cannot be driven by any agent holding the shared hub
  token.
- **Single gateway.** The OpenFox server never contacts a headless-agent
  directly. All traffic flows through the hub. The agent is only reachable via
  the hub (it polls the hub; nothing is inbound to it), so the hub is the only
  control point.
- **Transport.** In production the hub must be exposed over **TLS** — the
  Bearer and the proofs are plaintext over HTTP.

## How a tool call is routed

1. The LLM calls an environment tool with an optional `remote` argument (the
   agent's id or title). Absent/empty → the call runs **locally**, unchanged.
2. If `remote` is present, the OpenFox server's dispatcher
   (`src/server/chat/execute-tools.ts`) routes the call to the hub client
   (`src/server/remote-agent/client.ts`) instead of executing locally.
3. The hub client validates the target (unknown/offline agent → an error listing
   the available agents; no silent local fallback), then:
   - `POST /ra/execute` — the hub signs the envelope, issues a scoped token,
     queues the envelope, and returns a `request_id`.
   - `POST /ra/await` — the client long-polls for the result (bounded timeout).
4. The headless-agent daemon polls the hub (`POST /ra/poll`, **with an
   agent-signed proof**), verifies the hub signature, executes the tool locally
   (anchored on its `--workdir`), and posts the result back (`POST /ra/result`,
   **with an agent-signed proof binding the request_id + the scoped token**).
   The hub verifies the proof against the stored key, compares
   `bound_agent == agent` strictly, validates the token against the (session,
   agent) pair it issued and consumes it (single-use, anti-replay).
5. The result is returned to the session in the **same shape** as a local tool
   result (streaming/fetch parity).

A single session can drive **several agents at once** by passing different
`remote` values to different tool calls.

## Discovery

The `remote_agents` tool (control-plane, always local) lists the headless-agents
registered on the hub with their liveness, workdir, host, and capabilities. A
session calls it first to discover which machines it can drive.

## Configuration

### Local OpenFox server (enable remote execution)

Add to the global config (`~/.config/openfox/config.json`), or run
`openfox remote-agent add --hub-url <url> --hub-token <token> [--control-token <c>]`:

```json
{
  "remoteAgent": {
    "hubUrl": "http://192.168.71.132:4175/mcp",
    "hubToken": "<hub-bearer-token>",
    "controlToken": "<ra-control-token>",
    "callTimeoutMs": 120000
  }
}
```

- `hubToken` = the shared hub Bearer (agent routes + peer messaging).
- `controlToken` = the control-plane credential (the hub's
  `AETHER_RA_CONTROL_TOKEN`); used on `/ra/execute`, `/ra/await`, `/ra/agents`.
  When the hub has a control token configured, remote execution fails (401)
  without it.

Restart the OpenFox server to apply. Without this, `remote` arguments produce a
clear error (no remote-agent hub configured).

### Headless-agent daemon (on the remote machine)

Install the `openfox` binary on the remote machine and run:

```bash
openfox remote-agent \
  --workdir /path/to/remote/project \
  --hub-url http://192.168.71.132:4175/mcp \
  --hub-token <hub-bearer-token> \
  --name build-box
```

The daemon enrolls with the hub, heartbeats to stay enumerable, and polls for
signed execution envelopes. It exposes a local `GET /healthz` for operators.

### MCP on the daemon

Pass `--mcp-config <file>` (a JSON file with a `mcpServers` record, same schema
as the global config) to run the daemon's own MCP servers and expose their tools
remotely.

## Hub endpoints (aether hub)

| Route           | Method | Purpose                                                                              |
| --------------- | ------ | ------------------------------------------------------------------------------------ |
| `/ra/epoch`     | GET    | Return the hub's startup epoch (challenge the agent binds into its enrollment).      |
| `/ra/enroll`    | POST   | Enroll/resume a headless-agent (full-payload signature + nonce + hub epoch).         |
| `/ra/heartbeat` | POST   | Refresh liveness + metadata (agent-signed proof over the full body).                 |
| `/ra/agents`    | GET    | List headless-agents (enumeration). **Control credential.**                          |
| `/ra/execute`   | POST   | Queue a signed execution for an agent; returns `request_id`. **Control credential.** |
| `/ra/await`     | POST   | Long-poll for a queued execution's result. **Control credential.**                   |
| `/ra/poll`      | POST   | An agent polls for its next pending execution (agent-signed proof).                  |
| `/ra/result`    | POST   | An agent submits a result (agent-signed proof over request_id + token + result).     |

The **agent routes** (`/ra/epoch`, `/ra/enroll`, `/ra/heartbeat`,
`/ra/poll`, `/ra/result`) require the hub Bearer; the last four additionally
require an agent-signed proof (see the security model). The **control routes**
(`/ra/agents`, `/ra/execute`, `/ra/await`) require the
control credential (`AETHER_RA_CONTROL_TOKEN`); the shared hub Bearer is
rejected (401) there, and the routes **fail closed** — with no control token
configured, every request is rejected (401).

## Tool availability on the daemon

The daemon exposes the real built-in tool registry **minus** the control-plane
tools that require a full session server (LLM, DB, EventStore, interactive UI):
`ask_user`, `session_metadata`, `mcp_config`, `call_sub_agent`, `workspace`,
`project_tasks`, `step_done`, `remote_agents`. Everything else
(`read_file`, `describe_image`, `write_file`, `edit_file`, `run_command`,
`load_skill`, `web_fetch`, `web_search`, `dev_server`, `background_process`,
`return_value`) runs on the remote machine.

The daemon runs tools in `dangerous` mode (no UI client to confirm against);
the security boundary is "you connected to this daemon" (hub enrollment +
signed envelopes), not per-path confirmation.

## Tests

- **OpenFoxFork** — `src/server/remote-agent/remote-agent.test.ts` (identity,
  context, `remote` param, serialization, injective length-prefix encoding,
  Unicode raw-byte `extra`, epoch binding), `client.test.ts` (hub client,
  target validation), `e2e.test.ts` (real hub + daemon + client loop,
  including a full-loop **Unicode round-trip** of metadata and results, and a
  **captured-enrollment replay after a hub restart** (epoch, within window);
  run
  with `E2E_HUB_BIN=<cargo build output>`), and the remote-routing cases in
  `src/server/chat/execute-tools.test.ts`.
- **llm-aether** — `cargo test` covers Ed25519 sign/verify, envelope
  sign/verify, scoped-token single-use/scoping, headless-agent enrollment
  (full payload incl. the hub epoch), liveness, the execution relay, the
  (session, agent) request binding, single-resolution (a retried result cannot
  overwrite the first), the **injective canonical encoding** (no delimiter
  collision), the **hub epoch** (a replayed proof AND a replayed enrollment are
  rejected after a hub restart even with an empty nonce cache), and
  **fail-closed control routes** (no control token → 401 for everything).

## Deployment

1. Build/deploy the new aether hub (`llm-aether`) to the hub host
   (`192.168.71.132:4175`).
2. On each remote machine, install the `openfox` binary and start the
   headless-agent daemon (`openfox remote-agent …`).
3. On the local machine, configure `remoteAgent` in the global config and
   restart the OpenFox server.
4. In a session, call `remote_agents` to discover agents, then use the `remote`
   argument of environment tools to execute on them.
