# Bootstrap Testing Plan

## Overview

Replace `./do check` to test the full bootstrap flow that users experience, including interactive prompts. This ensures the README installation instructions actually work.

**Current state**: `./do check` runs `install.sh` directly with pre-built files, bypassing `bootstrap.sh` entirely.

**Target state**: `./do check` runs `bootstrap.sh` with interactive prompts, downloading a tarball from GCS (same structure as GitHub releases).

---

## What This Tests

| Component | Currently Tested | After This Plan |
|-----------|------------------|-----------------|
| Tarball structure matches release | No | Yes |
| bootstrap.sh syntax/logic | No | Yes |
| Interactive prompts work | No | Yes |
| Dependency auto-install (curl, jq) | No | Yes |
| install.sh discovery in tarball | No | Yes |
| Full install flow | Partial | Yes |
| API functionality | Yes | Yes |

---

## Prerequisites

- GCP project must allow public bucket access (some enterprise orgs restrict `allUsers` IAM bindings)
- If public buckets are restricted, modify to use signed URLs instead

---

## Phase 1: Add Release URL Override to Bootstrap

**Goal**: Allow bootstrap.sh to download from a custom URL instead of GitHub releases.

### Modify: `scripts/bootstrap.sh`

Add override support to `get_latest_release()`:

```bash
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
```

### Verification

```bash
# Test that override works by sourcing and calling the function
(
  source scripts/bootstrap.sh 2>/dev/null || true
  SCALEBOX_RELEASE_URL="https://example.com/test.tar.gz"
  result=$(get_latest_release)
  [[ "$result" == "https://example.com/test.tar.gz" ]] && echo "PASS" || echo "FAIL"
)
```

---

## Phase 2: Add Tarball Build Command

**Goal**: Create tarball with identical structure to GitHub releases.

### Modify: `do`

Add `do_tarball()` function after `do_build()`:

```bash
do_tarball() {
  do_build

  echo "==> Creating tarball..."
  local tarball="scalebox-test.tar.gz"

  # Create tarball from builds/ directory (same structure as release)
  tar -czf "$tarball" -C builds .

  echo "==> Created $tarball"
  ls -la "$tarball"
}
```

Add case for `tarball` command:

```bash
case "${1:-help}" in
  build) do_build ;;
  tarball) do_tarball ;;
  # ... rest
esac
```

Update help text to include `tarball` command.

### Verification

```bash
./do tarball

# Verify tarball contains required files at root level
tar -tzf scalebox-test.tar.gz | grep -E "^(scaleboxd|install.sh|scalebox|scaleboxd.service)$" | wc -l
# Should output: 4

# Verify extraction works
rm -rf /tmp/tarball-test && mkdir /tmp/tarball-test
tar -xzf scalebox-test.tar.gz -C /tmp/tarball-test
[[ -x /tmp/tarball-test/install.sh ]] && echo "install.sh OK" || echo "install.sh MISSING"
[[ -x /tmp/tarball-test/scaleboxd ]] && echo "scaleboxd OK" || echo "scaleboxd MISSING"
rm -rf /tmp/tarball-test
```

---

## Phase 3: Add GCS Upload/Download Functions

**Goal**: Upload test tarball to GCS with public read access, and clean up after tests.

### Modify: `do`

Add GCS variables near the top (after existing GCloud variables):

```bash
GCS_BUCKET="${GCS_BUCKET:-scalebox-test-artifacts}"
GCS_TARBALL_PATH=""
```

Add GCS helper functions:

```bash
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

  echo "==> Uploading tarball to GCS..."
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
```

Update `cleanup()` to include tarball deletion:

```bash
cleanup() {
  delete_dns_record
  delete_tarball
  if [[ -n "$VM_NAME" && "$KEEP_VM" != "true" ]]; then
    echo "==> Deleting VM: $VM_NAME"
    gcloud compute instances delete "$VM_NAME" \
      --zone="$GCLOUD_ZONE" \
      --project="$GCLOUD_PROJECT" \
      --quiet 2>/dev/null || true
  fi
}
```

### Verification

```bash
# Manual test of GCS functions
./do tarball
# Source the do script to get functions, then test upload/download/delete
```

---

## Phase 4: Add Bootstrap Provisioning Function

**Goal**: Replace direct `install.sh` execution with interactive `bootstrap.sh` execution using expect.

**Note**: This function intentionally does NOT set `SCALEBOX_NONINTERACTIVE`, so bootstrap.sh will run in interactive mode and display prompts that the expect script answers.

### Modify: `do`

Replace `provision_vm()` with `provision_vm_bootstrap()`:

```bash
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
```

### Key Design Decisions

1. **File-based expect script**: Avoids nested quoting issues with SSH + heredoc + expect
2. **Exact prompt matching**: Uses full prompt text from bootstrap.sh including trailing space:
   - `"Enter API domain (or press Enter to skip HTTPS): "`
   - `"Enter VM domain (optional, press Enter to skip): "`
3. **900s timeout**: Allows 15 minutes for full install including debootstrap
4. **Exit code propagation**: Captures bootstrap.sh exit code, logs errors, and returns it
5. **Interactive mode**: Does not set `SCALEBOX_NONINTERACTIVE` so prompts appear

### Verification

Tested as part of full `./do check` flow.

---

## Phase 5: Update do_check to Use Bootstrap Flow

**Goal**: Replace the current check flow with bootstrap-based flow.

### Modify: `do`

Replace `do_check()`:

```bash
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
```

### Verification

```bash
./do check
# Should:
# 1. Build tarball
# 2. Upload to GCS
# 3. Create VM
# 4. Run bootstrap.sh with expect (interactive prompts)
# 5. Verify scaleboxd is running
# 6. Run tests
# 7. Clean up (VM, DNS, GCS tarball)
```

---

## Phase 6: Remove Old Provisioning Code

**Goal**: Clean up unused code.

### Modify: `do`

Remove the old `provision_vm()` function (replaced by `provision_vm_bootstrap()`).

### Verification

```bash
./do check
# Full flow works without old function
```

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `scripts/bootstrap.sh` | Modify | Add `SCALEBOX_RELEASE_URL` override |
| `do` | Modify | Add tarball, GCS, and bootstrap provisioning |

---

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `SCALEBOX_RELEASE_URL` | Override release download URL | (GitHub API) |
| `GCS_BUCKET` | GCS bucket for test artifacts | `scalebox-test-artifacts` |
| `GCLOUD_PROJECT` | GCP project | (from gcloud config) |
| `GCLOUD_ZONE` | GCE zone | `us-central1-a` |

---

## Verification Checklist

After implementation, verify:

- [ ] `./do tarball` creates tarball with correct structure
- [ ] Tarball contains: `scaleboxd`, `install.sh`, `scalebox`, `scaleboxd.service`
- [ ] `./do check` uploads tarball to GCS
- [ ] GCS tarball is publicly accessible (curl returns 200)
- [ ] `./do check` runs bootstrap.sh (not install.sh directly)
- [ ] Interactive prompts are answered via expect
- [ ] API_DOMAIN is set to VM's FQDN
- [ ] Bootstrap failure is detected and reported
- [ ] scaleboxd service is verified running before token retrieval
- [ ] All integration tests pass
- [ ] GCS tarball is cleaned up after test
- [ ] VM is cleaned up after test
- [ ] DNS record is cleaned up after test

---

## Expect Script Explanation

The expect script handles the interactive prompts using a file-based approach to avoid shell quoting issues:

```expect
#!/usr/bin/expect -f
set timeout 900                    # 15 min timeout for full install
log_user 1                         # Show output for debugging

spawn sudo bash -c "SCALEBOX_RELEASE_URL='...' bash /tmp/bootstrap.sh"

expect {
    "Enter API domain (or press Enter to skip HTTPS): " {
        send "$VM_FQDN\r"          # Send the domain + Enter
        exp_continue               # Continue matching
    }
    "Enter VM domain (optional, press Enter to skip): " {
        send "\r"                  # Send just Enter (skip)
        exp_continue               # Continue matching
    }
    timeout {
        puts "ERROR: Timeout"
        exit 1
    }
    eof                            # Script finished
}

catch wait result                  # Get exit code
set exit_code [lindex $result 3]
if {$exit_code != 0} {
    puts "ERROR: Bootstrap exited with code $exit_code"
}
exit $exit_code                    # Exit with same code
```

This tests that:
1. The prompts appear correctly with exact text matching (including trailing space)
2. User input is accepted
3. The script continues after each prompt
4. Empty input (pressing Enter) works for optional prompts
5. Timeout is handled gracefully
6. Exit code is propagated for error detection
7. Non-zero exit codes are logged before propagation

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| GCS bucket permissions | Bucket created with `allUsers` objectViewer role |
| GCS URL not accessible | Public read enabled at bucket level (idempotent) |
| GCS public access restricted by org | Document requirement; alternative is signed URLs |
| GCS bucket race condition | Create with `|| true`, IAM binding always runs (idempotent) |
| expect not available | Installed via apt-get before use |
| Timeout during install | 900s (15 min) timeout covers debootstrap |
| Tarball URL expires | URL is simple GCS path, no expiration |
| Cleanup fails | Each cleanup step has `|| true` to continue |
| Bootstrap failure undetected | Explicit error check after `provision_vm_bootstrap` |
| Bootstrap partial failure | Verify `scaleboxd` service is running before token retrieval |
| Expect prompt mismatch | Uses exact prompt text from bootstrap.sh with trailing space |
| Nested quote escaping | File-based expect script avoids SSH quoting issues |
| Concurrent test runs | Unique tarball path includes timestamp + PID |
| VM_FQDN undefined | Set by `create_dns_record()` before `provision_vm_bootstrap()` |
