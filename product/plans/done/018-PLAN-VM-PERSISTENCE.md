# VM Persistence Plan

## Problem

VMs disappear after `scalebox-update` because:
1. VM state is stored only in-memory (`Map<string, VM>`)
2. `scalebox-update` restarts scaleboxd, clearing the Map
3. Firecracker processes may still be running (orphaned to init)
4. Rootfs files remain on disk at `/var/lib/scalebox/vms/`
5. But the API shows no VMs because the Map is empty

## Solution

Persist VM state to disk and recover on startup.

### Phase 1: Persist VM State to JSON File

**File: `src/services/vm.ts`**

Add functions to save/load VM state:

```typescript
const STATE_FILE = `${config.dataDir}/vms/state.json`;

interface PersistedVM {
  id: string;
  name: string;
  templateName: string;
  ip: string;
  tapDevice: string;
  sshPort: number;
  pid: number;
  socketPath: string;
  createdAt: string;
  // Note: status is not persisted - determined at recovery
}

function saveState(): void {
  const state = Array.from(vms.values()).map(vm => ({
    id: vm.id,
    name: vm.name,
    templateName: vm.templateName,
    ip: vm.ip,
    tapDevice: vm.tapDevice,
    sshPort: vm.sshPort,
    pid: vm.pid,
    socketPath: vm.socketPath,
    createdAt: vm.createdAt,
  }));
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
```

Call `saveState()` after:
- VM creation (in `createVm()`)
- VM deletion (in `deleteVm()`)

### Phase 2: Recover VMs on Startup

**File: `src/services/vm.ts`**

Add recovery function called at startup:

```typescript
export async function recoverVms(): Promise<void> {
  if (!fs.existsSync(STATE_FILE)) return;

  const state: PersistedVM[] = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));

  for (const saved of state) {
    // Check if Firecracker process is still running
    const isRunning = processExists(saved.pid);

    if (isRunning) {
      // Reconnect to running VM
      vms.set(saved.id, {
        ...saved,
        status: 'running',
      });
      // Re-register port allocation
      allocateSpecificPort(saved.sshPort);
      // Re-register IP allocation
      allocateSpecificIp(saved.ip);
      // Restart TCP proxy for this VM
      startProxy(saved.sshPort, saved.ip, 22);
    } else {
      // Process died - check if rootfs exists
      const rootfsPath = `${config.dataDir}/vms/${saved.id}.ext4`;
      if (fs.existsSync(rootfsPath)) {
        // Could restart VM or mark as stopped
        // For now, clean up orphaned resources
        cleanupVm(saved);
      }
    }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}
```

**File: `src/index.ts`**

Call recovery at startup:

```typescript
import { recoverVms } from "./services/vm";

// After cleanupOrphanedUdpRules()
await recoverVms();
```

### Phase 3: Handle Network State Recovery

**File: `src/services/network.ts`**

Add functions to re-allocate specific resources:

```typescript
export function allocateSpecificPort(port: number): void {
  allocatedPorts.add(port);
}

export function allocateSpecificIp(ip: string): void {
  // Mark IP as in use
  const lastOctet = parseInt(ip.split('.')[3]);
  allocatedIps.add(lastOctet);
}
```

### Phase 4: Graceful Shutdown

**File: `src/index.ts`**

Ensure state is saved on shutdown:

```typescript
process.on('SIGTERM', async () => {
  saveState();
  // Existing cleanup...
  process.exit(0);
});
```

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| src/services/vm.ts | Modify | Add saveState(), recoverVms() |
| src/services/network.ts | Modify | Add allocateSpecificPort(), allocateSpecificIp() |
| src/index.ts | Modify | Call recoverVms() at startup, saveState() on shutdown |

## Verification

```bash
# Create a VM
sb vm create -t debian-base

# Note the VM name
sb vm list

# Run update
scalebox-update

# VM should still be listed
sb vm list

# VM should still be connectable
sb connect <vm-name>
```

## Update Considerations

- **Config changes**: None
- **Storage changes**: New file `/var/lib/scalebox/vms/state.json`
- **Dependency changes**: None
- **Migration needed**: No - missing state file means no VMs to recover (correct for fresh install)
- **Backwards compatible**: Yes - old installations just have no state file initially

## Design Decisions

1. **JSON over SQLite**: Simpler, human-readable, sufficient for expected VM counts (<100)
2. **Process check**: Use `kill(pid, 0)` to check if Firecracker still runs
3. **Orphan cleanup**: If process died, clean up resources rather than restart
4. **State file location**: `/var/lib/scalebox/vms/state.json` alongside rootfs files

## Future Enhancements

- Auto-restart VMs that died unexpectedly
- Health monitoring for recovered VMs
- Periodic state file backups
