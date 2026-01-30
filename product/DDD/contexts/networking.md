# Networking Context

**Classification:** Infrastructure Domain
**Source:** `src/services/network.ts`

---

## Purpose

The Networking context manages network resource allocation and virtual network interfaces. It provides VMs with unique IP addresses, external-facing ports, and TAP devices for host connectivity.

---

## Domain Concepts

### IP Address Pool

An implicit aggregate managing IP allocation from the `172.16.0.0/16` private range.

**Allocation Strategy:** Sequential starting from `172.16.0.2`
- `172.16.0.1` is reserved for the bridge (br0)
- Addresses increment: `.2`, `.3`, ... `.255`, `172.16.1.0`, etc.
- Supports ~65,000 VMs theoretically

**State:**
```typescript
const allocatedIps = new Set<string>();
let nextIpCounter = 2;  // Current allocation counter
```

### Port Pool

An implicit aggregate managing SSH proxy port allocation.

**Allocation Strategy:** Sequential scan from `portMin` to `portMax`
- Default range: 22001-32000 (~10,000 ports)
- First available port is allocated
- Released ports can be reused

**State:**
```typescript
const allocatedPorts = new Set<number>();
```

### TAP Device

A value object representing a virtual network interface.

**Naming Convention:** `tap-{vm-id-prefix}`
- Linux limits interface names to 15 characters
- Format: `tap-` (4 chars) + 10 hex chars from VM ID
- Example: `tap-a1b2c3d4e5` for VM `vm-a1b2c3d4e5f6`

### MAC Address

A value object derived deterministically from VM ID.

**Format:** `AA:FC:XX:XX:XX:XX`
- Prefix `AA:FC` indicates Scalebox-managed interface
- Remaining 4 octets from VM ID's hex portion
- Example: `AA:FC:A1:B2:C3:D4` for VM `vm-a1b2c3d4e5f6`

---

## Domain Services

### allocateIp(): string

Allocates the next available IP address.

```typescript
// Allocation logic
const high = Math.floor(nextIpCounter / 256);
const low = nextIpCounter % 256;
const ip = `172.16.${high}.${low}`;
allocatedIps.add(ip);
nextIpCounter++;
return ip;
```

**Invariant:** Never returns an already-allocated IP.

### releaseIp(ip: string): void

Returns an IP to the pool.

```typescript
allocatedIps.delete(ip);
```

**Note:** Released IPs are NOT reused in current implementation (counter keeps incrementing).

### allocatePort(portMin: number, portMax: number): number

Allocates an available port within the configured range.

```typescript
for (let port = portMin; port <= portMax; port++) {
  if (!allocatedPorts.has(port)) {
    allocatedPorts.add(port);
    return port;
  }
}
throw new Error("No available ports");
```

**Error:** Throws if all ports exhausted.

### releasePort(port: number): void

Returns a port to the pool for reuse.

```typescript
allocatedPorts.delete(port);
```

### createTapDevice(tapName: string): Promise<void>

Creates and configures a TAP device for VM networking.

```bash
# Commands executed:
sudo ip tuntap add {tapName} mode tap user $(whoami)
sudo ip link set {tapName} master br0
sudo ip link set {tapName} up
```

**Prerequisites:**
- Bridge `br0` must exist
- User must have sudo access

### deleteTapDevice(tapName: string): Promise<void>

Removes a TAP device.

```bash
sudo ip link del {tapName}
```

**Resilience:** Ignores errors if device doesn't exist.

### vmIdToMac(vmId: string): string

Derives MAC address from VM ID.

```typescript
const hex = vmId.replace("vm-", "");
const parts = hex.slice(0, 8).match(/.{2}/g) || [];
return `AA:FC:${parts.join(":")}`.toUpperCase();
```

---

## Network Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        HOST                                 │
│                                                             │
│  ┌─────────┐      ┌──────────────────────────────────────┐ │
│  │  eth0   │      │           br0 (172.16.0.1/16)        │ │
│  │ (public)│      │                                      │ │
│  └────┬────┘      │  ┌────────┐  ┌────────┐  ┌────────┐ │ │
│       │           │  │ tap-a1 │  │ tap-b2 │  │ tap-c3 │ │ │
│       │           │  └───┬────┘  └───┬────┘  └───┬────┘ │ │
│       │           └──────┼──────────┼──────────┼────────┘ │
│       │                  │          │          │          │
│  ┌────┴────┐        ┌────┴────┐┌────┴────┐┌────┴────┐    │
│  │   NAT   │        │  VM 1   ││  VM 2   ││  VM 3   │    │
│  │iptables │        │.0.2    ││ .0.3    ││ .0.4    │    │
│  └─────────┘        └─────────┘└─────────┘└─────────┘    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Traffic Flow:**
1. VM → Bridge → NAT → Internet (outbound)
2. Host:22001 → Proxy → VM:22 (SSH inbound)
3. Caddy → VM:8080 (HTTPS inbound)

---

## Resource Limits

| Resource | Limit | Determined By |
|----------|-------|---------------|
| IP Addresses | ~65,534 | 172.16.0.0/16 range |
| Ports | ~10,000 | PORT_MIN to PORT_MAX |
| TAP Devices | Kernel limit | Usually thousands |

---

## Persistence

**None.** All state is in-memory:
- Allocated IPs: `Set<string>`
- Allocated ports: `Set<number>`
- IP counter: `number`

On restart:
- TAP devices persist (kernel manages)
- IP/port pools reset (orphaned resources possible)

**Design Decision:** VMs don't survive restart, so network state doesn't need persistence.

---

## Error Handling

| Scenario | Handling |
|----------|----------|
| Port exhaustion | Throws `Error("No available ports")` |
| TAP creation fails | Exception propagates (VM creation fails) |
| TAP deletion fails | Silently ignored (device may not exist) |

---

## Integration Points

### Called By: VM Lifecycle

```typescript
// During VM creation
const ip = allocateIp();
const port = allocatePort(config.portMin, config.portMax);
await createTapDevice(tapDevice);
const mac = vmIdToMac(vmId);

// During VM deletion
await deleteTapDevice(vm.tapDevice);
releaseIp(vm.ip);
releasePort(vm.port);
```

### External Dependencies

| Dependency | Purpose |
|------------|---------|
| `ip` command | TAP device management |
| `br0` bridge | Must exist (created by install.sh) |
| `sudo` | TAP operations require root |

---

## Code Location

| Component | File | Lines |
|-----------|------|-------|
| IP allocation | `src/services/network.ts` | 4-22 |
| Port allocation | `src/services/network.ts` | 24-36 |
| TAP management | `src/services/network.ts` | 38-50 |
| MAC derivation | `src/services/network.ts` | 52-58 |
