# ADR-009: Caddy for HTTPS with Automatic TLS

## Status

Accepted

## Context

The system needs HTTPS support for:
- API endpoint security
- VM subdomain routing (each VM at `https://{name}.domain.com`)
- Automatic certificate management

Reverse proxy options:

1. **Caddy** - Automatic HTTPS, simple config
2. **nginx** - Industry standard, manual cert management
3. **Traefik** - Dynamic config, container-focused
4. **HAProxy** - High performance, complex config
5. **Direct TLS** - Handle TLS in the application

## Decision

We chose **Caddy** as the HTTPS reverse proxy with automatic Let's Encrypt certificates.

## Rationale

### Why Caddy

1. **Automatic HTTPS** - Obtains and renews Let's Encrypt certificates automatically. Zero manual cert management.

2. **On-demand TLS** - Can request certificates when first accessed. Perfect for dynamic VM subdomains.

3. **Simple config** - Caddyfile syntax is minimal. Easy to generate dynamically.

4. **Ask endpoint** - On-demand TLS can validate domains via HTTP endpoint before issuing certs. Prevents abuse.

5. **Hot reload** - `systemctl reload caddy` applies config changes without dropping connections.

### Why Not Alternatives

- **nginx**: Requires certbot or similar for Let's Encrypt. Manual renewal setup. Complex config syntax.
- **Traefik**: More complex, designed for container orchestration. Overkill for our use case.
- **HAProxy**: No built-in ACME support. Would need separate cert management.
- **Direct TLS**: Would need to implement ACME protocol. Significant complexity.

## Implementation

### Architecture

```
Internet
    │
    │ HTTPS (:443)
    ▼
┌─────────────────────────────────────┐
│              Caddy                  │
│                                     │
│  *.vms.example.com (on-demand TLS) │
│         │                           │
│    ┌────┴────┐                      │
│    │ Route   │                      │
│    │ by host │                      │
│    └────┬────┘                      │
│         │                           │
│  vm-name.vms.example.com            │
│         │                           │
│    reverse_proxy 172.16.0.X:8080   │
│                                     │
└─────────────────────────────────────┘
```

### On-Demand TLS Validation

```
Client requests: https://very-silly-penguin.vms.example.com
    │
    ▼
Caddy: "Should I get a cert for this domain?"
    │
    ▼
GET http://localhost:8080/caddy/check?domain=very-silly-penguin.vms.example.com
    │
    ▼
Scalebox: "Is there a VM named 'very-silly-penguin'?"
    │
    ├── Yes → 200 OK → Caddy obtains certificate
    └── No  → 404    → Caddy rejects request
```

### Dynamic Caddyfile Generation

```typescript
// src/services/caddy.ts
const caddyfile = `{
  on_demand_tls {
    ask http://localhost:8080/caddy/check
  }
}

*.${config.baseDomain} {
  tls {
    on_demand
  }

  @${vm.name} host ${vm.name}.${config.baseDomain}
  handle @${vm.name} {
    reverse_proxy ${vm.ip}:8080
  }

  handle {
    respond "VM not found" 404
  }
}`;

await writeFile("/etc/caddy/Caddyfile", caddyfile);
await exec("systemctl reload caddy");
```

## Consequences

### Positive

- Zero certificate management overhead
- Dynamic VM subdomains work automatically
- Abuse prevention via ask endpoint
- Simple operational model

### Negative

- Additional service to run (Caddy)
- Config regeneration on every VM create/delete
- Let's Encrypt rate limits (50 certs/week/domain)
- Requires wildcard DNS setup by user

### Neutral

- Caddy installed conditionally (only if DOMAIN or BASE_DOMAIN set)
- HTTP API still available on port 8080 for internal use

## Configuration

| Variable | Purpose | Example |
|----------|---------|---------|
| `DOMAIN` | Main API domain | `api.example.com` |
| `BASE_DOMAIN` | VM subdomain suffix | `vms.example.com` |

## References

- Caddy config generation: `src/services/caddy.ts`
- Check endpoint: `src/index.ts:21-37`
- Caddy installation: `scripts/install.sh:276-325`
- Plan: `product/plans/done/003-PLAN-HTTPS.md`
