# ADR-007: Bridge Networking with NAT

## Status

Accepted

## Context

VMs need network connectivity for:
- Outbound internet access (package installation, updates)
- Inbound SSH access (via TCP proxy)
- Potential VM-to-VM communication

Network topology options:

1. **Bridge + NAT** - VMs on private network, NAT for internet access
2. **Macvlan** - VMs appear as separate hosts on physical network
3. **Host networking** - VMs share host's network namespace
4. **Isolated** - No network connectivity

## Decision

We chose **bridge networking with NAT**. VMs connect to a Linux bridge and use iptables NAT for internet access.

## Rationale

### Why Bridge + NAT

1. **Isolation** - VMs are on a private network (172.16.0.0/16). Not directly exposed.

2. **Simple IP allocation** - Private range has 65K addresses. Sequential allocation is simple.

3. **Works everywhere** - Doesn't depend on cloud provider network features. Works on bare metal too.

4. **Outbound access** - NAT allows VMs to reach the internet for packages, APIs, etc.

5. **Controlled inbound** - All inbound traffic goes through TCP proxy. No direct VM exposure.

### Why Not Alternatives

- **Macvlan**: Requires cloud provider support. Complex IP management. Direct exposure risk.
- **Host networking**: No isolation between VMs. Security risk.
- **Isolated**: VMs can't install packages or reach external services. Too limiting.

## Implementation

### Network Topology

```
┌─────────────────────────────────────────────────┐
│                    HOST                         │
│                                                 │
│   eth0 (public IP)                              │
│     │                                           │
│     │  ┌──────────────────────────────────────┐│
│     │  │        iptables NAT                  ││
│     │  │  POSTROUTING -s 172.16.0.0/16        ││
│     │  │              -o eth0 -j MASQUERADE   ││
│     │  └──────────────────────────────────────┘│
│     │                                           │
│   br0 (172.16.0.1/16)                          │
│     │                                           │
│     ├── tap-vm1 ── VM 1 (172.16.0.2)           │
│     ├── tap-vm2 ── VM 2 (172.16.0.3)           │
│     └── tap-vm3 ── VM 3 (172.16.0.4)           │
│                                                 │
└─────────────────────────────────────────────────┘
```

### Components

**Bridge (br0)**:
- Created via systemd-networkd
- Static IP: 172.16.0.1/16
- Acts as default gateway for VMs

**TAP Devices**:
- One per VM (e.g., tap-abc123)
- Attached to bridge
- Created on VM start, deleted on VM stop

**iptables Rules**:
```bash
# NAT for outbound
iptables -t nat -A POSTROUTING -s 172.16.0.0/16 -o eth0 -j MASQUERADE

# Forward rules
iptables -A FORWARD -i br0 -o eth0 -j ACCEPT
iptables -A FORWARD -i eth0 -o br0 -m state --state RELATED,ESTABLISHED -j ACCEPT
```

**IP Allocation**:
- Sequential from 172.16.0.2
- Tracked in memory
- ~65K addresses available

## Consequences

### Positive

- Clean network isolation
- Simple, predictable IP scheme
- Works on any Linux host
- VMs can reach internet
- No cloud-specific dependencies

### Negative

- Requires IP forwarding enabled
- iptables rules need persistence (handled by install script)
- NetworkManager conflicts possible (mitigated by ignore rules)
- Bridge persists after service stops (cleanup consideration)

### Neutral

- VM-to-VM traffic flows through bridge (no extra config needed)
- MAC addresses derived from VM ID for consistency

## References

- Network setup: `scripts/install.sh:108-213`
- TAP creation: `src/services/network.ts:38-50`
- IP allocation: `src/services/network.ts:10-22`
