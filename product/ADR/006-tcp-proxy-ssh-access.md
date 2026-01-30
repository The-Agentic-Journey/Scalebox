# ADR-006: TCP Proxy for SSH Access

## Status

Accepted

## Context

Users need SSH access to their VMs. VMs are on a private network (172.16.0.0/16) not directly accessible from the internet. Options:

1. **Direct port exposure** - Each VM gets a public IP or port-forwarded directly
2. **TCP proxy** - Application-level port forwarding through the API server
3. **SSH bastion/jump host** - SSH to host, then SSH to VM
4. **VPN** - Connect users to the private network
5. **WebSocket tunnel** - Browser-based terminal access

## Decision

We chose **TCP proxy** implemented in the API server. Each VM gets a unique host port that forwards to the VM's SSH port.

## Rationale

### Why TCP Proxy

1. **Simple user experience** - Users SSH directly: `ssh -p 22001 root@host`. No extra hops.

2. **No public IPs needed** - VMs stay on private network. Only the host needs a public IP.

3. **Port-based isolation** - Each VM gets a unique port. Easy to understand and firewall.

4. **Built-in to API** - No separate service to deploy. Proxy starts when VM starts.

5. **Transparent to SSH** - Standard SSH client works. No special tools required.

### Why Not Alternatives

- **Direct exposure**: Would need public IPs or complex port mapping. Security exposure.
- **Bastion**: Extra hop adds latency and complexity. Poor UX.
- **VPN**: Requires client software. Complex setup for users.
- **WebSocket**: Would need browser-based terminal. Not all use cases fit.

## Implementation

```typescript
// src/services/proxy.ts
const server = net.createServer((clientSocket) => {
  const vmSocket = net.createConnection(22, vmIp);
  clientSocket.pipe(vmSocket);
  vmSocket.pipe(clientSocket);
});
server.listen(allocatedPort, "0.0.0.0");
```

Port allocation:
- Range: 22001-32000 (~10,000 ports)
- Allocation: First available in range
- Lifecycle: Started on VM creation, stopped on VM deletion

## Network Flow

```
User's Machine                    Host                         VM
     │                             │                            │
     │  ssh -p 22001 root@host    │                            │
     │ ──────────────────────────▶│                            │
     │                             │                            │
     │                        ┌────┴────┐                       │
     │                        │  Proxy  │                       │
     │                        │ :22001  │                       │
     │                        └────┬────┘                       │
     │                             │   TCP → 172.16.0.2:22     │
     │                             │ ─────────────────────────▶│
     │                             │                            │
     │◀────────────────────────────┼───────────────────────────│
     │           Bidirectional SSH traffic                     │
```

## Consequences

### Positive

- Standard SSH clients work unchanged
- Port per VM is easy to understand
- Firewall rules are straightforward
- No additional software for users

### Negative

- Port exhaustion with many VMs (~10K limit)
- Port numbers in API response (users must note them)
- Proxy adds minimal latency
- All SSH traffic flows through API process

### Neutral

- Could add SSH jump host mode later as alternative
- Connection tracking in memory (reset on restart)

## API Response

```json
{
  "id": "vm-abc123",
  "ssh_port": 22001,
  "ssh": "ssh -p 22001 root@host.example.com",
  ...
}
```

The `ssh` field provides a ready-to-use command.

## References

- Proxy implementation: `src/services/proxy.ts`
- Port allocation: `src/services/network.ts:24-36`
- Architecture diagram: `product/plans/done/001-PLAN.md`
