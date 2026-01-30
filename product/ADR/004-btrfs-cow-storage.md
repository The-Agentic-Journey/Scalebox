# ADR-004: Use btrfs with Reflinks for Copy-on-Write Storage

## Status

Accepted

## Context

VM creation requires copying a template rootfs (~2GB) to create each VM's disk. Naive copying would be:
- Slow (2GB copy takes several seconds)
- Storage inefficient (N VMs = N × 2GB)

Options considered:

1. **Full copy** - Simple `cp` of template to VM
2. **btrfs reflinks** - Copy-on-write at filesystem level
3. **LVM thin provisioning** - Block-level COW via device mapper
4. **Overlay filesystems** - Layer VM changes on read-only template
5. **qcow2 backing files** - QEMU's native COW format

## Decision

We chose **btrfs with reflinks** for VM storage.

## Rationale

### Why btrfs Reflinks

1. **Instant copies** - `cp --reflink=auto` completes in milliseconds regardless of file size. The kernel creates a reference, not a data copy.

2. **Transparent COW** - Writes to the VM rootfs automatically allocate new blocks. Template remains unchanged.

3. **Space efficiency** - VMs only consume space for blocks they modify. 100 identical VMs ≈ 1× storage.

4. **No special tooling** - Standard Linux filesystem. Works with normal tools (mount, cp, rm).

5. **Firecracker compatible** - Firecracker expects a regular file path for rootfs. btrfs files work transparently.

### Why Not Alternatives

- **Full copy**: Too slow and wastes storage. Unacceptable for responsive API.
- **LVM thin**: Requires LVM setup complexity. Block devices vs files adds operational overhead.
- **Overlay FS**: Doesn't work well with loop-mounted ext4 images. Layering complexity.
- **qcow2**: Would require qemu-img tools. Firecracker doesn't support qcow2 natively.

## Implementation

```bash
# Setup (in install.sh)
truncate -s 50G /var/lib/scalebox.img
mkfs.btrfs /var/lib/scalebox.img
mount -o loop /var/lib/scalebox.img /var/lib/scalebox

# VM creation (in storage.ts)
cp --reflink=auto templates/debian-base.ext4 vms/vm-abc123.ext4
```

## Consequences

### Positive

- VM creation is nearly instant
- Storage costs scale with actual modifications, not VM count
- Simple file-based model (no block device management)
- Standard filesystem tools work normally

### Negative

- Requires btrfs filesystem (not default on most distros)
- Must use loopback mount for portable installations
- btrfs has had historical stability concerns (mostly resolved)
- Filesystem must be mounted before service starts

### Neutral

- 50GB image file pre-allocated (can be resized)
- Added to fstab with `nofail` for boot resilience

## Measurements

| Operation | Without Reflinks | With Reflinks |
|-----------|------------------|---------------|
| Copy 2GB template | ~3-5 seconds | ~10ms |
| 10 VMs storage | 20GB | ~2GB + modifications |

## References

- [btrfs Reflinks](https://btrfs.readthedocs.io/en/latest/Reflink.html)
- [cp --reflink](https://www.gnu.org/software/coreutils/manual/html_node/cp-invocation.html)
- Implementation: `src/services/storage.ts:17` - `cp --reflink=auto`
