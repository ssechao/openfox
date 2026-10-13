#!/bin/sh
# Run the full test suite (unit + e2e) in a container on a remote Docker host.
#
# Why this exists: the pre-commit hook used to run the whole suite on whichever
# machine was committing. On a host that is already busy — or simply slower than
# the suite's own fixed timeouts assume — it fails on flakes that pass in
# isolation, and the commit is refused for reasons that have nothing to do with
# the change. Delegating to an idle host keeps the gate meaningful.
#
# This is a stopgap: the target is to move the suite to CI and let the hook run
# only the static gates.
#
# Configuration (per clone, never committed):
#   git config openfox.testRemote <ssh-host>      e.g. ssechao@192.168.71.122
# Overrides: OPENFOX_TEST_HOST, OPENFOX_TEST_REMOTE_DIR, OPENFOX_TEST_IMAGE,
#   OPENFOX_TEST_USER, OPENFOX_E2E_MAX_WORKERS
set -eu

HOST=${OPENFOX_TEST_HOST:-$(git config --get openfox.testRemote 2>/dev/null || true)}
if [ -z "${HOST:-}" ]; then
  echo "test-remote: no test host configured." >&2
  echo "  Set one with: git config openfox.testRemote <ssh-host>" >&2
  exit 1
fi

DIR=${OPENFOX_TEST_REMOTE_DIR:-/tmp/openfox-precommit}
IMAGE=${OPENFOX_TEST_IMAGE:-node:24-bookworm}
RUN_USER=${OPENFOX_TEST_USER:-node}
WORKERS=${OPENFOX_E2E_MAX_WORKERS:-4}
SSH="ssh -o BatchMode=yes"

if ! $SSH -o ConnectTimeout=8 "$HOST" true 2>/dev/null; then
  echo "test-remote: cannot reach $HOST over ssh (BatchMode)." >&2
  exit 1
fi

if ! $SSH "$HOST" 'docker info >/dev/null 2>&1'; then
  echo "test-remote: docker is not usable on $HOST." >&2
  exit 1
fi

echo "  Running the suite on $HOST ($IMAGE)..."
$SSH "$HOST" "mkdir -p '$DIR'"

# --delete keeps the remote tree identical to this one; the excludes are the
# artefacts that must survive it (dependencies) or that the suite never reads.
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude .git \
  --exclude .playwright-cli --exclude '*.tgz' \
  ./ "$HOST:$DIR/"

# First run only: install the dependencies the image does not ship. npm 11
# leaves the install scripts of esbuild/node-pty/core-js ungated unless they
# are rebuilt explicitly, and the suite must own its files (vitest writes a
# cache next to them), hence the chown to the container user.
if ! $SSH "$HOST" "test -d '$DIR/node_modules'"; then
  echo "  Bootstrapping dependencies on $HOST (first run only)..."
  $SSH "$HOST" "docker run --rm -v '$DIR:/work' -w /work '$IMAGE' sh -c 'npm ci --no-audit --no-fund >/dev/null 2>&1 && npm rebuild esbuild node-pty core-js >/dev/null 2>&1 && chown -R 1000:1000 /work'" || {
    echo "test-remote: dependency bootstrap failed on $HOST." >&2
    exit 1
  }
fi

# The exit code is the suite's: ssh forwards the container's status.
$SSH "$HOST" "docker run --rm --user '$RUN_USER' -v '$DIR:/work' -w /work '$IMAGE' sh -c 'OPENFOX_E2E_MAX_WORKERS=$WORKERS npm test'"
