# ADR-001: Use Firecracker as Hypervisor

## Status

Accepted

## Context

The system needs to run isolated virtual machines for users. Several options exist for running workloads in isolation:

1. **Docker/OCI containers** - Process-level isolation using namespaces and cgroups
2. **QEMU/KVM** - Full system virtualization with broad hardware emulation
3. **Firecracker** - Lightweight microVM using KVM with minimal device model
4. **gVisor** - User-space kernel providing sandbox isolation
5. **Kata Containers** - Combines container UX with VM isolation

## Decision

We chose **Firecracker** as the hypervisor for running user workloads.

## Rationale

### Why Firecracker

1. **Fast boot times (~125ms)** - MicroVMs start almost instantly, enabling on-demand VM creation without pre-warming pools

2. **Strong isolation** - Full VM isolation via KVM, not just namespace separation. Each VM has its own kernel.

3. **Minimal attack surface** - Stripped-down device model with only virtio-net, virtio-block, and serial console. No USB, GPU, or legacy devices.

4. **Low memory overhead** - ~5MB per VM versus ~130MB for QEMU. Enables high VM density.

5. **Simple API** - REST API over Unix socket for configuration. No complex libvirt stack.

6. **Production proven** - Powers AWS Lambda and Fargate at massive scale.

### Why Not Alternatives

- **Docker**: Insufficient isolation for multi-tenant workloads. Container escapes are a real risk.
- **QEMU**: Too slow to boot (~2-5 seconds) and high memory overhead. Over-featured for our needs.
- **gVisor**: Incomplete syscall compatibility can break applications unexpectedly.
- **Kata**: Additional complexity layering containers on VMs without benefit for our use case.

## Consequences

### Positive

- Sub-second VM creation enables responsive API
- Strong security isolation between VMs
- Efficient resource utilization on host
- Simple operational model (just processes)

### Negative

- Requires KVM support (nested virtualization on cloud, or bare metal)
- Limited to Linux guests only
- No GPU passthrough or advanced devices
- Must manage kernel images separately from rootfs

### Neutral

- Firecracker processes managed directly (no orchestrator like Kubernetes)
- Network setup requires TAP devices and bridges (handled by install script)

## References

- [Firecracker Design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)
- [Firecracker vs QEMU](https://www.brendangregg.com/blog/2023-02-13/firecracker.html)
- Initial commit: `0e9cd31` - "Initial plan for Firecracker VM API"
