# ADR-012: Systemd Service Management

## Status

Accepted

## Context

The API server needs to run as a background service. Options:

1. **Systemd** - Native Linux service manager
2. **Docker Compose** - Container orchestration
3. **PM2** - Node.js process manager
4. **Supervisor** - Python-based process control
5. **Screen/tmux** - Manual background processes

## Decision

We chose **systemd** for service management.

## Rationale

### Why Systemd

1. **Native to Linux** - No additional software to install. Present on all modern distros.

2. **Robust supervision** - Automatic restart on crash. Configurable restart policies.

3. **Boot integration** - Service starts automatically after reboot.

4. **Logging** - Journal integration with `journalctl`. Structured logs.

5. **Dependency ordering** - Can depend on network, storage mounts.

6. **Resource control** - cgroups integration for limits.

### Why Not Alternatives

- **Docker Compose**: Adds container layer. Firecracker needs direct KVM access.
- **PM2**: Node.js specific. Bun binary doesn't need it.
- **Supervisor**: Extra dependency. Systemd does the same job.
- **Screen/tmux**: Not production-grade. No auto-restart.

## Implementation

### Service Unit File

```ini
# scripts/scaleboxd.service
[Unit]
Description=Scalebox VM Manager
After=network-online.target systemd-networkd.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/scalebox/config
ExecStart=/usr/local/bin/scaleboxd
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Key Directives

| Directive | Purpose |
|-----------|---------|
| `After=network-online.target` | Wait for network before starting |
| `After=systemd-networkd.service` | Wait for bridge to be configured |
| `EnvironmentFile` | Load config from /etc/scalebox/config |
| `Restart=always` | Restart on any exit |
| `RestartSec=5` | Wait 5 seconds between restarts |
| `WantedBy=multi-user.target` | Start on normal boot |

### Configuration File

```bash
# /etc/scalebox/config
API_PORT=8080
API_TOKEN=sb-abc123...
DATA_DIR=/var/lib/scalebox
KERNEL_PATH=/var/lib/scalebox/kernel/vmlinux
BASE_DOMAIN=vms.example.com
```

### Management Commands

```bash
# Start/stop/restart
sudo systemctl start scaleboxd
sudo systemctl stop scaleboxd
sudo systemctl restart scaleboxd

# Enable/disable auto-start
sudo systemctl enable scaleboxd
sudo systemctl disable scaleboxd

# Check status
sudo systemctl status scaleboxd

# View logs
sudo journalctl -u scaleboxd -f
sudo journalctl -u scaleboxd --since "1 hour ago"
```

## Consequences

### Positive

- Standard Linux tooling
- Reliable process supervision
- Integrated logging
- Boot persistence
- No extra software

### Negative

- Linux-specific (no macOS/Windows)
- Configuration split between unit file and env file
- Service must be restarted to pick up config changes

### Neutral

- Could add socket activation later for on-demand startup
- Could add resource limits (MemoryMax, CPUQuota) if needed

## Dependencies

The service has ordered dependencies:

```
network-online.target
         │
         ▼
systemd-networkd.service (creates br0)
         │
         ▼
    scaleboxd.service
```

This ensures the bridge exists before the service tries to create VMs.

## References

- Service file: `scripts/scaleboxd.service`
- Installation: `scripts/install.sh:366-399`
- Plan: `product/plans/done/002-PLAN-SCALEBOX.md`
