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
GCS_BUCKET="${GCS_BUCKET:-scalebox-test-artifacts}"
GCS_TARBALL_PATH=""

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
  delete_tarball
  delete_dns_record
  if [[ -n "$VM_NAME" && "$KEEP_VM" != "true" ]]; then
    echo "==> Deleting VM: $VM_NAME"
    gcloud compute instances delete "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --quiet 2>/dev/null || true
  fi
}

ensure_gcs_bucket() {
  # Create bucket if it doesn't exist (ignore error if already exists)
  if ! gcloud storage buckets describe "gs://$GCS_BUCKET" --project="$GCLOUD_PROJECT" &>/dev/null; then
    echo "==> Creating GCS bucket: $GCS_BUCKET"
    gcloud storage buckets create "gs://$GCS_BUCKET" \
      --project="$GCLOUD_PROJECT" \
      --location="us-central1" \
      --uniform-bucket-level-access 2>/dev/null || true
  fi

  # Always ensure public read access (idempotent operation)
  # This handles both new buckets and existing buckets that may lack the permission
  echo "==> Ensuring GCS bucket has public read access..."
  gcloud storage buckets add-iam-policy-binding "gs://$GCS_BUCKET" \
    --member="allUsers" \
    --role="roles/storage.objectViewer" \
    --project="$GCLOUD_PROJECT" 2>/dev/null || true
}

upload_tarball() {
  local tarball=$1
  GCS_TARBALL_PATH="scalebox-test-$(date +%s)-$$.tar.gz"

  gcloud storage cp "$tarball" "gs://$GCS_BUCKET/$GCS_TARBALL_PATH" \
    --project="$GCLOUD_PROJECT"

  # Return the public URL
  echo "https://storage.googleapis.com/$GCS_BUCKET/$GCS_TARBALL_PATH"
}

delete_tarball() {
  if [[ -n "$GCS_TARBALL_PATH" ]]; then
    echo "==> Deleting tarball from GCS..."
    gcloud storage rm "gs://$GCS_BUCKET/$GCS_TARBALL_PATH" \
      --project="$GCLOUD_PROJECT" 2>/dev/null || true
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

provision_vm_bootstrap() {
  local tarball_url=$1

  echo "==> Copying bootstrap.sh to VM..."
  gcloud compute scp scripts/bootstrap.sh "$VM_NAME:/tmp/bootstrap.sh" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --quiet

  echo "==> Creating expect script..."
  # Write expect script to local temp file to avoid quoting issues
  # Note: $tarball_url and $VM_FQDN are interpolated here (bash heredoc)
  # VM_FQDN is set by create_dns_record() which runs before this function
  local expect_script="/tmp/bootstrap-expect-$$.exp"
  cat > "$expect_script" <<EXPECT_EOF
#!/usr/bin/expect -f
set timeout 900
log_user 1

spawn sudo bash -c "SCALEBOX_RELEASE_URL='$tarball_url' bash /tmp/bootstrap.sh"

expect {
    "Enter API domain (or press Enter to skip HTTPS): " {
        send "$VM_FQDN\r"
        exp_continue
    }
    "Enter VM domain (optional, press Enter to skip): " {
        send "\r"
        exp_continue
    }
    timeout {
        puts "ERROR: Timeout waiting for prompt"
        exit 1
    }
    eof
}

# Capture exit code from spawned process
catch wait result
set exit_code [lindex \$result 3]
if {\$exit_code != 0} {
    puts "ERROR: Bootstrap exited with code \$exit_code"
}
exit \$exit_code
EXPECT_EOF

  echo "==> Copying expect script to VM..."
  gcloud compute scp "$expect_script" "$VM_NAME:/tmp/bootstrap.exp" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --quiet
  rm -f "$expect_script"

  echo "==> Installing expect on VM..."
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="sudo apt-get update -qq && sudo apt-get install -y -qq expect" \
    --quiet

  echo "==> Running bootstrap.sh with interactive prompts..."
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="chmod +x /tmp/bootstrap.exp && /tmp/bootstrap.exp"
}

get_api_token() {
  gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="sudo grep API_TOKEN /etc/scaleboxd/config | cut -d= -f2-" \
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

do_tarball() {
  do_build

  echo "==> Creating tarball..."
  local tarball="scalebox-test.tar.gz"

  # Create tarball from builds/ directory (same structure as release)
  tar -czf "$tarball" -C builds .

  echo "==> Created $tarball"
  ls -la "$tarball"
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

  # Get the firewall rule configuration
  local rule_config
  rule_config=$(gcloud compute firewall-rules describe scalebox-test-allow \
    --project="$GCLOUD_PROJECT" \
    --format='value(allowed)' 2>/dev/null) || true

  if [[ -z "$rule_config" ]]; then
    echo ""
    echo "Firewall rule 'scalebox-test-allow' not found."
    echo "Create it with:"
    echo ""
    echo "  gcloud compute firewall-rules create scalebox-test-allow \\"
    echo "    --project=$GCLOUD_PROJECT \\"
    echo "    --allow=tcp:443,tcp:8080,tcp:22001-32000 \\"
    echo "    --target-tags=scalebox-test \\"
    echo "    --description='Allow traffic to Scalebox test VMs'"
    echo ""
    die "Firewall rule not found"
  fi

  echo "==> Firewall rule allows: $rule_config"

  # Check for required ports
  local missing_ports=()

  # Check for HTTPS (443)
  if [[ "$rule_config" != *"443"* ]]; then
    missing_ports+=("tcp:443 (HTTPS)")
  fi

  # Check for HTTP API (8080)
  if [[ "$rule_config" != *"8080"* ]]; then
    missing_ports+=("tcp:8080 (HTTP API)")
  fi

  # Check for SSH proxy ports (22001-32000)
  # The rule should contain either "22001" or a range like "22000-32000"
  if [[ "$rule_config" != *"22001"* && "$rule_config" != *"22000-"* ]]; then
    missing_ports+=("tcp:22001-32000 (SSH proxy)")
  fi

  if [[ ${#missing_ports[@]} -gt 0 ]]; then
    echo ""
    echo "ERROR: Firewall rule is missing required ports:"
    for port in "${missing_ports[@]}"; do
      echo "  - $port"
    done
    echo ""
    echo "Update the firewall rule with:"
    echo ""
    echo "  gcloud compute firewall-rules update scalebox-test-allow \\"
    echo "    --project=$GCLOUD_PROJECT \\"
    echo "    --allow=tcp:443,tcp:8080,tcp:22001-32000"
    echo ""
    die "Firewall rule misconfigured"
  fi

  echo "==> Firewall rule OK"
}

do_check() {
  trap cleanup EXIT

  ensure_bun
  ensure_deps

  # Verify GCP project is set before any gcloud commands
  check_gcloud_project

  # Verify firewall rule exists before creating VM
  check_firewall_rule

  echo "==> Linting..."
  do_lint

  echo "==> Building and creating tarball..."
  do_tarball

  echo "==> Ensuring GCS bucket exists..."
  ensure_gcs_bucket

  echo "==> Uploading tarball to GCS..."
  local tarball_url
  tarball_url=$(upload_tarball "scalebox-test.tar.gz")
  echo "==> Tarball URL: $tarball_url"

  echo "==> Creating test VM..."
  create_vm
  wait_for_ssh
  create_dns_record

  echo "==> Running bootstrap.sh (interactive)..."
  if ! provision_vm_bootstrap "$tarball_url"; then
    echo "==> Bootstrap FAILED. Capturing debug info..."

    echo "==> Bootstrap output from VM:"
    gcloud compute ssh "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --command="cat /tmp/bootstrap.log 2>/dev/null || echo 'No bootstrap log found'" \
      --quiet || true

    echo "==> System logs:"
    gcloud compute ssh "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --command="journalctl -n 50 --no-pager" \
      --quiet || true

    exit 1
  fi

  echo "==> Verifying scaleboxd is running..."
  if ! gcloud compute ssh "$VM_NAME" \
    --zone="$GCLOUD_ZONE" \
    --project="$GCLOUD_PROJECT" \
    --command="systemctl is-active scaleboxd" \
    --quiet; then
    echo "==> scaleboxd not running. Bootstrap may have failed partially."
    gcloud compute ssh "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --command="journalctl -u scaleboxd -n 50 --no-pager" \
      --quiet || true
    exit 1
  fi

  echo "==> Getting API token..."
  local token
  token=$(get_api_token)
  [[ -n "$token" ]] || die "Failed to get API token"

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
  tarball) do_tarball ;;
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
  tarball            Build and create scalebox-test.tar.gz (same structure as releases)
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
