# Access Context

**Classification:** Supporting Domain
**Source:** `src/services/proxy.ts`, `src/services/udpProxy.ts`, `src/services/caddy.ts`, `src/services/dns.ts`

---

## Purpose

The Access context provides external connectivity to VMs. It exposes VM services to the outside world through four mechanisms:

1. **TCP Proxy:** Port forwarding for SSH access
2. **UDP Proxy:** iptables NAT for mosh traffic
3. **HTTPS Gateway:** Caddy reverse proxy for web traffic with wildcard TLS
4. **DNS Server:** Built-in DNS for domain resolution and ACME DNS-01 challenges

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

## Sub-Context: UDP Proxy (Mosh)

### Purpose

Forwards UDP traffic for mosh sessions, enabling roaming shell access with better latency handling than SSH.

### Architecture

```
External Client                    Host                         VM
      │                             │                            │
      │   mosh user@host           │                            │
      │   --port=22001             │                            │
      │                             │                            │
      │   1. SSH (TCP 22001)       │                            │
      │ ──────────────────────────▶│ TCP Proxy ────────────────▶│ :22
      │   Start mosh-server -p 22001                            │
      │◀──────────────────────────│◀────────────────────────────│
      │   MOSH CONNECT 22001 <key> │                            │
      │                             │                            │
      │   2. UDP (22001)           │                            │
      │ ──────────────────────────▶│ iptables DNAT ────────────▶│ :22001
      │◀─────────────────────────▶│◀───────────────────────────▶│
      │   Encrypted mosh session    │                            │
```

### Implementation

Uses iptables NAT rules (not application-level proxy):
- **DNAT**: Rewrites destination to VM IP
- **MASQUERADE**: Ensures return packets route correctly

**iptables rules created per VM:**
```bash
# DNAT for incoming UDP
iptables -t nat -A PREROUTING -i eth0 -p udp --dport 22001 -j DNAT --to-destination 172.16.0.2:22001

# MASQUERADE for return traffic
iptables -t nat -A POSTROUTING -p udp -d 172.16.0.2 --dport 22001 -j MASQUERADE
```

### Port Sharing

The same port number serves both protocols:
- TCP 22001 → SSH (application proxy in scaleboxd)
- UDP 22001 → mosh (kernel-level NAT via iptables)

This works because TCP and UDP are independent protocols.

### Domain Services

#### startUdpProxy(vmId, localPort, targetIp, targetPort): Promise<void>

Creates iptables NAT rules for UDP forwarding.

```
1. Get external interface (from default route)
2. Track rule in memory (for cleanup)
3. Add DNAT rule for incoming UDP
4. Add MASQUERADE for return traffic
5. Verify rules were created
```

#### stopUdpProxy(vmId: string): Promise<void>

Removes iptables NAT rules using tracked state.

```
1. Look up rule from memory
2. Delete DNAT rule
3. Delete MASQUERADE rule
4. Remove from tracking
```

#### cleanupOrphanedUdpRules(): Promise<void>

Cleans up stale iptables rules on server startup. Since VMs don't survive restart (in-memory state), all rules targeting the VM subnet (172.16.x.x) are orphans.

### Lifecycle

| Event | Action |
|-------|--------|
| VM Created | Add iptables DNAT + MASQUERADE rules |
| VM Deleted | Remove iptables rules |
| Server Startup | Clean up orphaned rules from previous runs |

### Error Handling

| Scenario | Handling |
|----------|----------|
| iptables command fails | Rollback any partial rules, throw error |
| Rules already exist | Commands succeed (idempotent) |
| Cleanup fails | Best-effort, orphan rules are harmless |

---

## Sub-Context: HTTPS Gateway

### Purpose

Routes HTTPS traffic to VMs based on subdomain, with automatic TLS via a single wildcard certificate.

### Architecture

```
                        ┌─────────────────┐
                        │     Caddy       │
Internet ──── :443 ────▶│  Reverse Proxy  │
                        │                 │
                        │ *.vm.example.com│
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

Request: https://very-silly-penguin.vm.example.com → VM A:8080
```

### Domain Structure

Scalebox uses a single `BASE_DOMAIN` for the entire installation:

| Subdomain | Purpose | Example |
|-----------|---------|---------|
| `api.{BASE_DOMAIN}` | Scalebox API | `api.example.com` |
| `{name}.vm.{BASE_DOMAIN}` | VM HTTPS access | `very-silly-penguin.vm.example.com` |

### Domain Concepts

#### Base Domain

The single root domain for the Scalebox installation.

**Configuration:** `BASE_DOMAIN` environment variable
**Example:** `example.com`
**Prerequisite:** DNS NS record delegating the domain (or a subdomain) to the Scalebox host's DNS server

#### Wildcard Certificate

A single TLS certificate covering `*.vm.{BASE_DOMAIN}`, obtained via DNS-01 challenge.

**Flow:**
1. Caddy requests a wildcard certificate for `*.vm.{BASE_DOMAIN}` from Let's Encrypt
2. Let's Encrypt issues a DNS-01 challenge requiring a TXT record at `_acme-challenge.vm.{BASE_DOMAIN}`
3. Caddy's acmeproxy module delegates the challenge to the built-in DNS server
4. The DNS server serves the required TXT record
5. Let's Encrypt verifies the record and issues the wildcard certificate
6. All VM subdomains are covered by the single certificate — no per-VM issuance needed

#### DNS Server

A built-in DNS server that handles resolution for the Scalebox domain.

**Responsibilities:**
- Responds to `A` queries for `api.{BASE_DOMAIN}` with the host IP
- Responds to `A` queries for `*.vm.{BASE_DOMAIN}` with the host IP
- Serves `TXT` records for `_acme-challenge.vm.{BASE_DOMAIN}` during certificate issuance

#### ACME Proxy

The acmeproxy module configured in Caddy that bridges between Caddy's ACME client and the built-in DNS server. When Caddy needs to prove domain ownership for the wildcard certificate, the ACME proxy instructs the DNS server to create the required TXT record.

#### Caddyfile

Dynamic configuration file for Caddy routing rules.

**Location:** `/etc/caddy/Caddyfile`
**Managed by:** `updateCaddyConfig()` function

### Domain Services

#### updateCaddyConfig(): Promise<void>

Regenerates Caddy configuration based on current VMs.

```
1. If baseDomain not configured, skip
2. Build route for API:
   - Match: host api.{baseDomain}
   - Action: reverse_proxy localhost:8080
3. Build route for each VM:
   - Match: host {name}.vm.{baseDomain}
   - Action: reverse_proxy {vm-ip}:8080
4. Configure wildcard TLS with acmeproxy DNS-01
5. Write Caddyfile
6. Reload Caddy (systemctl reload caddy)
```

**Generated Caddyfile:**
```caddy
api.example.com {
  reverse_proxy localhost:8080
}

*.vm.example.com {
  tls {
    dns acmeproxy
  }

  @very-silly-penguin host very-silly-penguin.vm.example.com
  handle @very-silly-penguin {
    reverse_proxy 172.16.0.2:8080
  }

  @quite-bold-falcon host quite-bold-falcon.vm.example.com
  handle @quite-bold-falcon {
    reverse_proxy 172.16.0.3:8080
  }

  handle {
    respond "VM not found" 404
  }
}
```

### TLS Flow (DNS-01 Wildcard)

```
┌────────┐    ┌─────────┐    ┌────────────┐    ┌─────────────┐
│ Client │    │  Caddy  │    │ DNS Server │    │Let's Encrypt│
└───┬────┘    └────┬────┘    └─────┬──────┘    └──────┬──────┘
    │              │               │                   │
    │              │  Request wildcard cert             │
    │              │  *.vm.example.com                  │
    │              │──────────────────────────────────▶│
    │              │                                    │
    │              │  DNS-01 challenge: set TXT record  │
    │              │◀──────────────────────────────────│
    │              │                                    │
    │              │  acmeproxy:                        │
    │              │  set TXT record                    │
    │              │──────────────▶│                    │
    │              │       OK      │                    │
    │              │◀──────────────│                    │
    │              │                                    │
    │              │  Challenge ready                   │
    │              │──────────────────────────────────▶│
    │              │                                    │
    │              │               │  TXT query:        │
    │              │               │  _acme-challenge   │
    │              │               │  .vm.example.com   │
    │              │               │◀───────────────────│
    │              │               │  TXT response      │
    │              │               │───────────────────▶│
    │              │                                    │
    │              │  Wildcard certificate issued       │
    │              │◀──────────────────────────────────│
    │              │                                    │
    │  HTTPS req   │                                    │
    │─────────────▶│                                    │
    │  TLS response│                                    │
    │◀─────────────│                                    │
```

---

## When Access Context is Triggered

| Event | TCP Proxy | UDP Proxy | HTTPS Gateway |
|-------|-----------|-----------|---------------|
| VM Created | `startProxy()` | `startUdpProxy()` | `updateCaddyConfig()` |
| VM Deleted | `stopProxy()` | `stopUdpProxy()` | `updateCaddyConfig()` |
| Server Startup | - | `cleanupOrphanedUdpRules()` | - |

All are called from VM Lifecycle context after VM state changes.

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
| `BASE_DOMAIN` | "" | Root domain for the installation (empty = disabled) |

---

## External Dependencies

### TCP Proxy

| Dependency | Purpose |
|------------|---------|
| `node:net` | TCP server and socket |

### DNS Server

| Dependency | Purpose |
|------------|---------|
| `node:dgram` | UDP server for DNS protocol |

### HTTPS Gateway

| Dependency | Purpose |
|------------|---------|
| Caddy | Reverse proxy with wildcard TLS |
| Caddy acmeproxy module | DNS-01 challenge delegation to built-in DNS server |
| `systemctl` | Caddy reload |
| Let's Encrypt | Wildcard TLS certificate via DNS-01 |
| DNS delegation | NS record pointing to host for domain resolution |

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

| Component | File |
|-----------|------|
| TCP Proxy state | `src/services/proxy.ts` |
| startProxy | `src/services/proxy.ts` |
| stopProxy | `src/services/proxy.ts` |
| UDP Proxy state | `src/services/udpProxy.ts` |
| startUdpProxy | `src/services/udpProxy.ts` |
| stopUdpProxy | `src/services/udpProxy.ts` |
| cleanupOrphanedUdpRules | `src/services/udpProxy.ts` |
| updateCaddyConfig | `src/services/caddy.ts` |
| DNS Server | `src/services/dns.ts` |
