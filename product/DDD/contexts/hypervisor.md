# Hypervisor Context

**Classification:** Infrastructure Domain
**Source:** `src/services/firecracker.ts`

---

## Purpose

The Hypervisor context manages Firecracker microVM processes. It handles starting, stopping, configuring, and controlling the low-level hypervisor that runs VMs.

---

## Domain Concepts

### Firecracker Process

A running instance of the Firecracker hypervisor managing a single VM.

**Characteristics:**
- One process per VM
- Controlled via Unix socket API
- Lightweight (~5MB memory overhead)
- Fast boot (~125ms)

### Socket Path

Unix socket for communicating with a Firecracker instance.

**Pattern:** `/tmp/firecracker-{vm-id}.sock`
**Protocol:** HTTP over Unix socket
**API:** RESTful (PUT for configuration, PATCH for state changes)

### Firecracker Configuration

Value object containing all parameters needed to start a VM.

```typescript
interface FirecrackerConfig {
  socketPath: string;    // Control socket location
  kernelPath: string;    // Linux kernel image
  rootfsPath: string;    // VM's root filesystem
  bootArgs: string;      // Kernel command line
  tapDevice: string;     // Network interface
  macAddress: string;    // VM's MAC address
  vcpuCount: number;     // CPU cores
  memSizeMib: number;    // RAM in megabytes
}
```

### Kernel Arguments

Boot parameters passed to the Linux kernel.

**Format:**
```
console=ttyS0 reboot=k panic=1 pci=off ip={ip}::172.16.0.1:255.255.0.0::eth0:off
```

**Components:**
- `console=ttyS0`: Serial console for debugging
- `reboot=k`: Reboot on kernel panic
- `panic=1`: Panic timeout
- `pci=off`: Disable PCI (not needed in microVM)
- `ip=...`: Static IP configuration

---

## Domain Services

### startFirecracker(cfg: FirecrackerConfig): Promise<number>

Starts a new Firecracker process and configures the VM.

```
1. Remove old socket if exists
2. Start Firecracker process with --api-sock
3. Set up console logging to /tmp/fc-{id}-console.log
4. Wait for socket to be available (up to 5 seconds)
5. Configure VM via socket API:
   a. Set boot source (kernel + args)
   b. Set root drive (rootfs)
   c. Set network interface (TAP + MAC)
   d. Set machine config (vCPU + RAM)
6. Start VM instance
7. Verify process is still running
8. Return process PID
```

**Returns:** Process ID for later management

### stopFirecracker(pid: number): Promise<void>

Terminates a Firecracker process.

```
1. Send SIGTERM for graceful shutdown
2. Wait 500ms
3. Send SIGKILL if still running
4. Ignore errors (process may already be dead)
```

### pauseVm(socketPath: string): Promise<void>

Pauses a running VM (used during snapshotting).

```
PATCH http://localhost/vm
{"state": "Paused"}
```

**Effect:** VM stops executing but memory state is preserved.

### resumeVm(socketPath: string): Promise<void>

Resumes a paused VM.

```
PATCH http://localhost/vm
{"state": "Resumed"}
```

### buildKernelArgs(ip: string): string

Constructs kernel command line with IP configuration.

```typescript
return `console=ttyS0 reboot=k panic=1 pci=off ip=${ip}::172.16.0.1:255.255.0.0::eth0:off`;
```

---

## Firecracker API Communication

All configuration is done via HTTP over Unix socket using curl.

### Boot Source Configuration

```bash
curl --unix-socket {socket} \
  -X PUT http://localhost/boot-source \
  -H 'Content-Type: application/json' \
  -d '{"kernel_image_path": "/path/to/vmlinux", "boot_args": "..."}'
```

### Root Drive Configuration

```bash
curl --unix-socket {socket} \
  -X PUT http://localhost/drives/rootfs \
  -H 'Content-Type: application/json' \
  -d '{"drive_id": "rootfs", "path_on_host": "/path/to.ext4", "is_root_device": true, "is_read_only": false}'
```

### Network Configuration

```bash
curl --unix-socket {socket} \
  -X PUT http://localhost/network-interfaces/eth0 \
  -H 'Content-Type: application/json' \
  -d '{"iface_id": "eth0", "guest_mac": "AA:FC:...", "host_dev_name": "tap-..."}'
```

### Machine Configuration

```bash
curl --unix-socket {socket} \
  -X PUT http://localhost/machine-config \
  -H 'Content-Type: application/json' \
  -d '{"vcpu_count": 2, "mem_size_mib": 512}'
```

### Instance Start

```bash
curl --unix-socket {socket} \
  -X PUT http://localhost/actions \
  -H 'Content-Type: application/json' \
  -d '{"action_type": "InstanceStart"}'
```

---

## Process Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                    startFirecracker()                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌─────────┐     ┌─────────┐     ┌─────────┐             │
│   │ Spawn   │────▶│ Socket  │────▶│Configure│             │
│   │ Process │     │ Ready   │     │   VM    │             │
│   └─────────┘     └─────────┘     └────┬────┘             │
│                                        │                    │
│                                        ▼                    │
│                                   ┌─────────┐              │
│                                   │  Start  │              │
│                                   │Instance │              │
│                                   └────┬────┘              │
│                                        │                    │
│                                        ▼                    │
│                                   ┌─────────┐              │
│                                   │ Running │◀─────┐       │
│                                   └────┬────┘      │       │
│                                        │      resumeVm()   │
│                              pauseVm() │           │       │
│                                        ▼           │       │
│                                   ┌─────────┐      │       │
│                                   │ Paused  │──────┘       │
│                                   └─────────┘              │
│                                                             │
│                          stopFirecracker()                  │
│                                   │                         │
│                                   ▼                         │
│                              ┌─────────┐                   │
│                              │  Dead   │                   │
│                              └─────────┘                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Console Logging

VM console output is captured for debugging:

```
/tmp/fc-{vm-id}-console.log
```

**Content:** Linux boot messages, kernel logs, application output to ttyS0

**Implementation:** Stdout/stderr piped to log file asynchronously

---

## Error Handling

| Scenario | Handling |
|----------|----------|
| Socket not available in 5s | Throws "Firecracker socket not available" |
| Configuration fails | API response logged, may throw |
| Start returns fault_message | Throws with fault details |
| Process dies after start | Throws "Firecracker process died after start" |
| Stop fails | Silently ignored (process may be dead) |
| Pause/resume fails | Throws with fault message |

---

## External Dependencies

| Dependency | Purpose | Location |
|------------|---------|----------|
| `firecracker` | Hypervisor binary | PATH (installed by install.sh) |
| `curl` | API communication | System utility |
| Linux kernel | VM boot image | `/var/lib/scalebox/kernel/vmlinux` |
| Kernel version file | Tracks installed kernel version | `/var/lib/scalebox/kernel/version` |
| KVM | Hardware virtualization | `/dev/kvm` |

---

## Resource Requirements

| Resource | Per VM | Notes |
|----------|--------|-------|
| Memory | ~5MB + configured | Firecracker overhead ~5MB |
| CPU | Minimal when idle | Shares host CPUs |
| Disk | Socket + log file | ~1KB + log size |
| File descriptors | ~10 | Socket, log, TAP, etc. |

---

## Integration Points

### Called By: VM Lifecycle

```typescript
// VM creation
const pid = await startFirecracker({
  socketPath,
  kernelPath: config.kernelPath,
  rootfsPath,
  bootArgs: buildKernelArgs(ip),
  tapDevice,
  macAddress: vmIdToMac(vmId),
  vcpuCount: req.vcpu_count || config.defaultVcpuCount,
  memSizeMib: req.mem_size_mib || config.defaultMemSizeMib,
});

// VM deletion
await stopFirecracker(vm.pid);

// VM snapshotting
await pauseVm(vm.socketPath);
// ... copy rootfs ...
await resumeVm(vm.socketPath);
```

---

## Code Location

| Component | File | Lines |
|-----------|------|-------|
| FirecrackerConfig | `src/services/firecracker.ts` | 4-13 |
| startFirecracker | `src/services/firecracker.ts` | 15-88 |
| waitForSocket | `src/services/firecracker.ts` | 90-101 |
| configureVm | `src/services/firecracker.ts` | 103-156 |
| startVm | `src/services/firecracker.ts` | 158-162 |
| stopFirecracker | `src/services/firecracker.ts` | 164-178 |
| buildKernelArgs | `src/services/firecracker.ts` | 180-182 |
| pauseVm | `src/services/firecracker.ts` | 184-190 |
| resumeVm | `src/services/firecracker.ts` | 192-198 |
