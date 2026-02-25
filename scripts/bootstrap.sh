#!/bin/bash
#
# Scalebox Bootstrap Installer
#
# One-line install:
#   curl -sSL https://raw.githubusercontent.com/The-Agentic-Journey/Scalebox/main/scripts/bootstrap.sh | sudo bash
#
# Or with domains pre-set:
#   curl -sSL ... | sudo BASE_DOMAIN=scalebox.example.com bash
#
set -euo pipefail

REPO="The-Agentic-Journey/Scalebox"
INSTALL_DIR="/tmp/scalebox-install-$$"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[scalebox]${NC} $1"; }
warn() { echo -e "${YELLOW}[scalebox]${NC} $1"; }
error() { echo -e "${RED}[scalebox]${NC} ERROR: $1" >&2; }
die() { error "$1"; exit 1; }

# Cleanup on exit
cleanup() {
  rm -rf "$INSTALL_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Check if running as root
check_root() {
  if [[ $EUID -ne 0 ]]; then
    die "This script must be run as root. Try: curl ... | sudo bash"
  fi
}

# Check for required commands
check_deps() {
  local missing=()
  for cmd in curl jq; do
    if ! command -v "$cmd" &>/dev/null; then
      missing+=("$cmd")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    log "Installing missing dependencies: ${missing[*]}"
    apt-get update -qq
    apt-get install -y -qq "${missing[@]}"
  fi
}

# Prompt for input with default value
# Note: reads from /dev/tty to work when script is piped (curl | bash)
prompt() {
  local prompt_text=$1
  local default=${2:-}
  local value=""

  if [[ -n "$default" ]]; then
    read -r -p "$prompt_text [$default]: " value < /dev/tty
    value="${value:-$default}"
  else
    read -r -p "$prompt_text: " value < /dev/tty
  fi

  echo "$value"
}

# Interactive configuration
configure() {
  echo ""
  echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║              Scalebox Interactive Setup                   ║${NC}"
  echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
  echo ""

  if [[ -z "${BASE_DOMAIN:-}" ]]; then
    echo "Scalebox needs a base domain for HTTPS access."
    echo "This domain should have an NS record pointing to this server."
    echo ""
    echo "The API will be at:  api.{base-domain}"
    echo "VMs will be at:      {vm-name}.vm.{base-domain}"
    echo ""
    echo "Example: scalebox.example.com"
    echo ""
    BASE_DOMAIN=$(prompt "Enter base domain (or press Enter to skip HTTPS)")
  fi

  # HOST_IP - external IP for API responses (from Plan 025)
  if [[ -z "${HOST_IP:-}" ]]; then
    local detected_ip
    detected_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    echo ""
    echo "Scalebox includes the server's IP address in API responses"
    echo "so clients know where to connect via SSH."
    echo "On cloud VMs (GCE, AWS), use the public IP, not the VPC-internal IP."
    echo ""
    HOST_IP=$(prompt "Enter host IP" "${detected_ip:-}")
  fi

  echo ""
}

# Get latest release URL
get_latest_release() {
  # Allow override for testing
  if [[ -n "${SCALEBOX_RELEASE_URL:-}" ]]; then
    echo "$SCALEBOX_RELEASE_URL"
    return
  fi

  local api_url="https://api.github.com/repos/$REPO/releases/latest"
  local download_url

  download_url=$(curl -sSL "$api_url" | jq -r '.assets[] | select(.name | endswith(".tar.gz")) | .browser_download_url' | head -1)

  if [[ -z "$download_url" || "$download_url" == "null" ]]; then
    die "Could not find latest release. Check https://github.com/$REPO/releases"
  fi

  echo "$download_url"
}

# Download and extract release
download_release() {
  local url=$1

  log "Downloading latest release..."
  mkdir -p "$INSTALL_DIR"
  curl -sSL "$url" | tar -xz -C "$INSTALL_DIR"

  # Verify files exist
  if [[ ! -f "$INSTALL_DIR/install.sh" ]]; then
    die "Invalid release archive - install.sh not found"
  fi
}

# Run the actual installer
run_installer() {
  log "Running installer..."
  echo ""

  # Export config for install.sh
  export BASE_DOMAIN="${BASE_DOMAIN:-}"
  export HOST_IP="${HOST_IP:-}"
  # Backward compatibility: old install.sh scripts use API_DOMAIN and VM_DOMAIN.
  # When check-update bootstraps with the old release tarball, the old install.sh
  # reads these vars. Derive them from BASE_DOMAIN for backward compat.
  export API_DOMAIN="${BASE_DOMAIN:+api.$BASE_DOMAIN}"
  export VM_DOMAIN="${BASE_DOMAIN:+vm.$BASE_DOMAIN}"
  export INSTALL_DIR

  # Run install.sh
  bash "$INSTALL_DIR/install.sh"
}

# Main
main() {
  echo ""
  echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║                      Scalebox                             ║${NC}"
  echo -e "${GREEN}║         Instant sandbox VMs for AI agents                 ║${NC}"
  echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
  echo ""

  check_root
  check_deps

  # Interactive config if not pre-set
  if [[ ( -z "${BASE_DOMAIN:-}" || -z "${HOST_IP:-}" ) && -z "${SCALEBOX_NONINTERACTIVE:-}" ]]; then
    configure
  fi

  # Get and download latest release
  log "Fetching latest release from GitHub..."
  local release_url
  release_url=$(get_latest_release)
  log "Found: $release_url"

  download_release "$release_url"
  run_installer
}

main "$@"
