#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GCLOUD_ZONE="${GCLOUD_ZONE:-us-central1-a}"
GCLOUD_PROJECT="${GCLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || echo '')}"
VM_NAME=""
VM_IP=""
KEEP_VM="${KEEP_VM:-false}"
DNS_ZONE="${DNS_ZONE:-scalebox-dns}"
DNS_SUFFIX="${DNS_SUFFIX:-testing.holderbaum.cloud}"

# Bun - use system bun if available, otherwise local installation
BUN_DIR="$SCRIPT_DIR/.bun"
if command -v bun &>/dev/null; then
  BUN_BIN="$(command -v bun)"
else
  BUN_BIN="$BUN_DIR/bin/bun"
fi

die() { echo "Error: $1" >&2; exit 1; }

ensure_bun() {
  if command -v bun &>/dev/null; then
    echo "==> Using system bun: $(command -v bun)"
    return 0
  fi
  if [[ ! -x "$BUN_BIN" ]]; then
    echo "==> Installing bun locally..."
    BUN_INSTALL="$BUN_DIR" bash -c "$(curl -fsSL https://bun.sh/install)"
  fi
}

ensure_deps() {
  if [[ ! -d "$SCRIPT_DIR/node_modules" ]] || [[ "$SCRIPT_DIR/package.json" -nt "$SCRIPT_DIR/node_modules" ]]; then
    echo "==> Installing dependencies..."
    "$BUN_BIN" install
  fi
}

cleanup() {
  delete_dns_record
  if [[ -n "$VM_NAME" && "$KEEP_VM" != "true" ]]; then
    echo "==> Deleting VM: $VM_NAME"
    gcloud compute instances delete "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --quiet 2>/dev/null || true
  fi
}

create_vm() {
  VM_NAME="scalebox-test-$(date +%s)-$$-$RANDOM"
  echo "==> Creating VM: $VM_NAME"

  gcloud compute instances create "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --machine-type=n2-standard-2 \
    --image-family=debian-12 \
    --image-project=debian-cloud \
    --boot-disk-size=50GB \
    --boot-disk-type=pd-ssd \
    --enable-nested-virtualization \
    --tags=scalebox-test \
    --quiet

  VM_IP=$(gcloud compute instances describe "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --format='get(networkInterfaces[0].accessConfigs[0].natIP)')

  [[ -n "$VM_IP" ]] || die "VM has no external IP. Check GCE configuration."

  echo "==> VM IP: $VM_IP"
}

wait_for_ssh() {
  echo "==> Waiting for SSH..."
  local retries=30
  while [[ $retries -gt 0 ]]; do
    if gcloud compute ssh "$VM_NAME" \
         --zone="$GCLOUD_ZONE" \
         --project="$GCLOUD_PROJECT" \
         --command="echo ready" \
         --quiet 2>/dev/null; then
      return 0
    fi
    sleep 5
    ((retries--)) || true
  done
  die "SSH not ready after 150s"
}

provision_vm() {
  # Verify builds directory exists and has files
  [[ -d builds && -n "$(ls -A builds 2>/dev/null)" ]] || die "builds/ directory is empty. Run './do build' first."

  echo "==> Creating target directory..."
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="sudo mkdir -p /opt/scalebox && sudo chown \$(whoami) /opt/scalebox" \
    --quiet

  echo "==> Copying builds to VM..."
  gcloud compute scp --recurse builds/ "$VM_NAME:/opt/scalebox/" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --quiet

  # Move files from builds/ subdirectory to /opt/scalebox/
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="mv /opt/scalebox/builds/* /opt/scalebox/ && rmdir /opt/scalebox/builds" \
    --quiet

  echo "==> Running install script..."
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="sudo DOMAIN='$DOMAIN' bash /opt/scalebox/install.sh" \
    --quiet
}

get_api_token() {
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="sudo grep API_TOKEN /etc/scalebox/config | cut -d= -f2-" \
    --quiet
}

create_dns_record() {
  VM_FQDN="${VM_NAME}.${DNS_SUFFIX}"
  echo "==> Creating DNS record: ${VM_FQDN} -> ${VM_IP}"

  gcloud dns record-sets create "${VM_FQDN}." \
    --zone="$DNS_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --type=A \
    --ttl=60 \
    --rrdatas="$VM_IP"

  echo "==> Waiting for DNS propagation..."
  local retries=30
  while [[ $retries -gt 0 ]]; do
    if host "$VM_FQDN" 2>/dev/null | grep -q "$VM_IP"; then
      echo "==> DNS propagated"
      return 0
    fi
    sleep 2
    ((retries--)) || true
  done
  die "DNS propagation timeout for $VM_FQDN"
}

delete_dns_record() {
  if [[ -n "$VM_NAME" && -n "$DNS_SUFFIX" ]]; then
    echo "==> Deleting DNS record: ${VM_NAME}.${DNS_SUFFIX}"
    gcloud dns record-sets delete "${VM_NAME}.${DNS_SUFFIX}." \
      --zone="$DNS_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --type=A \
      --quiet 2>/dev/null || true
  fi
}

# === Commands ===

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

  # Copy scripts
  cp scripts/install.sh builds/
  cp scripts/scalebox builds/
  cp scripts/scaleboxd.service builds/

  chmod +x builds/scaleboxd builds/scalebox builds/install.sh

  echo "==> Build complete"
  ls -la builds/
}

do_lint() {
  ensure_bun
  ensure_deps
  "$BUN_BIN" run lint
}

do_test() {
  ensure_bun
  ensure_deps
  "$BUN_BIN" test "$@"
}

check_gcloud_project() {
  if [[ -z "$GCLOUD_PROJECT" ]]; then
    die "GCLOUD_PROJECT is not set. Set it via environment variable or 'gcloud config set project <project-id>'"
  fi
  echo "==> Using GCP project: $GCLOUD_PROJECT"
}

check_firewall_rule() {
  echo "==> Checking firewall rule..."
  if ! gcloud compute firewall-rules describe scalebox-test-allow \
       --project="$GCLOUD_PROJECT" &>/dev/null; then
    die "Firewall rule 'scalebox-test-allow' not found. Create it first (see Phase 0 in PLAN-SCALEBOX.md)"
  fi
}

do_check() {
  echo "==> Starting do_check..."
  echo "==> SCRIPT_DIR: $SCRIPT_DIR"
  echo "==> BUN_DIR: $BUN_DIR"
  echo "==> BUN_BIN: $BUN_BIN"
  echo "==> Checking if bun exists: $(ls -la $BUN_BIN 2>&1 || echo 'NOT FOUND')"

  trap cleanup EXIT

  ensure_bun
  ensure_deps

  # Verify GCP project is set before any gcloud commands
  check_gcloud_project

  # Verify firewall rule exists before creating VM
  check_firewall_rule

  echo "==> Linting..."
  do_lint

  echo "==> Building..."
  do_build

  echo "==> Creating test VM..."
  create_vm
  wait_for_ssh
  create_dns_record
  echo "==> Provisioning VM..."
  DOMAIN="$VM_FQDN" provision_vm

  echo "==> Getting API token..."
  local token
  token=$(get_api_token)
  [[ -n "$token" ]] || die "Failed to get API token"

  # Debug: Create a test VM and check if it boots properly
  echo "==> Debug: Creating a test VM to check boot status..."
  local debug_vm_response
  debug_vm_response=$(curl -s -X POST "https://$VM_FQDN/vms" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d '{"template": "debian-base", "ssh_public_key": "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ test@test"}')
  echo "==> Debug VM response: $debug_vm_response"
  local debug_vm_id=$(echo "$debug_vm_response" | jq -r '.id')
  local debug_vm_ip=$(echo "$debug_vm_response" | jq -r '.ip')

  if [[ -n "$debug_vm_id" && "$debug_vm_id" != "null" ]]; then
    echo "==> Debug: Waiting 30s for VM to boot..."
    sleep 30

    echo "==> Debug: Checking Firecracker process..."
    gcloud compute ssh "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --command="ps aux | grep -E 'firecracker|$debug_vm_id' | grep -v grep || echo 'No firecracker process found'" \
      --quiet || echo "Failed to check process"

    echo "==> Debug: Checking VM network connectivity from host..."
    gcloud compute ssh "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --command="ping -c 2 $debug_vm_ip || echo 'Ping failed'" \
      --quiet || echo "Failed to check network"

    echo "==> Debug: Checking Firecracker console log (VM boot output)..."
    gcloud compute ssh "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --command="cat /tmp/fc-$debug_vm_id-console.log 2>/dev/null || echo 'Console log not found'" \
      --quiet || echo "Failed to get console log"

    echo "==> Debug: Testing direct TCP connection to VM SSH port (using bash /dev/tcp)..."
    gcloud compute ssh "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --command="timeout 5 bash -c 'exec 3<>/dev/tcp/$debug_vm_ip/22 && cat <&3 & sleep 2; kill %1 2>/dev/null' 2>&1 || echo 'Direct TCP to port 22 failed'" \
      --quiet || echo "Failed to test direct TCP"

    echo "==> Debug: Testing SSH connection through proxy port..."
    local debug_ssh_port=$(echo "$debug_vm_response" | jq -r '.ssh_port')
    echo "==> SSH port: $debug_ssh_port"
    gcloud compute ssh "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --command="timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/$debug_ssh_port && cat <&3 & sleep 2; kill %1 2>/dev/null' 2>&1 || echo 'Proxy port connection failed'" \
      --quiet || echo "Failed to test proxy port"

    echo "==> Debug: Checking scaleboxd logs for VM creation..."
    gcloud compute ssh "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --command="journalctl -u scaleboxd -n 50 --no-pager | grep -E '$debug_vm_id|proxy|error|listen|port' || echo 'No relevant logs'" \
      --quiet || echo "Failed to get logs"

    echo "==> Debug: Checking listening ports on host..."
    gcloud compute ssh "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --command="ss -tlnp | grep -E '$debug_ssh_port|scaleboxd' || echo 'Port not found in ss output'" \
      --quiet || echo "Failed to get port info"

    echo "==> Debug: Deleting debug VM..."
    curl -s -X DELETE "https://$VM_FQDN/vms/$debug_vm_id" -H "Authorization: Bearer $token" || true
  fi

  echo "==> Running tests against https://$VM_FQDN..."
  if ! VM_HOST="$VM_FQDN" USE_HTTPS=true API_TOKEN="$token" "$BUN_BIN" test; then
    echo "==> Tests FAILED. Capturing debug info..."

    echo "==> scaleboxd logs after test failure:"
    gcloud compute ssh "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --command="journalctl -u scaleboxd -n 100 --no-pager" \
      --quiet || echo "Failed to get scaleboxd logs"

    echo "==> Listening ports after test failure:"
    gcloud compute ssh "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --command="ss -tlnp" \
      --quiet || echo "Failed to get port info"

    echo "==> Current VMs:"
    gcloud compute ssh "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --command="curl -s localhost:8080/vms -H 'Authorization: Bearer $token'" \
      --quiet || echo "Failed to get VMs"

    exit 1
  fi

  echo ""
  echo "==> All tests passed!"
}

# === Main ===

case "${1:-help}" in
  build) do_build ;;
  lint) do_lint ;;
  test) shift; do_test "$@" ;;
  check)
    shift || true
    [[ "${1:-}" == "--keep-vm" ]] && KEEP_VM=true
    do_check
    ;;
  help|*)
    cat <<'EOF'
Scalebox Development Script

Usage: ./do <command>

Commands:
  build              Build scaleboxd binary and copy scripts to builds/
  lint               Run linter
  test               Run tests locally (requires VM_HOST and API_TOKEN)
  check              Full CI: lint, build, create VM, provision, test, cleanup
  check --keep-vm    Same but keep VM for debugging

Environment:
  GCLOUD_ZONE        GCE zone (default: us-central1-a)
  GCLOUD_PROJECT     GCE project (default: current gcloud config)
  KEEP_VM=true       Don't delete VM after tests
EOF
    ;;
esac
