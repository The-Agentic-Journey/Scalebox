# HTTPS via Caddy Plan

This plan adds HTTPS support to scalebox using Caddy as a reverse proxy with automatic Let's Encrypt certificates, leveraging dynamic DNS records in the `testing.holderbaum.cloud` zone.

## Overview

| Component | Description |
|-----------|-------------|
| DNS Zone | `testing.holderbaum.cloud` (Cloud DNS, already delegated) |
| Reverse Proxy | Caddy with automatic Let's Encrypt |
| VM Hostname | `{vm-name}.testing.holderbaum.cloud` |

### Flow

```
./do check
    │
    ├── Create VM, get external IP
    ├── Create DNS: scalebox-test-xxx.testing.holderbaum.cloud → IP
    ├── Wait for DNS propagation
    ├── Provision VM with DOMAIN env var
    │       └── install.sh installs Caddy, gets Let's Encrypt cert
    ├── Run tests against https://scalebox-test-xxx.testing.holderbaum.cloud
    └── Cleanup: delete DNS record, delete VM
```

---

## Phase 0: Prerequisites (One-time)

### 0.1 Verify DNS zone exists

```bash
gcloud dns managed-zones describe testing-holderbaum-cloud
```

### 0.2 Update firewall rule to allow HTTPS

```bash
gcloud compute firewall-rules update scalebox-test-allow \
  --allow=tcp:443,tcp:8080,tcp:22001-32000
```

### Verification

```bash
gcloud dns managed-zones list | grep testing
gcloud compute firewall-rules describe scalebox-test-allow
```

---

## Phase 1: Update `do` script

### 1.1 Add DNS configuration variables

Add after the existing configuration variables:

```bash
DNS_ZONE="${DNS_ZONE:-testing-holderbaum-cloud}"
DNS_SUFFIX="${DNS_SUFFIX:-testing.holderbaum.cloud}"
```

### 1.2 Add `create_dns_record()` function

Add after `get_api_token()`:

```bash
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
```

### 1.3 Add `delete_dns_record()` function

Add after `create_dns_record()`:

```bash
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
```

### 1.4 Update `cleanup()` function

Add DNS cleanup before VM deletion:

```bash
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
```

### 1.5 Update `do_check()` function

Add DNS record creation after `wait_for_ssh` and before `provision_vm`:

```bash
# After: wait_for_ssh
create_dns_record

# Change provision_vm call to pass DOMAIN:
echo "==> Provisioning VM..."
DOMAIN="$VM_FQDN" provision_vm
```

Update the test execution to use HTTPS:

```bash
echo "==> Running tests against https://$VM_FQDN..."
VM_HOST="$VM_FQDN" USE_HTTPS=true API_TOKEN="$token" "$BUN_BIN" test
```

---

## Phase 2: Update `scripts/install.sh`

### 2.1 Add DOMAIN configuration variable

Add to the configuration section:

```bash
DOMAIN="${DOMAIN:-}"
```

### 2.2 Add `install_caddy()` function

Add before `install_binary()`:

```bash
# === Install Caddy (HTTPS reverse proxy) ===
install_caddy() {
  [[ -n "$DOMAIN" ]] || return 0

  log "Installing Caddy..."
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' 2>/dev/null | gpg --dearmor -o /usr/share/keyrings/caddy.gpg
  echo "deb [signed-by=/usr/share/keyrings/caddy.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy.list
  apt-get update -qq
  apt-get install -y -qq caddy

  log "Configuring Caddy for $DOMAIN..."
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  reverse_proxy localhost:$API_PORT
}
EOF

  systemctl enable caddy
  systemctl restart caddy
}
```

### 2.3 Add `wait_for_https()` function

Add after `install_caddy()`:

```bash
wait_for_https() {
  [[ -n "$DOMAIN" ]] || return 0

  log "Waiting for HTTPS certificate..."
  local retries=60
  while [[ $retries -gt 0 ]]; do
    if curl -sf "https://$DOMAIN/health" &>/dev/null; then
      log "HTTPS is ready"
      return 0
    fi
    sleep 2
    ((retries--)) || true
  done
  die "Failed to obtain TLS certificate for $DOMAIN"
}
```

### 2.4 Update `main()` function

Add calls after `start_service`:

```bash
start_service
install_caddy
wait_for_https
```

### 2.5 Update completion message

Update the API URL in the completion message:

```bash
if [[ -n "$DOMAIN" ]]; then
  echo "  API: https://$DOMAIN"
else
  echo "  API: http://$(hostname -I | awk '{print $1}'):$API_PORT"
fi
```

---

## Phase 3: Update test helpers

### 3.1 Update `test/helpers.ts`

Change the API URL construction to support HTTPS:

```typescript
// Configuration
export const VM_HOST = process.env.VM_HOST || "localhost";
export const API_PORT = process.env.API_PORT || "8080";
export const USE_HTTPS = process.env.USE_HTTPS === "true";
export const API_BASE_URL = USE_HTTPS
  ? `https://${VM_HOST}`
  : `http://${VM_HOST}:${API_PORT}`;
```

---

## Phase 4: Update firewall rule (one-time manual step)

```bash
gcloud compute firewall-rules update scalebox-test-allow \
  --allow=tcp:443,tcp:8080,tcp:22001-32000
```

---

## Verification

```bash
# Full test with HTTPS
./do check

# Expected output includes:
# ==> Creating DNS record: scalebox-test-xxx.testing.holderbaum.cloud -> 34.x.x.x
# ==> Waiting for DNS propagation...
# ==> DNS propagated
# ==> Provisioning VM...
# [scalebox] Installing Caddy...
# [scalebox] Waiting for HTTPS certificate...
# [scalebox] HTTPS is ready
# ==> Running tests against https://scalebox-test-xxx.testing.holderbaum.cloud...
# 19 pass
# ==> Deleting DNS record: scalebox-test-xxx.testing.holderbaum.cloud
# ==> Deleting VM: scalebox-test-xxx
```

---

## Files Summary

### Modified Files

| File | Changes |
|------|---------|
| `do` | Add DNS_ZONE, DNS_SUFFIX config; add create/delete_dns_record(); update cleanup(); update do_check() |
| `scripts/install.sh` | Add DOMAIN config; add install_caddy(), wait_for_https(); update main() and completion message |
| `test/helpers.ts` | Add USE_HTTPS support for API_BASE_URL |

### One-time Manual Steps

| Task | Command |
|------|---------|
| Update firewall | `gcloud compute firewall-rules update scalebox-test-allow --allow=tcp:443,tcp:8080,tcp:22001-32000` |

---

## Rollback

If HTTPS causes issues, the system falls back gracefully:
- If `DOMAIN` is not set, Caddy is not installed
- If `USE_HTTPS` is not set, tests use HTTP
- HTTP endpoint on port 8080 remains available

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| DNS propagation slow | 60-second timeout with 2s polling; TTL=60 for fast updates |
| Let's Encrypt rate limit | Own domain = 50 certs/week limit is ours alone |
| Caddy fails to start | wait_for_https() fails fast with clear error |
| DNS record orphaned | cleanup() deletes DNS before VM; trap EXIT ensures cleanup |
| Certificate not ready | 120-second wait with health check polling |
