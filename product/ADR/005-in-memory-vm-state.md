# ADR-005: In-Memory VM State (No Persistence)

## Status

Accepted

## Context

The system needs to track running VMs. Options for state management:

1. **In-memory Map** - Simple JavaScript Map, lost on restart
2. **SQLite** - Embedded database, survives restart
3. **Redis** - External store, survives restart
4. **Filesystem** - State files per VM

## Decision

We chose **in-memory state** using a JavaScript Map. VM state is not persisted to disk.

## Rationale

### Why In-Memory

1. **VMs are ephemeral** - When the service restarts, Firecracker processes die. There's nothing to "resume" - the VMs are gone.

2. **Templates are the persistent state** - Users care about templates (their golden images). VMs are temporary workspaces created from templates.

3. **Simplicity** - No database schema, migrations, or connection handling. Just a Map.

4. **Consistency** - No risk of state/reality divergence. If the Map says a VM exists, it exists. No "zombie" records.

5. **Fast operations** - Map lookups are O(1). No database round-trips.

### Why Not Persistence

- **SQLite**: Adds complexity for no benefit. Can't restore VMs anyway.
- **Redis**: External dependency. Operational overhead not justified.
- **Filesystem**: State files can become inconsistent with reality.

### The Mental Model

```
Templates (persistent) → VM (ephemeral) → Template (persistent)
    ↓                       ↓                    ↑
  stored on disk      in-memory only       snapshot saves
```

Users should:
- Create VMs for work sessions
- Snapshot VMs they want to preserve
- Expect VMs to be gone after service restart

## Implementation

```typescript
// src/services/vm.ts
export const vms = new Map<string, VM>();

// Creation adds to map
vms.set(vmId, vm);

// Deletion removes from map
vms.delete(vm.id);

// Listing iterates map
Array.from(vms.values()).map(vmToResponse)
```

## Consequences

### Positive

- Zero operational complexity for state management
- No database backup/restore procedures
- No state corruption scenarios
- Predictable behavior on restart (clean slate)

### Negative

- Service restart kills all running VMs
- No VM "pause and resume later" functionality
- Cannot list "recently deleted" VMs
- No audit trail of VM history

### Neutral

- Prometheus metrics or external logging can provide history if needed
- Could add persistence later if requirements change

## Service Restart Behavior

When `scaleboxd` restarts:

1. All Firecracker processes die (they're children of scaleboxd)
2. In-memory Map is empty
3. Orphaned resources remain:
   - TAP devices (kernel manages, persist)
   - Rootfs files (on disk)
   - Allocated ports (reset in memory)

**Cleanup consideration**: A future enhancement could scan for orphaned resources on startup.

## References

- VM state definition: `src/types.ts:1-12`
- VM Map: `src/services/vm.ts:33`
- Design discussion: `product/plans/done/001-PLAN.md`
