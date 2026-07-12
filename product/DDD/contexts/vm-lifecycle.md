# VM Lifecycle Context

**Classification:** Core Domain
**Source:** `src/services/vm.ts`, `src/services/nameGenerator.ts`, `src/services/wordlists.ts`

---

## Purpose

The VM Lifecycle context is the heart of Scalebox. It orchestrates the complete lifecycle of virtual machines: creation, operation, snapshotting, and deletion. This context coordinates all other contexts to deliver the system's core value.

---

## Aggregate: VM

The VM is the sole aggregate in this context and serves as the aggregate root.

### Identity

```typescript
id: string  // Format: "vm-{12 hex chars}", e.g., "vm-a1b2c3d4e5f6"
```

Generated via `crypto.randomBytes(6).toString("hex")`.

### State

```typescript
interface VM {
  id: string;           // Unique identifier
  name?: string;        // Human-readable name (e.g., "very-silly-penguin")
  template: string;     // Source template name
  ip: string;           // Allocated private IP (172.16.x.x)
  port: number;         // Allocated SSH proxy port
  pid: number;          // Firecracker process ID
  vcpuCount: number;    // Allocated vCPU count
  memSizeMib: number;   // Allocated RAM in MiB
  socketPath: string;   // Firecracker control socket
  rootfsPath: string;   // Path to VM's rootfs image
  tapDevice: string;    // Network interface name
  createdAt: Date;      // Creation timestamp
}
```

### Invariants

1. **Unique ID:** No two VMs share the same ID
2. **Unique Name:** No two VMs share the same name
3. **Resource Exclusivity:** Each VM has exclusive use of its IP, port, TAP device, and rootfs
4. **Valid Template:** VM can only be created from an existing template

### Lifecycle

```
                    ┌─────────┐
                    │ (none)  │
                    └────┬────┘
                         │ create
                         ▼
                    ┌─────────┐
         ┌─────────│ Running │─────────┐
         │         └─────────┘◄──┐     │
         │ snapshot     │        │     │
         ▼              │ delete │     │
    ┌─────────┐         │        │ restart
    │ Paused  │─────────┘        │     │
    └─────────┘                  └─────┘
         │ (auto-resume)               │
         └─────────────────────────────┤
                                       ▼
                                  ┌─────────┐
                                  │ Deleted │
                                  └─────────┘
```

**Note:** Paused state is internal only (during snapshot). API consumers only see "running" or deleted. `restart` is a self-transition (`Running --restart--> Running`): Firecracker is power-cycled in place while the VM keeps its identity, IP, port, and rootfs.

### Recovery paths (on startup)

On startup, `recoverVms()` replays each persisted VM from `state.json`:

```
        ┌──────────────────────┐
        │ persisted VM in       │
        │ state.json            │
        └──────────┬───────────┘
                   │
        ┌──────────┴───────────┐
        │ Firecracker PID alive?│
        └──────────┬───────────┘
           yes     │      no
        ┌──────────┘      └──────────┐
        ▼                            ▼
   reconnect              ┌────────────────────┐
   (re-register           │ rootfs present?     │
   proxies) → Running     └─────────┬──────────┘
                             yes     │     no
                          ┌──────────┘     └──────────┐
                          ▼                           ▼
                     relaunch                     removed
                     (start Firecracker           (cleanup dead
                     + proxies) → Running          resources)
```

---

## Value Objects

### CreateVMRequest

```typescript
interface CreateVMRequest {
  template: string;        // Required: source template name
  name?: string;           // Optional: custom name
  ssh_public_key: string;  // Required: SSH key for access
  vcpu_count?: number;     // Optional: CPU cores (default: 2)
  mem_size_mib?: number;   // Optional: RAM in MiB (default: 512)
}
```

### VMResponse (Read Model)

```typescript
interface VMResponse {
  id: string;
  name: string;
  template: string;
  ip: string;                // Host IP (for client connections, not internal bridge IP)
  ssh_port: number;
  ssh: string;               // Convenience: full SSH command
  url: string | null;        // HTTPS URL if baseDomain configured
  status: "running" | "stopped";
  created_at: string;
  console_log_path: string;  // Path to the VM's serial console log
  console_log_size: number;  // Current size of the console log in bytes
  degraded: boolean;         // True if the VM is flagged degraded by metrics
}
```

**Security Note:** VMResponse omits sensitive fields (pid, socketPath, rootfsPath, tapDevice) that are internal to the system.

### SnapshotResponse

```typescript
interface SnapshotResponse {
  template: string;      // Created template name
  source_vm: string;     // VM ID that was snapshotted
  size_bytes: number;    // Template file size
  created_at: string;
}
```

---

## Domain Services

### createVm(req: CreateVMRequest): Promise<VM>

Orchestrates VM creation by coordinating multiple contexts:

```
1. Validate template name format
2. Generate name (if not provided)
3. Generate unique VM ID
4. Allocate IP (Networking)
5. Allocate port (Networking)
6. Derive TAP device name from ID
7. Copy rootfs from template (Storage)
8. Initialize rootfs - SSH key, hostname, env vars, files, init script (Storage)
9. Create TAP device (Networking)
10. Start Firecracker process (Hypervisor)
11. Start TCP proxy (Access)
12. Store VM in memory
13. Return VM
```

**Failure Handling:** If any step fails, previously allocated resources are released (compensating transaction).

### deleteVm(vm: VM): Promise<void>

Orchestrates VM deletion:

```
1. Stop TCP proxy (Access)
2. Kill Firecracker process (Hypervisor)
3. Delete TAP device (Networking)
4. Delete rootfs file (Storage)
5. Release IP (Networking)
6. Release port (Networking)
7. Remove VM from memory
```

### restartVm(vm: VM, opts: RestartVmOptions): Promise<VM>

Power-cycles an existing VM in place, optionally resizing its disk or changing its vCPU/memory:

```
1. Stop Firecracker if the process is running (Hypervisor), waiting for exit
2. If a new disk size is requested: check available space (Storage) then grow rootfs offline (Storage)
3. Resolve vCPU/memory (overrides, falling back to persisted values)
4. Recreate the TAP device if it was torn down while stopped (Networking)
5. Start Firecracker with the same IP/rootfs/TAP/MAC (Hypervisor)
6. Persist the new pid/vcpuCount/memSizeMib and save state
7. Return the updated VM
```

The VM keeps its ID, name, IP, SSH port, TAP device, and rootfs, so the TCP/UDP proxies and Caddy configuration are left untouched (IP and name are unchanged). Only the disk may grow — it is never shrunk.

### snapshotVm(vm: VM, templateName: string): Promise<SnapshotResponse>

Creates a template from a running VM:

```
1. Validate template name format
2. Check template doesn't exist
3. Pause VM (Hypervisor)
4. Copy rootfs to templates (Storage)
5. Resume VM (Hypervisor)
6. Clear SSH keys from new template (Storage)
7. Return snapshot metadata
```

**Failure Handling:** If copying fails, VM is resumed before error is thrown.

### vmToResponse(vm: VM): VMResponse

Transforms internal VM to external representation, computing derived fields:
- `ip`: Host IP from config (replaces internal bridge IP with the server's externally-reachable address)
- `ssh`: Full SSH command string
- `url`: HTTPS URL (if baseDomain configured)
- `status`: Always "running" (stopped VMs are deleted)

---

## Supporting Services

### Name Generation

Located in `nameGenerator.ts` and `wordlists.ts`.

```typescript
generateUniqueName(): string
```

Generates three-word names in format `{adverb}-{adjective}-{noun}`:
- 30 adverbs × 100 adjectives × 100 nouns = 300,000 combinations
- Checks against existing VM names for uniqueness
- Retries up to 100 times
- Falls back to timestamp suffix if exhausted

### Concurrency Control

```typescript
withVmCreationLock<T>(fn: () => Promise<T>): Promise<T>
```

Mutex ensuring only one VM creation runs at a time. Prevents:
- Race conditions in IP/port allocation
- Duplicate name generation
- Resource exhaustion from parallel requests

---

## Repository

```typescript
const vms = new Map<string, VM>();
```

- **Persisted to disk:** VM state is saved to `/var/lib/scalebox/vms/state.json` after every creation and deletion
- **Recovery on startup:** `recoverVms()` reads state.json, checks if Firecracker PIDs are alive, and either reconnects (live process), **relaunches** (dead process, rootfs present), or cleans up (rootfs missing)
- **Reconciliation on startup:** `reconcileOrphans()` scans for system resources not tracked in the VM Map and cleans them up (orphaned processes, TAP devices, rootfs files)
- **Exported:** Accessed by Access context for Caddy configuration

---

## Domain Events (Implicit)

The system doesn't explicitly publish events, but these logical events occur:

| Event | Trigger | Side Effects |
|-------|---------|--------------|
| VMCreated | `createVm()` completes | Caddy config updated |
| VMDeleted | `deleteVm()` completes | Caddy config updated |
| VMSnapshotted | `snapshotVm()` completes | New template exists |

---

## Dependencies

| Context | Dependency Type | Purpose |
|---------|-----------------|---------|
| Template | Read | Copy rootfs from template |
| Networking | Read/Write | Allocate/release IP, port, TAP |
| Storage | Write | Copy rootfs, initialize VM environment |
| Hypervisor | Write | Start/stop/pause Firecracker |
| Access | Write | Start/stop proxy, update Caddy |

---

## Code Location

| Component | File | Lines |
|-----------|------|-------|
| VM type | `src/types.ts` | 1-12 |
| VM service | `src/services/vm.ts` | 1-231 |
| Name generator | `src/services/nameGenerator.ts` | 1-23 |
| Word lists | `src/services/wordlists.ts` | 1-257 |
