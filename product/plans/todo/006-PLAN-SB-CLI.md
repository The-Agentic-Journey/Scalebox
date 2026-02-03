# SB CLI: Rename, Login Flow, and Test Integration

## Overview

Transform the `scalebox` CLI into `sb` with:
1. **Login flow** (`sb login`) that stores host + token in user-level config
2. **Machine-readable output** (`--json` flag) for reliable test parsing
3. **User-level installation** via one-liner (no root required for client-only install)
4. **Incremental test migration** to use CLI instead of direct HTTP API calls

This plan also creates ADR-013 documenting the CLI authentication approach.

---

## Goals

| Goal | Benefit |
|------|---------|
| Rename to `sb` | Easier to type, memorable |
| `sb login` flow | Standard UX for CLI tools, multi-host support |
| User-level config | Works without root, per-user settings |
| `--json` output | Reliable parsing for tests and scripts |
| CLI-based tests | Tests the full stack, not just HTTP API |
| One-liner install | Easy client installation from GitHub releases |

---

## Non-Goals

- Multiple concurrent host profiles (like kubectl contexts) - single host for now
- Shell completions - can add later
- Compiled binary - stay with bash for simplicity

---

## Naming Convention

- **CLI binary**: `sb` (the only place this abbreviation is used)
- **Config directory**: `~/.config/scalebox/`
- **Environment variables**: `SCALEBOX_HOST`, `SCALEBOX_TOKEN`, `SCALEBOX_CONFIG_DIR`, `SCALEBOX_JSON`
- **System config**: `/etc/scalebox/config` (unchanged)

---

## Phase 1: Create ADR-013 for CLI Authentication

**Goal**: Document the architectural decision for CLI authentication pattern.

### New file: `product/ADR/013-cli-authentication.md`

```markdown
# ADR-013: CLI Authentication and Configuration

## Status

Accepted

## Context

The Scalebox CLI needs to authenticate against the API server. ADR-008 established bearer token authentication for the API itself. This ADR addresses how the CLI obtains and stores credentials.

Use cases:
1. **Server-side admin**: Running `sb` on the same machine as `scaleboxd`
2. **Remote client**: Running `sb` from a developer workstation against a remote server
3. **CI/CD automation**: Running `sb` in scripts without interactive prompts
4. **Testing**: Running `sb` with isolated config to avoid affecting user settings

## Decision

### Configuration Hierarchy

The CLI reads configuration from multiple sources with clear precedence (highest to lowest):

1. **CLI flags**: `--host`, `--token` (not implemented initially, reserved for future)
2. **Environment variables**: `SCALEBOX_HOST`, `SCALEBOX_TOKEN`
3. **User config file**: `~/.config/scalebox/config`
4. **System config file**: `/etc/scalebox/config` (for server-side usage)

The config directory can be overridden via `SCALEBOX_CONFIG_DIR` environment variable, enabling isolated testing.

### Config File Format

Shell-sourceable format for simplicity:

```
SCALEBOX_HOST=https://api.example.com:8080
SCALEBOX_TOKEN=sb-abc123...
```

### Login Flow

`sb login` provides interactive and non-interactive modes:

```bash
# Interactive (prompts for host and token)
sb login

# Non-interactive (for scripts)
sb login --host https://api.example.com --token-stdin < token.txt
```

Token input is masked during interactive prompt. The `--token-stdin` flag reads from stdin to avoid exposing tokens in process lists or shell history.

### Security Measures

- Config file created with mode 600 (owner read/write only)
- Config directory created with mode 700
- Tokens never passed as command-line arguments (use `--token-stdin` or interactive prompt)
- `sb config show` masks tokens by default

## Consequences

### Positive

- Standard UX familiar from other CLI tools (gh, aws, gcloud)
- Works for both local server admin and remote client usage
- Testable with isolated config directories
- No root required for client-only installation

### Negative

- Two config file locations to understand (user vs system)

### Backward Compatibility

The existing `SCALEBOX_URL` environment variable is mapped to `SCALEBOX_HOST` internally for backward compatibility.
```

### Verification

- File exists at `product/ADR/013-cli-authentication.md`
- Content matches the architectural approach

---

## Phase 2: Create New CLI with Login Flow

**Goal**: Create `sb` CLI with login command and config management.

### New file: `scripts/sb`

```bash
#!/bin/bash
set -euo pipefail

# === Configuration ===
# Config directory (can be overridden for testing)
SCALEBOX_CONFIG_DIR="${SCALEBOX_CONFIG_DIR:-$HOME/.config/scalebox}"
SCALEBOX_CONFIG_FILE="$SCALEBOX_CONFIG_DIR/config"

# Load config from multiple sources (in precedence order)
load_config() {
  # 1. Environment variables (highest priority) - already set
  # 2. User config file
  if [[ -z "${SCALEBOX_HOST:-}" || -z "${SCALEBOX_TOKEN:-}" ]] && [[ -f "$SCALEBOX_CONFIG_FILE" ]]; then
    # shellcheck source=/dev/null
    source "$SCALEBOX_CONFIG_FILE"
  fi
  # 3. System config file (lowest priority, for server-side usage)
  if [[ -z "${SCALEBOX_HOST:-}" ]] && [[ -f /etc/scalebox/config ]]; then
    SCALEBOX_HOST="http://localhost:8080"
    if [[ -z "${SCALEBOX_TOKEN:-}" ]]; then
      SCALEBOX_TOKEN=$(grep -E "^API_TOKEN=" /etc/scalebox/config 2>/dev/null | cut -d= -f2- || true)
    fi
  fi
  # 4. Legacy environment variable support
  if [[ -n "${SCALEBOX_URL:-}" && -z "${SCALEBOX_HOST:-}" ]]; then
    SCALEBOX_HOST="$SCALEBOX_URL"
  fi
}

# === Helpers ===
die() { echo "Error: $1" >&2; exit 1; }
need_jq() { command -v jq &>/dev/null || die "jq is required. Install with: apt install jq (or brew install jq)"; }
need_config() {
  [[ -n "${SCALEBOX_HOST:-}" ]] || die "Not logged in. Run 'sb login' first or set SCALEBOX_HOST."
  [[ -n "${SCALEBOX_TOKEN:-}" ]] || die "No token configured. Run 'sb login' first or set SCALEBOX_TOKEN."
}

# === API Client ===
api() {
  local method=$1 path=$2; shift 2
  local response http_code

  # Capture both response body and HTTP status code
  response=$(curl -sf -w "\n%{http_code}" -X "$method" \
    -H "Authorization: Bearer $SCALEBOX_TOKEN" \
    -H "Content-Type: application/json" \
    "$@" "${SCALEBOX_HOST}${path}" 2>/dev/null) || {
    # curl failed (connection error, etc)
    echo '{"error":"Connection failed","status":0}'
    return 1
  }

  http_code=$(echo "$response" | tail -n1)
  response=$(echo "$response" | sed '$d')

  if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
    echo "$response"
    return 0
  else
    # Return error with status code for --json mode
    if [[ -n "$response" ]]; then
      echo "$response" | jq -c ". + {status: $http_code}" 2>/dev/null || echo "{\"error\":\"HTTP $http_code\",\"status\":$http_code}"
    else
      echo "{\"error\":\"HTTP $http_code\",\"status\":$http_code}"
    fi
    return 1
  fi
}

# === Output Formatting ===
JSON_OUTPUT="${SCALEBOX_JSON:-false}"

output_table() {
  local jq_filter="$1"
  if [[ "$JSON_OUTPUT" == "true" ]]; then
    jq .
  else
    jq -r "$jq_filter" | column -t 2>/dev/null || cat
  fi
}

output_single() {
  if [[ "$JSON_OUTPUT" == "true" ]]; then
    jq -c .
  else
    jq .
  fi
}

output_message() {
  local message="$1"
  if [[ "$JSON_OUTPUT" == "true" ]]; then
    jq -n --arg msg "$message" '{message: $msg}'
  else
    echo "$message"
  fi
}

output_error() {
  local message="$1"
  local status="${2:-1}"
  if [[ "$JSON_OUTPUT" == "true" ]]; then
    jq -n --arg msg "$message" --argjson status "$status" '{error: $msg, status: $status}'
  else
    echo "Error: $message" >&2
  fi
  return 1
}

# === Commands ===

cmd_login() {
  local host="" token="" token_stdin=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --host) host="$2"; shift 2 ;;
      --token-stdin) token_stdin=true; shift ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  # Interactive mode if host not provided
  if [[ -z "$host" ]]; then
    echo -n "Scalebox host URL: "
    read -r host
  fi
  [[ -n "$host" ]] || die "Host URL is required"

  # Validate URL format (basic check)
  [[ "$host" =~ ^https?:// ]] || die "Host must start with http:// or https://"

  # Remove trailing slash
  host="${host%/}"

  # Get token
  if [[ "$token_stdin" == "true" ]]; then
    read -r token
  else
    echo -n "API token: "
    read -rs token
    echo  # newline after hidden input
  fi
  [[ -n "$token" ]] || die "Token is required"

  # Test connection
  echo "Testing connection..."
  if ! curl -sf -H "Authorization: Bearer $token" "$host/health" >/dev/null 2>&1; then
    die "Failed to connect to $host. Check the URL and token."
  fi

  # Create config directory with secure permissions
  # Note: mkdir -p creates parent dirs (e.g., ~/.config) if they don't exist
  mkdir -p "$SCALEBOX_CONFIG_DIR"
  chmod 700 "$SCALEBOX_CONFIG_DIR"

  # Write config with secure permissions
  (
    umask 077
    cat > "$SCALEBOX_CONFIG_FILE" <<EOF
SCALEBOX_HOST=$host
SCALEBOX_TOKEN=$token
EOF
  )

  output_message "Logged in to $host"
}

cmd_logout() {
  if [[ -f "$SCALEBOX_CONFIG_FILE" ]]; then
    rm -f "$SCALEBOX_CONFIG_FILE"
    output_message "Logged out (config removed)"
  else
    output_message "Not logged in (no config file)"
  fi
}

cmd_config_show() {
  local show_token=false
  [[ "${1:-}" == "--show-token" ]] && show_token=true

  local display_token
  if [[ "$show_token" == "true" ]]; then
    display_token="${SCALEBOX_TOKEN:-}"
  else
    # Mask token: show first 6 and last 4 chars
    if [[ -n "${SCALEBOX_TOKEN:-}" && ${#SCALEBOX_TOKEN} -gt 10 ]]; then
      display_token="${SCALEBOX_TOKEN:0:6}...${SCALEBOX_TOKEN: -4}"
    else
      display_token="${SCALEBOX_TOKEN:-}"
    fi
  fi

  if [[ "$JSON_OUTPUT" == "true" ]]; then
    jq -n \
      --arg host "${SCALEBOX_HOST:-}" \
      --arg token "$display_token" \
      --arg config_dir "$SCALEBOX_CONFIG_DIR" \
      '{host: $host, token: $token, config_dir: $config_dir}'
  else
    echo "Host:       ${SCALEBOX_HOST:-<not set>}"
    echo "Token:      ${display_token:-<not set>}"
    echo "Config dir: $SCALEBOX_CONFIG_DIR"
    if [[ -f "$SCALEBOX_CONFIG_FILE" ]]; then
      echo "Config file: $SCALEBOX_CONFIG_FILE (exists)"
    else
      echo "Config file: $SCALEBOX_CONFIG_FILE (not found)"
    fi
  fi
}

cmd_status() {
  local response
  if response=$(curl -sf "${SCALEBOX_HOST:-http://localhost:8080}/health" 2>/dev/null); then
    if [[ "$JSON_OUTPUT" == "true" ]]; then
      echo "$response" | jq -c '. + {status: 200}'
    else
      echo "$response" | jq .
    fi
  else
    output_error "Cannot connect to ${SCALEBOX_HOST:-http://localhost:8080}" 0
  fi
}

cmd_vm_list() {
  need_config
  local response
  if response=$(api GET /vms); then
    # Note: adds .name column (not in old scalebox CLI which showed: id, template, ip, ssh_port)
    echo "$response" | output_table '.vms[] | [.name, .id, .template, .ip, .ssh_port] | @tsv'
  else
    echo "$response"
    return 1
  fi
}

cmd_vm_create() {
  need_config
  local template="" key="" key_file=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -t|--template) template="$2"; shift 2 ;;
      -k|--key)
        if [[ "$2" == @* ]]; then
          # @filepath syntax - read from file
          key_file="${2:1}"
          [[ -f "$key_file" ]] || die "Key file not found: $key_file"
          key=$(cat "$key_file")
        else
          key="$2"
        fi
        shift 2
        ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  [[ -n "$template" ]] || die "Template required: -t TEMPLATE"
  [[ -n "$key" ]] || die "SSH key required: -k 'ssh-rsa ...' or -k @/path/to/key.pub"

  local response
  if response=$(api POST /vms -d "$(jq -n --arg t "$template" --arg k "$key" '{template:$t,ssh_public_key:$k}')"); then
    echo "$response" | output_single
  else
    echo "$response"
    return 1
  fi
}

cmd_vm_get() {
  need_config
  local id="${1:-}"
  [[ -n "$id" ]] || die "Usage: sb vm get <name|id>"

  local response
  if response=$(api GET "/vms/$id"); then
    echo "$response" | output_single
  else
    echo "$response"
    return 1
  fi
}

cmd_vm_delete() {
  need_config
  local id="${1:-}"
  [[ -n "$id" ]] || die "Usage: sb vm delete <name|id>"

  local response
  if response=$(api DELETE "/vms/$id"); then
    output_message "Deleted $id"
  else
    echo "$response"
    return 1
  fi
}

cmd_vm_snapshot() {
  need_config
  local id="${1:-}"
  local name=""
  shift || true

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -n|--name) name="$2"; shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  [[ -n "$id" ]] || die "Usage: sb vm snapshot <name|id> -n TEMPLATE_NAME"
  [[ -n "$name" ]] || die "Template name required: -n NAME"

  local response
  if response=$(api POST "/vms/$id/snapshot" -d "$(jq -n --arg n "$name" '{template_name:$n}')"); then
    echo "$response" | output_single
  else
    echo "$response"
    return 1
  fi
}

cmd_vm_wait() {
  need_config
  local id="${1:-}"
  local wait_ssh=false
  local timeout=60
  shift || true

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ssh) wait_ssh=true; shift ;;
      --timeout) timeout="$2"; shift 2 ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  [[ -n "$id" ]] || die "Usage: sb vm wait <name|id> --ssh [--timeout SECONDS]"
  [[ "$wait_ssh" == "true" ]] || die "Must specify --ssh (only supported wait condition)"

  # Get VM details
  local vm_data ssh_port
  vm_data=$(api GET "/vms/$id") || die "VM not found: $id"
  ssh_port=$(echo "$vm_data" | jq -r '.ssh_port')

  # Extract host from SCALEBOX_HOST (remove protocol and port)
  local ssh_host
  ssh_host=$(echo "$SCALEBOX_HOST" | sed -E 's|^https?://||; s|:[0-9]+$||')

  local start=$SECONDS
  while (( SECONDS - start < timeout )); do
    if nc -z -w1 "$ssh_host" "$ssh_port" 2>/dev/null; then
      output_message "SSH ready on port $ssh_port"
      return 0
    fi
    sleep 1
  done

  output_error "Timeout waiting for SSH on port $ssh_port after ${timeout}s" 1
}

cmd_template_list() {
  need_config
  local response
  if response=$(api GET /templates); then
    echo "$response" | output_table '.templates[] | [.name, .size_bytes] | @tsv'
  else
    echo "$response"
    return 1
  fi
}

cmd_template_delete() {
  need_config
  local name="${1:-}"
  [[ -n "$name" ]] || die "Usage: sb template delete <name>"

  local response
  if response=$(api DELETE "/templates/$name"); then
    output_message "Deleted template $name"
  else
    echo "$response"
    return 1
  fi
}

cmd_version() {
  echo "sb version 0.1.0"
}

cmd_help() {
  cat <<'EOF'
Scalebox CLI

Usage: sb [--json] <command>

Global Options:
  --json          Output in JSON format (for scripting)

Commands:
  login                         Log in to a Scalebox server
  logout                        Remove stored credentials
  config show [--show-token]    Show current configuration
  status                        Health check (no auth required)

  vm list                       List VMs
  vm create -t TPL -k KEY       Create VM (-k @file.pub or -k "ssh-rsa ...")
  vm get <name|id>              Get VM details
  vm delete <name|id>           Delete VM
  vm snapshot <name|id> -n NAME Snapshot VM to template
  vm wait <name|id> --ssh       Wait for SSH to be ready

  template list                 List templates
  template delete <name>        Delete template

  version                       Show version
  help                          Show this help

Environment Variables:
  SCALEBOX_HOST        API host URL (overrides config file)
  SCALEBOX_TOKEN       API token (overrides config file)
  SCALEBOX_CONFIG_DIR  Config directory (default: ~/.config/scalebox)
  SCALEBOX_JSON=true   Always output JSON

Examples:
  sb login
  sb vm create -t debian-base -k @~/.ssh/id_rsa.pub
  sb vm list
  sb --json vm get my-vm-name
  sb vm wait my-vm-name --ssh --timeout 120
  sb vm snapshot my-vm-name -n my-snapshot
EOF
}

# === Main ===
main() {
  need_jq

  # Parse global options
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) JSON_OUTPUT=true; shift ;;
      -*)
        if [[ "$1" != "--help" && "$1" != "-h" ]]; then
          die "Unknown global option: $1"
        fi
        break
        ;;
      *) break ;;
    esac
  done

  # Load config after parsing global options (but before commands)
  # Skip loading for login/help/version commands
  case "${1:-help}" in
    login|help|--help|-h|version) ;;
    *) load_config ;;
  esac

  case "${1:-help}" in
    login) shift; cmd_login "$@" ;;
    logout) cmd_logout ;;
    config)
      case "${2:-}" in
        show) shift 2; cmd_config_show "$@" ;;
        *) die "Usage: sb config show [--show-token]" ;;
      esac
      ;;
    status) cmd_status ;;
    vm)
      case "${2:-}" in
        list) cmd_vm_list ;;
        create) shift 2; cmd_vm_create "$@" ;;
        get) shift 2; cmd_vm_get "$@" ;;
        delete) shift 2; cmd_vm_delete "$@" ;;
        snapshot) shift 2; cmd_vm_snapshot "$@" ;;
        wait) shift 2; cmd_vm_wait "$@" ;;
        *) die "Usage: sb vm [list|create|get|delete|snapshot|wait]" ;;
      esac
      ;;
    template)
      case "${2:-}" in
        list) cmd_template_list ;;
        delete) shift 2; cmd_template_delete "$@" ;;
        *) die "Usage: sb template [list|delete]" ;;
      esac
      ;;
    version|--version|-v) cmd_version ;;
    help|--help|-h) cmd_help ;;
    *) die "Unknown command: $1. Try: sb help" ;;
  esac
}

main "$@"
```

### Verification

```bash
# Script is valid bash
bash -n scripts/sb

# Help works without config
./scripts/sb help
./scripts/sb --json help
```

---

## Phase 3: Update Installation Scripts

**Goal**: Update `install.sh` to install `sb` (with `scalebox` symlink), create user-level installer.

### Modify: `scripts/install.sh`

Update the `install_cli()` function:

```bash
# === Install CLI ===
install_cli() {
  if [[ -f "$INSTALL_DIR/sb" ]]; then
    log "Installing sb CLI..."
    cp "$INSTALL_DIR/sb" /usr/local/bin/sb
    chmod +x /usr/local/bin/sb
    # Backward compatibility symlink
    ln -sf /usr/local/bin/sb /usr/local/bin/scalebox
  fi
}
```

Update the preflight check:

```bash
# === Pre-flight Check ===
preflight_check() {
  log "Running pre-flight checks..."
  local missing=()

  [[ -f "$INSTALL_DIR/scaleboxd" ]] || missing+=("scaleboxd binary")
  [[ -f "$INSTALL_DIR/scaleboxd.service" ]] || missing+=("scaleboxd.service")
  [[ -f "$INSTALL_DIR/sb" ]] || missing+=("sb CLI")

  if [[ ${#missing[@]} -gt 0 ]]; then
    die "Missing required files in $INSTALL_DIR: ${missing[*]}"
  fi
}
```

Update the completion message at the end of `main()`:

```bash
  echo ""
  log "Installation complete!"
  echo ""
  echo "  API: http://$(hostname -I | awk '{print $1}'):$API_PORT"
  echo "  Token: $API_TOKEN"
  echo ""
  echo "  Commands:"
  echo "    systemctl status scaleboxd"
  echo "    journalctl -u scaleboxd -f"
  echo "    sb vm list"
  echo ""
  echo "  Save your API token - it won't be shown again!"
  echo ""
```

### New file: `scripts/install-sb.sh`

User-level installer for client-only installation:

```bash
#!/bin/bash
#
# Scalebox CLI (sb) Installer
#
# Installs sb to ~/.local/bin for the current user.
# Does NOT require root. Does NOT install the server.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/anthropics/scalebox/main/scripts/install-sb.sh | bash
#
set -euo pipefail

INSTALL_DIR="${SCALEBOX_INSTALL_DIR:-$HOME/.local/bin}"
REPO="anthropics/scalebox"
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
```

### Verification

```bash
# Test user installer locally
SCALEBOX_INSTALL_DIR=/tmp/sb-test bash scripts/install-sb.sh
/tmp/sb-test/sb version
rm -rf /tmp/sb-test
```

---

## Phase 4: Update Build Script

**Goal**: Update `do` script to copy `sb` instead of `scalebox`, include user installer.

### Modify: `do`

Update the `do_build()` function. Key changes:
- Replace `cp scripts/scalebox builds/` with `cp scripts/sb builds/`
- Add `cp scripts/install-sb.sh builds/`
- Update chmod to reference `sb` instead of `scalebox`

```bash
do_build() {
  ensure_bun
  ensure_deps

  echo "==> Building..."

  # Check scripts directory exists
  [[ -d scripts ]] || die "scripts/ directory not found. Run from project root."

  rm -rf builds
  mkdir -p builds

  # Compile server
  "$BUN_BIN" build src/index.ts --compile --outfile builds/scaleboxd

  # Verify binary was created
  [[ -f builds/scaleboxd ]] || die "Failed to compile scaleboxd"

  # Copy scripts (sb replaces scalebox)
  cp scripts/install.sh builds/
  cp scripts/install-sb.sh builds/
  cp scripts/sb builds/
  cp scripts/scaleboxd.service builds/
  cp scripts/scalebox-update builds/

  chmod +x builds/scaleboxd builds/sb builds/install.sh builds/install-sb.sh builds/scalebox-update

  echo "==> Build complete"
  ls -la builds/
}
```

### Verification

```bash
./do build
ls builds/
# Should show: scaleboxd, sb, install.sh, install-sb.sh, scaleboxd.service, scalebox-update
```

---

## Phase 4.5: Update scalebox-update Script

**Goal**: Update `scalebox-update` to install `sb` CLI with backward-compatible `scalebox` symlink.

### Modify: `scripts/scalebox-update`

Update constants at the top:

```bash
SCALEBOX_CLI="/usr/local/bin/scalebox"
```

becomes:

```bash
SB_CLI="/usr/local/bin/sb"
SCALEBOX_CLI="/usr/local/bin/scalebox"  # Backward compat symlink
```

Update `download_release()` to check for `sb`:

```bash
download_release() {
  local url=$1
  local temp_dir=$2

  log "Downloading: $url"
  curl -sSL "$url" | tar -xz -C "$temp_dir"

  # Verify required files exist
  [[ -f "$temp_dir/scaleboxd" ]] || die "scaleboxd not found in release"
  [[ -f "$temp_dir/sb" ]] || die "sb not found in release"
  [[ -f "$temp_dir/scaleboxd.service" ]] || die "scaleboxd.service not found in release"
}
```

Update `install_new()` to install `sb` and create symlink:

```bash
install_new() {
  local temp_dir=$1

  log "Installing new scaleboxd..."
  cp "$temp_dir/scaleboxd" "$SCALEBOXD_BIN"
  chmod +x "$SCALEBOXD_BIN"

  log "Installing new sb CLI..."
  cp "$temp_dir/sb" "$SB_CLI"
  chmod +x "$SB_CLI"

  # Backward compatibility symlink
  ln -sf "$SB_CLI" "$SCALEBOX_CLI"

  # Update scalebox-update itself
  if [[ -f "$temp_dir/scalebox-update" ]]; then
    log "Installing new scalebox-update..."
    cp "$temp_dir/scalebox-update" "/usr/local/bin/scalebox-update"
    chmod +x "/usr/local/bin/scalebox-update"
  fi

  # Only update service file if different
  if ! diff -q "$temp_dir/scaleboxd.service" "$SERVICE_FILE" &>/dev/null; then
    log "Updating systemd service file..."
    cp "$temp_dir/scaleboxd.service" "$SERVICE_FILE"
    systemctl daemon-reload
  fi
}
```

### Verification

```bash
bash -n scripts/scalebox-update
```

---

## Phase 5: Add CLI Test Helpers (Non-Breaking)

**Goal**: Add CLI helper functions to `test/helpers.ts` WITHOUT removing any existing functions. All 19 existing tests continue to pass unchanged.

### Modify: `test/helpers.ts`

Add the following NEW exports at the end of the file (keep all existing code):

```typescript
// === NEW: CLI Test Helpers ===
// These are added alongside existing HTTP helpers for incremental test migration.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// CLI configuration
let cliConfigDir: string | null = null;

// Path to test public key file
export const TEST_PUBLIC_KEY_PATH = join(FIXTURES_DIR, "test_key.pub");

// Get path to sb binary
function getSbPath(): string {
  const localPath = join(import.meta.dir, "..", "builds", "sb");
  try {
    readFileSync(localPath);
    return localPath;
  } catch {
    return "sb";
  }
}

// Initialize CLI with isolated config directory
export async function initCli(): Promise<void> {
  cliConfigDir = await mkdtemp(join(tmpdir(), "scalebox-test-"));
  const host = `http://${VM_HOST}:${API_PORT}`;
  const result = await $`echo ${API_TOKEN} | SCALEBOX_CONFIG_DIR=${cliConfigDir} ${getSbPath()} login --host ${host} --token-stdin`.quiet();
  if (result.exitCode !== 0) {
    throw new Error(`sb login failed: ${result.stderr.toString()}`);
  }
}

// Cleanup CLI config
export async function cleanupCli(): Promise<void> {
  if (cliConfigDir) {
    await rm(cliConfigDir, { recursive: true, force: true });
    cliConfigDir = null;
  }
}

// Execute sb command and return parsed JSON
export async function sbCmd(
  ...args: string[]
): Promise<{ exitCode: number; data: Record<string, unknown> | null; error: string | null }> {
  if (!cliConfigDir) {
    throw new Error("CLI not initialized. Call initCli() first.");
  }

  const result = await $`SCALEBOX_CONFIG_DIR=${cliConfigDir} ${getSbPath()} --json ${args}`.quiet().nothrow();

  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();

  let data: Record<string, unknown> | null = null;
  let error: string | null = null;

  if (stdout) {
    try {
      data = JSON.parse(stdout);
      if (data && typeof data === "object" && "error" in data) {
        error = data.error as string;
      }
    } catch {
      error = stdout;
    }
  }

  if (stderr && !error) {
    error = stderr;
  }

  return { exitCode: result.exitCode, data, error };
}

// Convenience functions for CLI operations
export async function sbVmCreate(template: string): Promise<Record<string, unknown>> {
  const result = await sbCmd("vm", "create", "-t", template, "-k", `@${TEST_PUBLIC_KEY_PATH}`);
  if (result.exitCode !== 0 || !result.data) {
    throw new Error(`Failed to create VM: ${result.error}`);
  }
  return result.data;
}

export async function sbVmDelete(nameOrId: string): Promise<void> {
  const result = await sbCmd("vm", "delete", nameOrId);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to delete VM: ${result.error}`);
  }
}

export async function sbVmGet(nameOrId: string): Promise<Record<string, unknown> | null> {
  const result = await sbCmd("vm", "get", nameOrId);
  if (result.exitCode !== 0) {
    return null;
  }
  return result.data;
}

export async function sbVmList(): Promise<Record<string, unknown>[]> {
  const result = await sbCmd("vm", "list");
  if (result.exitCode !== 0 || !result.data) {
    throw new Error(`Failed to list VMs: ${result.error}`);
  }
  return (result.data as { vms: Record<string, unknown>[] }).vms || [];
}

export async function sbVmWait(nameOrId: string, timeoutSec: number = 60): Promise<void> {
  const result = await sbCmd("vm", "wait", nameOrId, "--ssh", "--timeout", String(timeoutSec));
  if (result.exitCode !== 0) {
    throw new Error(`Failed waiting for SSH: ${result.error}`);
  }
}

export async function sbVmSnapshot(nameOrId: string, templateName: string): Promise<Record<string, unknown>> {
  const result = await sbCmd("vm", "snapshot", nameOrId, "-n", templateName);
  if (result.exitCode !== 0 || !result.data) {
    throw new Error(`Failed to snapshot VM: ${result.error}`);
  }
  return result.data;
}

export async function sbTemplateList(): Promise<Record<string, unknown>[]> {
  const result = await sbCmd("template", "list");
  if (result.exitCode !== 0 || !result.data) {
    throw new Error(`Failed to list templates: ${result.error}`);
  }
  return (result.data as { templates: Record<string, unknown>[] }).templates || [];
}

export async function sbTemplateDelete(name: string): Promise<void> {
  const result = await sbCmd("template", "delete", name);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to delete template: ${result.error}`);
  }
}

export async function sbStatus(): Promise<Record<string, unknown>> {
  const result = await sbCmd("status");
  if (result.exitCode !== 0 || !result.data) {
    throw new Error(`Failed to get status: ${result.error}`);
  }
  return result.data;
}
```

### Verification

```bash
./do lint
./do check
# All 19 existing tests must pass - no tests are changed yet
```

---

## Phase 6: Migrate Tests Incrementally

**Goal**: Migrate each test one at a time from HTTP API to CLI. Each sub-phase modifies exactly ONE test while all other tests remain unchanged.

### Current Tests (19 total)

| # | Test Name | Migration Target |
|---|-----------|------------------|
| 1 | health check returns ok | `sbStatus()` |
| 2 | auth rejects missing token | Keep HTTP (tests raw auth) |
| 3 | auth rejects invalid token | Keep HTTP (tests raw auth) |
| 4 | lists templates | `sbTemplateList()` |
| 5 | debian-base template exists | `sbTemplateList()` |
| 6 | delete protected template returns 403 | `sbCmd("template", "delete", ...)` |
| 7 | delete nonexistent template returns 404 | `sbCmd("template", "delete", ...)` |
| 8 | create VM returns valid response | `sbVmCreate()` |
| 9 | created VM appears in list | `sbVmCreate()` + `sbVmList()` |
| 10 | get VM by id returns details | `sbVmCreate()` + `sbVmGet()` |
| 11 | delete VM returns 204 | `sbVmCreate()` + `sbVmDelete()` |
| 12 | deleted VM not in list | `sbVmDelete()` + `sbVmList()` |
| 13 | VM becomes reachable via SSH | `sbVmCreate()` + `sbVmWait()` |
| 14 | can execute command via SSH | `sbVmCreate()` + `sbVmWait()` + `sshExec()` |
| 15 | snapshot VM creates template | `sbVmSnapshot()` |
| 16 | snapshot appears in template list | `sbVmSnapshot()` + `sbTemplateList()` |
| 17 | can create VM from snapshot | `sbVmSnapshot()` + `sbVmCreate()` |
| 18 | snapshot preserves filesystem state | `sbVmSnapshot()` + `sbVmCreate()` + `sshExec()` |
| 19 | can delete snapshot template | `sbVmSnapshot()` + `sbTemplateDelete()` |

### Phase 6.1: Add CLI lifecycle hooks

**Goal**: Add `beforeAll`/`afterAll` for CLI initialization without changing any tests.

```typescript
// Add at the top of describe block, after createdVmIds/createdTemplates declarations:
beforeAll(async () => {
  await initCli();
});

afterAll(async () => {
  await cleanupCli();
});
```

**Verification**: `./do check` - all 19 tests pass

### Phase 6.2: Migrate "health check returns ok"

**Change test from**:
```typescript
test("health check returns ok", async () => {
  const res = await fetch(`${API_BASE_URL}/health`);
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.status).toBe("ok");
});
```

**To**:
```typescript
test("health check returns ok", async () => {
  const status = await sbStatus();
  expect(status.status).toBe(200);
});
```

**Verification**: `./do check` - all 19 tests pass

### Phase 6.3: Migrate "lists templates"

**Change test from**:
```typescript
test("lists templates", async () => {
  const { status, data } = await api.get("/templates");
  expect(status).toBe(200);
  expect(Array.isArray(data.templates)).toBe(true);
});
```

**To**:
```typescript
test("lists templates", async () => {
  const templates = await sbTemplateList();
  expect(Array.isArray(templates)).toBe(true);
});
```

**Verification**: `./do check` - all 19 tests pass

### Phase 6.4: Migrate "debian-base template exists"

**Change test from**:
```typescript
test("debian-base template exists", async () => {
  const { data } = await api.get("/templates");
  const names = data.templates.map((t: { name: string }) => t.name);
  expect(names).toContain("debian-base");
});
```

**To**:
```typescript
test("debian-base template exists", async () => {
  const templates = await sbTemplateList();
  const names = templates.map((t) => t.name);
  expect(names).toContain("debian-base");
});
```

**Verification**: `./do check` - all 19 tests pass

### Phase 6.5: Migrate "delete protected template returns 403"

**Change test from**:
```typescript
test("delete protected template returns 403", async () => {
  const { status } = await api.delete("/templates/debian-base");
  expect(status).toBe(403);
});
```

**To**:
```typescript
test("delete protected template returns 403", async () => {
  const result = await sbCmd("template", "delete", "debian-base");
  expect(result.exitCode).not.toBe(0);
  expect(result.data?.status).toBe(403);
});
```

**Verification**: `./do check` - all 19 tests pass

### Phase 6.6: Migrate "delete nonexistent template returns 404"

**Change test from**:
```typescript
test("delete nonexistent template returns 404", async () => {
  const { status } = await api.delete("/templates/does-not-exist");
  expect(status).toBe(404);
});
```

**To**:
```typescript
test("delete nonexistent template returns 404", async () => {
  const result = await sbCmd("template", "delete", "does-not-exist");
  expect(result.exitCode).not.toBe(0);
  expect(result.data?.status).toBe(404);
});
```

**Verification**: `./do check` - all 19 tests pass

### Phase 6.7: Migrate "create VM returns valid response"

**Change test from**:
```typescript
test("create VM returns valid response", async () => {
  const { status, data } = await api.post("/vms", {
    template: "debian-base",
    name: "test-vm",
    ssh_public_key: TEST_PUBLIC_KEY,
  });
  if (data?.id) createdVmIds.push(data.id);

  expect(status).toBe(201);
  expect(data.id).toMatch(/^vm-[a-f0-9]{12}$/);
  expect(data.template).toBe("debian-base");
  expect(data.ip).toMatch(/^172\.16\.\d+\.\d+$/);
  expect(data.ssh_port).toBeGreaterThan(22000);
});
```

**To**:
```typescript
test("create VM returns valid response", async () => {
  const vm = await sbVmCreate("debian-base");
  if (vm?.id) createdVmIds.push(vm.id as string);

  expect(vm.id).toMatch(/^vm-[a-f0-9]{12}$/);
  expect(vm.name).toBeDefined();
  expect(vm.template).toBe("debian-base");
  expect(vm.ip).toMatch(/^172\.16\.\d+\.\d+$/);
  expect(vm.ssh_port).toBeGreaterThan(22000);
});
```

**Verification**: `./do check` - all 19 tests pass

### Phase 6.8 through 6.19: Continue for remaining tests

Each subsequent phase follows the same pattern:
1. Identify the test to migrate
2. Replace HTTP API calls with CLI helper calls
3. Verify all 19 tests still pass

**Tests to migrate in order**:
- 6.8: "created VM appears in list"
- 6.9: "get VM by id returns details"
- 6.10: "delete VM returns 204"
- 6.11: "deleted VM not in list"
- 6.12: "VM becomes reachable via SSH"
- 6.13: "can execute command via SSH"
- 6.14: "snapshot VM creates template"
- 6.15: "snapshot appears in template list"
- 6.16: "can create VM from snapshot"
- 6.17: "snapshot preserves filesystem state"
- 6.18: "can delete snapshot template"

**Tests kept with HTTP API** (tests 2, 3):
- "auth rejects missing token" - requires raw HTTP without auth header
- "auth rejects invalid token" - requires raw HTTP with invalid token

---

## Phase 7: Remove Old CLI and Unused HTTP Helpers

**Goal**: Clean up after all tests are migrated.

### Delete: `scripts/scalebox`

```bash
rm scripts/scalebox
```

### Modify: `test/helpers.ts`

Remove unused HTTP helper functions. The `api` object is still needed for:
- `api.getRaw()` - used by auth tests (tests 2, 3)
- `api.delete()` - used by `afterEach` cleanup

```typescript
// KEEP these (still used):
export const api = {
  // Used by auth tests
  async getRaw(path: string, token?: string) { ... },
  // Used by afterEach cleanup
  async delete(path: string) { ... },
};

// KEEP these (used by migrated tests):
// - All CLI helpers (sbCmd, sbVmCreate, etc.)
// - sshExec, waitForSsh (still used for SSH operations)

// REMOVE these (no longer used after migration):
// - api.get()
// - api.post()
```

**Note**: The `afterEach` cleanup in `integration.test.ts` uses `api.delete()` for cleanup. Either keep `api.delete()` or migrate cleanup to use `sbVmDelete()` / `sbTemplateDelete()`.

### Modify: `product/DDD/glossary.md`

Update the Operations Terms section to reflect the CLI rename:

```markdown
### sb CLI
The user-facing command-line tool for interacting with the Scalebox API. Named `sb` for brevity. A `scalebox` symlink is maintained for backward compatibility.

**Note:** This is different from `scalebox-update`, which is a server-side administration tool.
```

### Verification

```bash
./do lint
./do check
# All tests pass
```

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `product/ADR/013-cli-authentication.md` | Create | Document CLI auth architecture |
| `scripts/sb` | Create | New CLI with login flow |
| `scripts/install-sb.sh` | Create | User-level installer |
| `scripts/scalebox` | Delete (Phase 7) | Replaced by sb |
| `scripts/scalebox-update` | Modify | Install sb, create scalebox symlink |
| `scripts/install.sh` | Modify | Install sb, create symlink |
| `do` | Modify | Build sb instead of scalebox |
| `test/helpers.ts` | Modify | Add CLI helpers, later remove unused HTTP helpers |
| `test/integration.test.ts` | Modify | Migrate tests one at a time |
| `product/DDD/glossary.md` | Modify | Update CLI terminology (scalebox → sb) |

---

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `SCALEBOX_HOST` | API server URL | (from config or localhost) |
| `SCALEBOX_TOKEN` | API token | (from config) |
| `SCALEBOX_CONFIG_DIR` | Config directory | `~/.config/scalebox` |
| `SCALEBOX_JSON` | Always output JSON | `false` |
| `SCALEBOX_URL` | Legacy (maps to SCALEBOX_HOST) | - |

---

## Config Precedence

1. CLI flags (reserved for future)
2. `SCALEBOX_*` environment variables
3. `~/.config/scalebox/config`
4. `/etc/scalebox/config` (server-side fallback)

---

## Verification

### Per-Phase Verification

| Phase | Command | Expected |
|-------|---------|----------|
| 1 | `cat product/ADR/013-cli-authentication.md` | ADR exists |
| 2 | `bash -n scripts/sb && ./scripts/sb help` | Valid bash, help shows |
| 3 | `bash -n scripts/install-sb.sh` | Valid bash |
| 4 | `./do build && ls builds/` | sb in builds/ |
| 4.5 | `bash -n scripts/scalebox-update` | Valid bash |
| 5 | `./do check` | All 19 tests pass (no changes to tests) |
| 6.1-6.19 | `./do check` | All 19 tests pass (after each sub-phase) |
| 7 | `./do check` | All tests pass, scalebox removed, glossary updated |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Token in shell history | `--token-stdin` reads from stdin, not args |
| Config file permissions | Created with umask 077, chmod 600 |
| Tests affect user config | `SCALEBOX_CONFIG_DIR` isolates test config |
| jq not installed | User installer downloads static jq binary |
| PATH not set | Installer adds to .bashrc/.zshrc |
| Backward compat breaks | `scalebox` symlink for CLI |
| JSON parsing fragile | Structured `--json` output with consistent format |
| SSH wait timeout | Configurable `--timeout` flag |
| Test cleanup fails | Track created resources, cleanup in afterEach |
| nc not available | Fallback to curl-based port check |
| Incremental migration breaks | Each phase verified independently |

---

## Migration Guide

For existing users:

1. **Environment variables**: `SCALEBOX_URL` continues to work (mapped to `SCALEBOX_HOST`)
2. **CLI command**: `scalebox` still works (symlink) but `sb` is preferred
3. **Scripts**: Update to use `sb` for new scripts
4. **Config**: Run `sb login` to create user config at `~/.config/scalebox/config`
