# Aether Memory — operator portal (cross-repo reference)

## Why this document exists

The authenticated, dark-mode operator portal for the shared Aether Memory
knowledge base (login screen, dashboard, proposals/entries/collections/audit
screens) has **zero code footprint in this repository (OpenFoxFork)**. It was
built entirely inside the sibling repository `llm-aether`, specifically its
`memory-service/` subdirectory — a standalone Fastify + Postgres/pgvector
service that is architecturally separate from OpenFox (see
`docs/rag-memory-security.md`-equivalent design note in that repo, and the
shared-memory client code under `src/server/memory/` here, which is the only
part of this feature that _does_ live in OpenFoxFork).

An OpenFox session/workflow scoped to this repo cannot discover or verify
code that lives in another git repository by inspecting `git status`,
`git diff`, or `git log` here — there is nothing to find, by design, because
the portal is server-side UI for a different service. This file is the
durable, git-tracked pointer that makes the relationship auditable from
within this repo's own history, and gives a reproducible way to verify the
work without needing a session scoped to `llm-aether`.

## Where the code actually lives

Repository: `github.com:ssechao/llm-aether` (sibling checkout at
`../llm-aether` relative to this repo in the usual local layout, i.e.
`~/Source/github.com/llm-aether`), directory `memory-service/`.

Relevant commits on `main` (chronological):

| Commit     | Summary                                                    |
| ---------- | ---------------------------------------------------------- |
| `a2b0cbd5` | Phase 1 of shared Aether Memory (lexical MVP)              |
| `56c1c693` | Contract versioning, portal modify/merge, two-peer e2e     |
| `1e115829` | Hybrid lexical+vector ranking                              |
| `6b648244` | **Authenticated dark-mode operator portal** (this feature) |

Files added/changed by `6b648244`:

- `memory-service/admin-ui/index.html` — the entire real portal: one static
  file (inline `<style>` + two inline `<script>` blocks), served by the
  pre-existing `GET /admin/ui` route in `memory-service/src/server.ts`. No
  bundler, no new npm dependency, no Dockerfile/docker-compose change.
- `memory-service/mockups/{login,dashboard,proposals,entries,collections,audit}.html`
  - `mockup.css` — the static, mutually-linked mockups approved before the
    real portal was built, kept as a design reference (not served by the
    server, not copied into the Docker image).
- `memory-service/src/routes/admin.ts` — new `GET /admin/entries`,
  `GET /admin/entries/:id`, `GET /admin/config` routes, plus a `409
collection_exists` response on duplicate collection names.
- `memory-service/test/admin-portal.test.ts` — 18 tests for the above,
  run against a real disposable Postgres/pgvector container.

## How to verify without this session

From a machine with access to the `llm-aether` repo and the `.132` LAN:

```bash
cd ~/Source/github.com/llm-aether/memory-service
git log --oneline -1                 # 6b648244 feat(memory-portal): ...
npm test                             # 65/65 passing (7 files), real Postgres via docker compose
npm run typecheck && npm run lint    # both clean

# Live deployment (.132:4176, separate from the llm-aether hub on .132:4175)
curl -s http://192.168.71.132:4176/health
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.71.132:4176/admin/ui
```

The portal itself was additionally click-tested end-to-end with a real
headless browser (Playwright) during development: login (wrong token →
inline error, correct token → persists across a real page reload, logout),
dashboard counts and links, proposals tabs/edit/approve/reject-with-reason,
entries filters/archive/merge-search-picker/re-embed, collection creation
with a duplicate-name 409, and audit filter/pagination — including two real
bugs found and fixed this way (a login-401 mishandled as a network error,
and a request-race between "Load more" and filtering).

## Why criteria for this feature were tracked in an OpenFoxFork session

This is a process note, not a code note: the acceptance criteria for the
portal were authored and tracked in an OpenFox session whose project is this
repository, even though the resulting implementation is 100% server-side
code in `llm-aether/memory-service`. Earlier, related criteria (the RAG
memory client, the `shared_memory` tool, the pre-turn retrieval injection —
see `src/server/memory/`, `src/server/tools/shared-memory.ts`,
`src/server/chat/shared-memory-context.ts`) _do_ have real code in this
repo, which is why those were verifiable directly here. The portal criteria
have no such counterpart change in OpenFoxFork; this document is the
intentional bridge so the work stays auditable from this repo's git history
instead of being an unverifiable claim.
