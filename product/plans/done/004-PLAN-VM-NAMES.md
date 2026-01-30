# Three-Word VM Names with HTTPS Subdomain Exposure

## Overview

Add two integrated features:
1. **Three-word unique VM names** (e.g., "very-silly-penguin") auto-generated for each VM
2. **HTTPS subdomain routing** where each VM's port 8080 is exposed at `https://{name}.{BASE_DOMAIN}`

**User responsibility:** Wildcard DNS (`*.basedomain.com` → host IP)

---

## Phase 1: Word Lists and Name Generator

### New file: `src/services/wordlists.ts`

Static word lists with ~30 adverbs, ~100 adjectives, and ~100 nouns (300K combinations):

**Format: `adverb-adjective-noun`** (e.g., "very-silly-penguin", "barely-happy-tiger")

- **Adverbs (intensifiers):** very, super, ultra, barely, almost, rather, quite, truly, fully, nearly, mostly, partly, fairly, really, highly, deeply, purely, simply, overly, extra, mildly, wildly, freshly, newly, softly, greatly, clearly, sweetly, gently, boldly
- **Adjectives:** amber, azure, bold, brave, bright, calm, clever, coral, cosmic, crisp, crystal, daring, eager, emerald, epic, fancy, fast, fierce, fluffy, foggy, fresh, friendly, frosty, frozen, fuzzy, gentle, giant, gleaming, golden, grand, happy, hidden, humble, icy, jolly, keen, kind, lively, lucky, lunar, magic, merry, mighty, misty, noble, peaceful, pretty, proud, purple, quick, quiet, rapid, royal, ruby, rustic, serene, shiny, silent, silver, smooth, snowy, soft, solar, steady, stormy, sunny, sweet, etc.
- **Nouns:** alpaca, badger, beacon, bear, beetle, bison, bobcat, breeze, canyon, cedar, cliff, cloud, cobra, condor, cougar, coyote, crane, dolphin, dragon, eagle, falcon, finch, fox, glacier, hawk, heron, jaguar, koala, lark, lemur, leopard, lion, lynx, magpie, mantis, maple, moose, narwhal, nebula, orca, osprey, otter, owl, panda, panther, parrot, pelican, penguin, phoenix, puffin, quail, rabbit, raven, salmon, seal, shark, sparrow, tiger, toucan, turtle, walrus, wolf, zebra, etc.

### New file: `src/services/nameGenerator.ts`

```typescript
export function generateUniqueName(): string {
  // Pick random adverb-adjective-noun
  // Check against existing VMs for uniqueness
  // Retry up to 100 times, fallback with timestamp suffix
}
```

---

## Phase 2: VM Integration

### Modify: `src/config.ts`

Add `baseDomain` configuration:
```typescript
baseDomain: process.env.BASE_DOMAIN || "",
```

### Modify: `src/types.ts`

Update `VMResponse`:
```typescript
interface VMResponse {
  // ... existing fields ...
  name: string;           // Now required (was optional)
  url: string | null;     // NEW: https://{name}.{BASE_DOMAIN} or null
}
```

### Modify: `src/services/vm.ts`

1. Import and call `generateUniqueName()` during VM creation
2. Call `updateCaddyConfig()` after VM create/delete
3. Update `vmToResponse()` to include `url` field

---

## Phase 3: Caddy Configuration Service

### New file: `src/services/caddy.ts`

```typescript
export async function updateCaddyConfig(): Promise<void> {
  // Generate Caddyfile with:
  // - Global on_demand_tls config
  // - Main API domain (if DOMAIN set)
  // - Wildcard *.BASE_DOMAIN with routes for each VM
  // Write to /etc/caddy/Caddyfile
  // Reload Caddy via systemctl
}
```

**Caddyfile structure:**
```
{
  on_demand_tls {
    ask http://localhost:8080/caddy/check
  }
}

*.vms.example.com {
  tls {
    on_demand
  }

  @very-silly-penguin host very-silly-penguin.vms.example.com
  handle @very-silly-penguin {
    reverse_proxy 172.16.0.2:8080
  }

  handle {
    respond "VM not found" 404
  }
}
```

### Modify: `src/index.ts`

Add `/caddy/check` endpoint (no auth required):
```typescript
app.get("/caddy/check", (c) => {
  // Validate domain parameter
  // Extract VM name from subdomain
  // Return 200 if VM exists, 404 otherwise
});
```

This endpoint is called by Caddy's on-demand TLS to verify subdomain validity before issuing certificates.

---

## Phase 4: Install Script Updates

### Modify: `scripts/install.sh`

1. Update `install_caddy()` to check for `BASE_DOMAIN` in addition to `DOMAIN`
2. Write initial Caddyfile with on-demand TLS config
3. Add `BASE_DOMAIN` to `/etc/scalebox/config`

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `src/services/wordlists.ts` | Create | Static word lists |
| `src/services/nameGenerator.ts` | Create | Name generation logic |
| `src/services/caddy.ts` | Create | Caddyfile management |
| `src/config.ts` | Modify | Add `baseDomain` |
| `src/types.ts` | Modify | Add `url` to VMResponse |
| `src/services/vm.ts` | Modify | Auto-generate names, trigger Caddy updates |
| `src/index.ts` | Modify | Add `/caddy/check` endpoint |
| `scripts/install.sh` | Modify | Support `BASE_DOMAIN`, update Caddy config |

---

## Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `BASE_DOMAIN` | Domain suffix for VM subdomains | `vms.example.com` |
| `DOMAIN` | Main API domain (existing) | `api.example.com` |

---

## Example API Response

```json
{
  "id": "vm-abc123def456",
  "name": "very-silly-penguin",
  "template": "debian-base",
  "ip": "172.16.0.2",
  "ssh_port": 22001,
  "ssh": "ssh -p 22001 root@host",
  "url": "https://very-silly-penguin.vms.example.com",
  "status": "running",
  "created_at": "2026-01-20T12:00:00.000Z"
}
```

---

## Verification

1. Run `./do check` to verify existing tests pass
2. Create a VM and verify it gets a three-word name
3. Create two VMs and verify they get different names
4. If `BASE_DOMAIN` is set:
   - Verify `url` field is populated in response
   - Verify `/caddy/check?domain={name}.{BASE_DOMAIN}` returns 200
   - Verify HTTPS request to VM subdomain reaches VM's port 8080

---

## Rollback

- Setting `BASE_DOMAIN=""` disables subdomain routing
- VMs still get names but `url` returns null
- Existing functionality unchanged
