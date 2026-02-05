#!/bin/bash
#
# Scalebox CLI (sb) Installer
#
# Installs sb to ~/.local/bin for the current user.
# Does NOT require root. Does NOT install the server.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/The-Agentic-Journey/Scalebox/main/scripts/install-sb.sh | bash
#
set -euo pipefail

INSTALL_DIR="${SCALEBOX_INSTALL_DIR:-$HOME/.local/bin}"
REPO="The-Agentic-Journey/Scalebox"
RELEASE_URL="https://api.github.com/repos/$REPO/releases/latest"

log() { echo "[scalebox] $1"; }
die() { echo "[scalebox] ERROR: $1" >&2; exit 1; }

# Check for required tools
check_deps() {
  command -v curl &>/dev/null || die "curl is required"
  command -v jq &>/dev/null || {
    log "jq not found. Attempting to install..."
    install_jq
  }
}

# Install jq to user directory if not present
install_jq() {
  local arch
  arch=$(uname -m)
  case "$arch" in
    x86_64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) die "Unsupported architecture: $arch" ;;
  esac

  local os
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  [[ "$os" == "darwin" ]] && os="macos"

  local jq_url="https://github.com/jqlang/jq/releases/latest/download/jq-${os}-${arch}"

  mkdir -p "$INSTALL_DIR"
  log "Downloading jq..."
  if curl -fsSL "$jq_url" -o "$INSTALL_DIR/jq"; then
    chmod +x "$INSTALL_DIR/jq"
    export PATH="$INSTALL_DIR:$PATH"
    log "jq installed to $INSTALL_DIR/jq"
  else
    die "Failed to download jq. Please install jq manually: https://jqlang.github.io/jq/download/"
  fi
}

# Get latest release download URL
get_release_url() {
  local release_info
  release_info=$(curl -fsSL "$RELEASE_URL") || die "Failed to fetch release info"

  local tarball_url
  tarball_url=$(echo "$release_info" | jq -r '.assets[0].browser_download_url // empty')

  [[ -n "$tarball_url" ]] || die "No release assets found"
  echo "$tarball_url"
}

# Download and extract sb
install_sb() {
  local tarball_url
  tarball_url=$(get_release_url)

  log "Downloading from $tarball_url..."

  local tmp_dir
  tmp_dir=$(mktemp -d)
  trap "rm -rf $tmp_dir" EXIT

  curl -fsSL "$tarball_url" | tar -xz -C "$tmp_dir"

  # Find sb in extracted files
  local sb_path
  sb_path=$(find "$tmp_dir" -name "sb" -type f | head -1)
  [[ -n "$sb_path" ]] || die "sb not found in release tarball"

  mkdir -p "$INSTALL_DIR"
  cp "$sb_path" "$INSTALL_DIR/sb"
  chmod +x "$INSTALL_DIR/sb"

  log "Installed sb to $INSTALL_DIR/sb"
}

# Ensure install dir is in PATH
setup_path() {
  if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
    log "Adding $INSTALL_DIR to PATH..."

    local shell_rc=""
    if [[ -n "${BASH_VERSION:-}" ]]; then
      shell_rc="$HOME/.bashrc"
    elif [[ -n "${ZSH_VERSION:-}" ]]; then
      shell_rc="$HOME/.zshrc"
    fi

    if [[ -n "$shell_rc" && -f "$shell_rc" ]]; then
      if ! grep -q "$INSTALL_DIR" "$shell_rc" 2>/dev/null; then
        echo "" >> "$shell_rc"
        echo "# Added by Scalebox CLI installer" >> "$shell_rc"
        echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$shell_rc"
        log "Added PATH to $shell_rc"
      fi
    fi

    echo ""
    echo "  Run this to use sb now:"
    echo "    export PATH=\"$INSTALL_DIR:\$PATH\""
    echo ""
    echo "  Or start a new shell."
  fi
}

# Verify installation
verify() {
  if "$INSTALL_DIR/sb" version &>/dev/null; then
    log "Installation verified!"
    echo ""
    "$INSTALL_DIR/sb" version
    echo ""
    echo "  Get started:"
    echo "    sb login"
    echo "    sb help"
    echo ""
  else
    die "Installation verification failed"
  fi
}

main() {
  echo ""
  echo "  ╔═══════════════════════════════════════╗"
  echo "  ║       Scalebox CLI Installer          ║"
  echo "  ╚═══════════════════════════════════════╝"
  echo ""

  check_deps
  install_sb
  setup_path
  verify
}

main "$@"
