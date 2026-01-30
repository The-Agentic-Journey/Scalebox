# ADR-008: Bearer Token Authentication

## Status

Accepted

## Context

The API needs authentication to prevent unauthorized VM creation/deletion. Options:

1. **Bearer token** - Single shared secret in Authorization header
2. **API keys** - Per-user/application keys with optional scopes
3. **OAuth 2.0** - Token-based with refresh flow
4. **mTLS** - Mutual TLS with client certificates
5. **No auth** - Rely on network isolation only

## Decision

We chose **bearer token authentication** - a single shared secret validated on each request.

## Rationale

### Why Bearer Token

1. **Simple implementation** - One config value, one middleware check. Done.

2. **Sufficient for use case** - Single-tenant deployment. One operator, one token.

3. **Standard protocol** - `Authorization: Bearer <token>` is well-understood. Works with curl, SDKs, etc.

4. **Hono built-in** - Framework provides `bearerAuth` middleware out of the box.

5. **Easy rotation** - Change `API_TOKEN` env var, restart service.

### Why Not Alternatives

- **API keys**: Over-engineered for single-tenant. No need for per-user tracking.
- **OAuth**: Massive complexity for internal API. No external identity provider needed.
- **mTLS**: Operational overhead of certificate management. Hard to use with curl.
- **No auth**: Too risky. Anyone with network access could create/delete VMs.

## Implementation

```typescript
// src/index.ts
import { bearerAuth } from "hono/bearer-auth";

// Public endpoints (no auth)
app.get("/health", (c) => c.json({ status: "ok" }));
app.get("/caddy/check", (c) => { /* ... */ });

// Protected endpoints
app.use("/*", bearerAuth({ token: config.apiToken }));
app.get("/vms", /* ... */);
app.post("/vms", /* ... */);
```

### Token Generation

```bash
# During install (scripts/install.sh)
API_TOKEN="sb-$(openssl rand -hex 24)"
```

Tokens are 51 characters: `sb-` prefix + 48 hex chars (192 bits of entropy).

### Token Storage

```bash
# /etc/scalebox/config (mode 600)
API_TOKEN=sb-abc123...
```

File permissions restrict access to root.

## Usage

```bash
# Set token
export TOKEN="sb-abc123..."

# Make authenticated request
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/vms
```

## Consequences

### Positive

- Minimal code complexity
- Easy to understand and debug
- Works with any HTTP client
- No external dependencies

### Negative

- Single token = all-or-nothing access (no fine-grained permissions)
- Token in memory/config (not a secrets manager)
- No audit trail of who made requests
- Token rotation requires restart

### Neutral

- Could add API keys or OAuth later if multi-tenant needed
- Rate limiting could be added at middleware level

## Security Considerations

1. **Token entropy**: 192 bits prevents brute force
2. **HTTPS required**: Token transmitted in header, must use TLS in production
3. **Token exposure**: Logged carefully, not included in error responses
4. **File permissions**: Config file is mode 600

## References

- Auth middleware: `src/index.ts:40`
- Token config: `src/config.ts:3`
- Token generation: `scripts/install.sh:375`
