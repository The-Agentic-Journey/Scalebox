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
         │         └─────────┘         │
         │ snapshot     │              │
         ▼              │ delete       │
    ┌─────────┐         │              │
    │ Paused  │─────────┘              │
    └─────────┘                        │
         │ (auto-resume)               │
         └─────────────────────────────┤
                                       ▼
                                  ┌─────────┐
                                  │ Deleted │
                                  └─────────┘
```

**Note:** Paused state is internal only (during snapshot). API consumers only see "running" or deleted.

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
  ip: string;
  ssh_port: number;
  ssh: string;           // Convenience: full SSH command
  url: string | null;    // HTTPS URL if baseDomain configured
  status: "running" | "stopped";
  created_at: string;
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
8. Inject SSH public key (Storage)
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

## Repository (In-Memory)

```typescript
const vms = new Map<string, VM>();
```

- **No persistence:** VMs are lost on server restart
- **Design decision:** VMs are ephemeral; persistent state is in templates
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
| Storage | Write | Copy rootfs, inject keys |
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
