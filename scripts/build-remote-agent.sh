#!/bin/sh
set -e
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(node -p "require('$root/package.json').version")
outfile=${1:-"$root/dist-bin/remote-agent"}
mkdir -p "$(dirname "$outfile")"
target=${REMOTE_AGENT_BUN_TARGET:-}
entry="$root/src/cli/remote-agent-bin.ts"
# Keep native addons inside the compile graph (do not mark them external):
# otherwise bun resolves sqlite at startup and --help fails without node_modules.
define_version="OPENFOX_RA_VERSION=\"${version}\""
if [ -n "$target" ]; then
  bun build --compile --target "$target" \
    --define "$define_version" \
    --outfile "$outfile" \
    "$entry"
else
  bun build --compile \
    --define "$define_version" \
    --outfile "$outfile" \
    "$entry"
fi
