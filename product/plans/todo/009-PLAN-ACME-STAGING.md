# Plan: ACME Staging Support for CI

## Overview

Add support for Let's Encrypt staging environment to avoid rate limits in CI. The staging environment has no rate limits but issues untrusted certificates (fine for automated testing).

## Problem

Let's Encrypt limits certificate issuance to **50 certificates per registered domain per 7 days**. CI creates unique subdomains for each test run (e.g., `scalebox-test-123.testing.holderbaum.cloud`), quickly exhausting this limit.

## Solution

Add `ACME_STAGING=true` environment variable that configures Caddy to use Let's Encrypt staging instead of production.

## Design Decisions

1. **Environment variable toggle** - `ACME_STAGING=true` enables staging
2. **Persisted to config** - Saved in `/etc/scaleboxd/config` so caddy.ts can read it
3. **Caddyfile global option** - Uses `acme_ca` directive in global options block
4. **Insecure curl for verification** - Uses `curl -k` when staging is enabled (staging certs aren't browser-trusted)

## Implementation Phases

### Phase 1: Modify install.sh

**File:** `scripts/install.sh`

1. Add `ACME_STAGING` to configuration section (line ~17):
   ```bash
   ACME_STAGING="${ACME_STAGING:-false}"
   ```

2. Modify `install_caddy()` to include staging CA in Caddyfile when enabled:
   ```bash
   # In install_caddy(), after the opening brace in Caddyfile:
   if [[ "$ACME_STAGING" == "true" ]]; then
       # Add staging CA directive
       acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
   fi
   ```

3. Modify `wait_for_https()` to use `-k` flag when staging is enabled:
   ```bash
   if [[ "$ACME_STAGING" == "true" ]]; then
       curl_opts="-sfk"
   else
       curl_opts="-sf"
   fi
   ```

4. Save `ACME_STAGING` to config file in `create_config()`:
   ```bash
   ACME_STAGING=$ACME_STAGING
   ```

### Phase 2: Modify config.ts and caddy.ts

**File:** `src/config.ts`

Add acmeStaging config option:
```typescript
acmeStaging: process.env.ACME_STAGING === "true",
```

**File:** `src/services/caddy.ts`

Include staging CA when regenerating Caddyfile:
```typescript
const acmeCa = config.acmeStaging
    ? '\n\tacme_ca https://acme-staging-v02.api.letsencrypt.org/directory'
    : '';

const caddyfile = `{${acmeCa}
    on_demand_tls {
        ...
    }
}
...`;
```

### Phase 3: Modify CI to use staging

**File:** `do`

1. Update `provision_vm_bootstrap()` to pass ACME_STAGING=true:
   ```bash
   spawn sudo bash -c "SCALEBOX_RELEASE_URL='$tarball_url' ACME_STAGING=true bash /tmp/bootstrap.sh"
   ```

2. Update curl commands that verify HTTPS to use `-k` flag (in `do_check_update()`):
   ```bash
   gcloud compute ssh ... --command="curl -sfk http://localhost:8080/health"
   ```

3. Set `NODE_TLS_REJECT_UNAUTHORIZED=0` when running integration tests:
   ```bash
   NODE_TLS_REJECT_UNAUTHORIZED=0 VM_HOST="$VM_FQDN" USE_HTTPS=true API_TOKEN="$token" "$BUN_BIN" test
   ```
   This allows Bun's `fetch()` to accept untrusted staging certificates.

### Phase 4: Update Documentation

**File:** `product/DDD/glossary.md`

Add entry for ACME Staging under Access Terms.

**File:** `README.md`

Document ACME_STAGING option in configuration table.

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `scripts/install.sh` | Modify | Add ACME_STAGING support in Caddyfile generation |
| `src/config.ts` | Modify | Add acmeStaging config option |
| `src/services/caddy.ts` | Modify | Include staging CA when regenerating Caddyfile |
| `do` | Modify | Pass ACME_STAGING=true for CI tests |
| `product/DDD/glossary.md` | Modify | Document ACME staging concept |
| `README.md` | Modify | Document ACME_STAGING configuration |

## Verification

1. **Local syntax check:**
   ```bash
   bash -n scripts/install.sh
   ```

2. **Run CI tests:**
   ```bash
   ./do check
   ./do check-update
   ```
   Both should pass without Let's Encrypt rate limit errors.

3. **Verify staging CA in generated Caddyfile:**
   SSH to test VM and check `/etc/caddy/Caddyfile` contains:
   ```
   acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
   ```

4. **Verify cert is from staging:**
   ```bash
   curl -vk https://{vm-fqdn}/health 2>&1 | grep "issuer"
   # Should show "(STAGING)" in issuer name
   ```

## Update Considerations

- **Config changes**: New `ACME_STAGING` key with default `false` - backwards compatible
- **No storage changes**: Just Caddyfile content changes
- **No new dependencies**: Uses existing Caddy capabilities
