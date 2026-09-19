#!/bin/sh
set -e

GITHUB_REPO="ssechao/openfox"
BINARY_NAME="remote-agent"

log() { printf '%s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; exit 1; }

detect_platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Linux)
      case "$arch" in
        x86_64|amd64) printf '%s\n' "linux-x64" ;;
        aarch64|arm64) printf '%s\n' "linux-arm64" ;;
        *) err "Unsupported architecture: $arch" ;;
      esac
      ;;
    Darwin)
      case "$arch" in
        x86_64) printf '%s\n' "darwin-x64" ;;
        arm64) printf '%s\n' "darwin-arm64" ;;
        *) err "Unsupported architecture: $arch" ;;
      esac
      ;;
    *)
      err "Unsupported OS: $os"
      ;;
  esac
}

path_has_dir() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

pick_install_dir() {
  if [ -n "${REMOTE_AGENT_INSTALL_DIR:-}" ]; then
    printf '%s\n' "$REMOTE_AGENT_INSTALL_DIR"
    return
  fi
  home_bin="${HOME}/.local/bin"
  usr_bin="/usr/local/bin"
  if [ "$(id -u)" = 0 ] && [ -d "$usr_bin" ] && [ -w "$usr_bin" ]; then
    printf '%s\n' "$usr_bin"
    return
  fi
  if path_has_dir "$home_bin" && mkdir -p "$home_bin" 2>/dev/null && [ -w "$home_bin" ]; then
    printf '%s\n' "$home_bin"
    return
  fi
  if [ -d "$usr_bin" ] && [ -w "$usr_bin" ]; then
    printf '%s\n' "$usr_bin"
    return
  fi
  mkdir -p "$home_bin" || err "Cannot create $home_bin"
  printf '%s\n' "$home_bin"
}

download() {
  url=$1
  dest=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 15 --max-time 120 "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 120 "$url" -O "$dest"
  else
    err "Need curl or wget"
  fi
}

resolve_asset_url() {
  platform=$1
  asset="${BINARY_NAME}-${platform}"
  if [ -n "${REMOTE_AGENT_BASE_URL:-}" ]; then
    printf '%s\n' "${REMOTE_AGENT_BASE_URL%/}/${asset}"
    return
  fi
  tag=${REMOTE_AGENT_VERSION:-}
  if [ -z "$tag" ]; then
    api="https://api.github.com/repos/${GITHUB_REPO}/releases"
    json=$(curl -fsSL "$api" 2>/dev/null || wget -qO- "$api") || err "Failed to list GitHub releases"
    tag=$(printf '%s\n' "$json" | grep -o '"tag_name": *"[^"]*"' | sed 's/.*"tag_name": *"//;s/"$//' | grep '^remote-agent-v' | head -n 1)
    [ -n "$tag" ] || err "No remote-agent-v* GitHub release found in ${GITHUB_REPO}"
  fi
  printf '%s\n' "https://github.com/${GITHUB_REPO}/releases/download/${tag}/${asset}"
}

platform=$(detect_platform)
install_dir=$(pick_install_dir)
mkdir -p "$install_dir" || err "Cannot create $install_dir"
url=$(resolve_asset_url "$platform")
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
log "Downloading ${BINARY_NAME} (${platform})..."
download "$url" "$tmp"
chmod +x "$tmp"
dest="${install_dir}/${BINARY_NAME}"
mv "$tmp" "$dest"
trap - EXIT
if [ "$(uname -s)" = Darwin ]; then
  xattr -d com.apple.quarantine "$dest" 2>/dev/null || true
fi
log "Installed ${dest}"
if ! "$dest" --help >/dev/null 2>&1; then
  err "Installed binary failed --help: $dest"
fi
case ":$PATH:" in
  *":${install_dir}:"*) ;;
  *)
    log "Add ${install_dir} to PATH:"
    log "  export PATH=\"${install_dir}:\$PATH\""
    ;;
esac
log "Run: ${dest} --help"
