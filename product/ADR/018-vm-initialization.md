# ADR-018: VM Initialization

## Status

Accepted

## Context

Users need cloud-init-like customization when creating VMs: setting environment variables, injecting files, and running initialization scripts. Without this, every VM starts as a blank clone of its template, requiring post-boot SSH commands to configure it for a specific purpose.

Options for delivering initialization:

1. **Pre-boot rootfs injection** - Write files into the rootfs while it is mounted, before Firecracker boots the VM
2. **Post-boot SSH execution** - Wait for the VM to boot, then SSH in and run setup commands
3. **cloud-init** - Install cloud-init in the base image and provide a user-data payload
4. **Custom kernel init** - Pass initialization data via kernel boot args

## Decision

We chose **pre-boot rootfs injection** for all three initialization primitives:

- **Environment variables**: Written to `~/.ssh/environment` for per-user scope. `PermitUserEnvironment yes` is set automatically in `/etc/ssh/sshd_config` during the mount phase.
- **Files**: Written directly into the rootfs at their target paths during the mount phase.
- **Init script**: Installed as a systemd one-shot service (`scalebox-init.service`) that runs on first boot and disables itself after execution.

All injection happens during a single consolidated mount of the rootfs, before Firecracker starts the VM.

## Rationale

### Why Pre-Boot Injection

1. **Faster** - No waiting for SSH readiness. The VM boots with everything already in place.

2. **More reliable** - Does not depend on SSH working. If sshd fails to start, post-boot approaches fail silently.

3. **Follows established patterns** - The rootfs is already mounted during VM creation for COW copy. Injection piggybacks on this existing mount phase.

4. **Consolidated I/O** - A single mount/unmount cycle handles all initialization, reducing overhead compared to multiple post-boot file transfers.

### Why `~/.ssh/environment`

1. **Per-user scope** - Variables are only available to the SSH user, not exposed system-wide to all processes and users.

2. **Base-image agnostic** - `PermitUserEnvironment` is set during mount, so base images do not need to be pre-configured. Any standard Linux image works.

3. **Works in all session types** - Available in both interactive and non-interactive SSH sessions, unlike `.bashrc` which only runs in interactive bash shells.

### Why Self-Disabling Systemd Service

1. **Runs once** - The service disables itself after execution, so snapshots of the VM do not re-run old init scripts.

2. **Clean snapshots** - Both the init script file and the systemd service are removed after execution, leaving no initialization artifacts.

3. **Boot integration** - Systemd handles ordering, logging, and error tracking natively.

### Why Not Alternatives

- **Post-boot SSH execution**: Adds latency waiting for SSH readiness. Couples initialization to SSH availability. Fails if sshd is misconfigured.
- **`/etc/environment`**: System-wide scope exposes variables to all users and processes. Not appropriate for per-user secrets or configuration.
- **`~/.bashrc`**: Bash-only. Not available in non-interactive sessions (e.g., `ssh host command`). Not available in other shells (zsh, fish).
- **cloud-init**: Heavy dependency for a simple use case. Requires cloud-init to be installed in every base image. Adds boot latency for its own initialization cycle.

## Implementation

### Environment Variables

```
# Written to /home/user/.ssh/environment
KEY1=value1
KEY2=value2
```

`PermitUserEnvironment yes` is appended to `/etc/ssh/sshd_config` if not already present.

### File Injection

Files are written to their target paths inside the mounted rootfs with specified ownership and permissions.

### Init Script

```ini
# /etc/systemd/system/scalebox-init.service
[Unit]
Description=Scalebox VM Init Script
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash /var/lib/scalebox-init.sh
ExecStartPost=/bin/bash -c 'systemctl disable scalebox-init.service && rm -f /etc/systemd/system/scalebox-init.service /var/lib/scalebox-init.sh'
RemainAfterExit=false

[Install]
WantedBy=multi-user.target
```

The init script runs as root during boot, after the network is available. After execution, the service disables itself and removes both the service unit and the script file.

## Consequences

### Positive

- Zero additional boot latency for initialization
- Works with any base image without pre-configuration
- Clean snapshots with no initialization artifacts
- Single mount phase for all initialization types
- Per-user environment variable scope

### Negative

- Init script runs asynchronously during boot — callers cannot know when it completes via the API
- Init script errors are only visible in the VM's journal, not in the API response
- Requires root access to the rootfs for injection (already available during mount phase)

### Neutral

- Could add init script completion signaling later (e.g., a status file or API callback)
- Could support multiple users in the future by parameterizing the home directory

## References

- Storage mount pattern: `src/services/storage.ts`
- VM initialization service: `src/services/init.ts`
- Plan: `product/plans/todo/030-PLAN-VM-INIT.md`
