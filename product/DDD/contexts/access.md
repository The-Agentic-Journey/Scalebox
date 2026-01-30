# Access Context

**Classification:** Supporting Domain
**Source:** `src/services/proxy.ts`, `src/services/caddy.ts`

---

## Purpose

The Access context provides external connectivity to VMs. It exposes VM services to the outside world through two mechanisms:

1. **TCP Proxy:** Port forwarding for SSH access
2. **HTTPS Gateway:** Caddy reverse proxy for web traffic

---

## Sub-Context: TCP Proxy

### Purpose

Maps host ports to VM internal ports, enabling SSH access without directly exposing VMs.

### Architecture

```
External Client                    Host                         VM
      │                             │                            │
      │   ssh -p 22001 root@host   │                            │
      │ ──────────────────────────▶│                            │
      │                             │                            │
      │                        ┌────┴────┐                       │
      │                        │  Proxy  │                       │
      │                        │ Server  │                       │
      │                        │ :22001  │                       │
      │                        └────┬────┘                       │
      │                             │   TCP connect              │
      │                             │   172.16.0.2:22            │
      │                             │ ─────────────────────────▶│
      │                             │                            │
      │◀────────────────────────────┼────────────────────────────│
      │        Bidirectional data piping                         │
```

### Domain Concepts

#### Proxy Server

A TCP server listening on a host port that forwards connections to a VM.

**State:**
```typescript
const proxies = new Map<string, net.Server>();      // vmId → server
const connections = new Map<string, Set<net.Socket>>(); // vmId → active sockets
```

#### Connection Pair

Two sockets (client ↔ VM) piped together for bidirectional data transfer.

### Domain Services

#### startProxy(vmId, localPort, targetIp, targetPort): Promise<void>

Creates a TCP proxy server for a VM.

```
1. Create socket tracking set for VM
2. Create TCP server
3. On client connection:
   a. Track client socket
   b. Connect to VM (targetIp:targetPort)
   c. Track VM socket
   d. Pipe client ↔ VM bidirectionally
   e. Handle errors and cleanup
4. Listen on localPort
5. Store server reference
```

#### stopProxy(vmId: string): void

Stops a proxy and cleans up connections.

```
1. Get all sockets for VM
2. Destroy each socket
3. Close server
4. Remove from tracking maps
```

### Connection Lifecycle

```
┌────────────┐  connect   ┌────────────┐  connect   ┌────────────┐
│   Client   │ ─────────▶ │   Proxy    │ ─────────▶ │     VM     │
└────────────┘            └────────────┘            └────────────┘
      │                         │                         │
      │◀─────────────────pipe──────────────────────────▶│
      │                         │                         │
      │  close/error            │                         │
      │ ────────────────────────│                         │
      │                         │  destroy                │
      │                         │ ────────────────────────│
```

### Error Handling

| Event | Response |
|-------|----------|
| Client error | Destroy VM socket, remove from tracking |
| VM error | Destroy client socket, remove from tracking |
| Client close | Destroy VM socket, remove from tracking |
| VM close | Destroy client socket, remove from tracking |

---

## Sub-Context: HTTPS Gateway

### Purpose

Routes HTTPS traffic to VMs based on subdomain, with automatic TLS certificates.

### Architecture

```
                        ┌─────────────────┐
                        │     Caddy       │
Internet ──── :443 ────▶│  Reverse Proxy  │
                        │                 │
                        │ *.vms.example.com│
                        └────────┬────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
          ▼                      ▼                      ▼
   ┌────────────┐         ┌────────────┐         ┌────────────┐
   │   VM A     │         │   VM B     │         │   VM C     │
   │ very-silly-│         │ quite-bold-│         │ super-calm-│
   │ penguin    │         │ falcon     │         │ tiger      │
   │  :8080     │         │  :8080     │         │  :8080     │
   └────────────┘         └────────────┘         └────────────┘

Request: https://very-silly-penguin.vms.example.com → VM A:8080
```

### Domain Concepts

#### Base Domain

The configured domain suffix for VM subdomains.

**Configuration:** `BASE_DOMAIN` environment variable
**Example:** `vms.example.com`
**Prerequisite:** Wildcard DNS (`*.vms.example.com` → host IP)

#### On-Demand TLS

Caddy's mechanism for obtaining certificates only when first requested.

**Flow:**
1. Client requests `https://very-silly-penguin.vms.example.com`
2. Caddy checks `/caddy/check?domain=very-silly-penguin.vms.example.com`
3. If 200, Caddy obtains Let's Encrypt certificate
4. If 404, request is rejected

#### Caddyfile

Dynamic configuration file for Caddy routing rules.

**Location:** `/etc/caddy/Caddyfile`
**Managed by:** `updateCaddyConfig()` function

### Domain Services

#### updateCaddyConfig(): Promise<void>

Regenerates Caddy configuration based on current VMs.

```
1. If baseDomain not configured, skip
2. Build route for each VM:
   - Match: host {name}.{baseDomain}
   - Action: reverse_proxy {vm-ip}:8080
3. Write Caddyfile
4. Reload Caddy (systemctl reload caddy)
```

**Generated Caddyfile:**
```caddy
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

  @quite-bold-falcon host quite-bold-falcon.vms.example.com
  handle @quite-bold-falcon {
    reverse_proxy 172.16.0.3:8080
  }

  handle {
    respond "VM not found" 404
  }
}
```

### Caddy Check Endpoint

Located in `src/index.ts` (not in Access context files):

```typescript
app.get("/caddy/check", (c) => {
  const domain = c.req.query("domain");
  // Extract VM name from domain
  // Check if VM exists
  // Return 200 or 404
});
```

### TLS Flow

```
┌────────┐    ┌─────────┐    ┌────────────┐    ┌─────────────┐
│ Client │    │  Caddy  │    │ Scalebox   │    │Let's Encrypt│
└───┬────┘    └────┬────┘    │   API      │    └──────┬──────┘
    │              │         └─────┬──────┘           │
    │  HTTPS req   │               │                  │
    │─────────────▶│               │                  │
    │              │ /caddy/check  │                  │
    │              │──────────────▶│                  │
    │              │     200 OK    │                  │
    │              │◀──────────────│                  │
    │              │                                  │
    │              │  ACME challenge                  │
    │              │─────────────────────────────────▶│
    │              │  Certificate                     │
    │              │◀─────────────────────────────────│
    │              │                                  │
    │  TLS response│                                  │
    │◀─────────────│                                  │
```

---

## When Access Context is Triggered

| Event | TCP Proxy | HTTPS Gateway |
|-------|-----------|---------------|
| VM Created | `startProxy()` | `updateCaddyConfig()` |
| VM Deleted | `stopProxy()` | `updateCaddyConfig()` |

Both are called from VM Lifecycle context after VM state changes.

---

## Configuration

### TCP Proxy

| Setting | Default | Description |
|---------|---------|-------------|
| `PORT_MIN` | 22001 | Start of port range |
| `PORT_MAX` | 32000 | End of port range |

### HTTPS Gateway

| Setting | Default | Description |
|---------|---------|-------------|
| `BASE_DOMAIN` | "" | Domain suffix (empty = disabled) |

---

## External Dependencies

### TCP Proxy

| Dependency | Purpose |
|------------|---------|
| `node:net` | TCP server and socket |

### HTTPS Gateway

| Dependency | Purpose |
|------------|---------|
| Caddy | Reverse proxy with auto-TLS |
| `systemctl` | Caddy reload |
| Let's Encrypt | TLS certificates |
| Wildcard DNS | `*.{baseDomain}` → host |

---

## Error Handling

### TCP Proxy

| Scenario | Handling |
|----------|----------|
| Port in use | Server creation fails, exception propagates |
| VM unreachable | Connection error, sockets cleaned up |
| Client disconnect | VM socket destroyed |

### HTTPS Gateway

| Scenario | Handling |
|----------|----------|
| Caddy not installed | `systemctl reload` fails |
| Write Caddyfile fails | Exception propagates |
| baseDomain not set | Function returns early (no-op) |

---

## Code Location

| Component | File | Lines |
|-----------|------|-------|
| Proxy state | `src/services/proxy.ts` | 3-4 |
| startProxy | `src/services/proxy.ts` | 6-56 |
| stopProxy | `src/services/proxy.ts` | 58-74 |
| updateCaddyConfig | `src/services/caddy.ts` | 9-49 |
| /caddy/check endpoint | `src/index.ts` | 21-37 |
