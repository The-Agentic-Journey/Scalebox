# Bounded Context Map

This document provides an overview of all bounded contexts in the Scalebox system and their relationships.

---

## Context Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              SCALEBOX SYSTEM                                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│                        ┌─────────────────────────┐                              │
│                        │    VM LIFECYCLE         │                              │
│                        │    (Core Domain)        │                              │
│                        │                         │                              │
│                        │  Aggregate: VM          │                              │
│                        │  src/services/vm.ts     │                              │
│                        └───────────┬─────────────┘                              │
│                                    │                                            │
│              ┌─────────────────────┼─────────────────────┐                      │
│              │                     │                     │                      │
│              ▼                     ▼                     ▼                      │
│   ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐              │
│   │   TEMPLATE      │   │   NETWORKING    │   │    ACCESS       │              │
│   │  (Supporting)   │   │ (Infrastructure)│   │  (Supporting)   │              │
│   │                 │   │                 │   │                 │              │
│   │ Aggregate:      │   │ Services:       │   │ Sub-contexts:   │              │
│   │ Template        │   │ IP/Port Pool    │   │ - TCP Proxy     │              │
│   │                 │   │ TAP Device      │   │ - HTTPS Gateway │              │
│   │ src/services/   │   │                 │   │                 │              │
│   │ template.ts     │   │ src/services/   │   │ src/services/   │              │
│   └─────────────────┘   │ network.ts      │   │ proxy.ts        │              │
│                         └────────┬────────┘   │ caddy.ts        │              │
│                                  │            └─────────────────┘              │
│                                  │                                              │
│              ┌───────────────────┴───────────────────┐                          │
│              │                                       │                          │
│              ▼                                       ▼                          │
│   ┌─────────────────┐                     ┌─────────────────┐                  │
│   │    STORAGE      │                     │   HYPERVISOR    │                  │
│   │ (Infrastructure)│                     │ (Infrastructure)│                  │
│   │                 │                     │                 │                  │
│   │ Services:       │                     │ Services:       │                  │
│   │ Rootfs Mgmt     │                     │ Firecracker     │                  │
│   │ SSH Key Inject  │                     │ Process Control │                  │
│   │                 │                     │                 │                  │
│   │ src/services/   │                     │ src/services/   │                  │
│   │ storage.ts      │                     │ firecracker.ts  │                  │
│   └─────────────────┘                     └─────────────────┘                  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Contexts by Strategic Classification

### Core Domain

| Context | Purpose | Strategic Value |
|---------|---------|-----------------|
| **VM Lifecycle** | Orchestrates VM creation, deletion, and snapshotting | Highest - this is the product's core value proposition |

### Supporting Domains

| Context | Purpose | Strategic Value |
|---------|---------|-----------------|
| **Template** | Manages reusable VM images | High - enables fast, repeatable VM creation |
| **Access** | Provides external connectivity to VMs | High - makes VMs usable |

### Infrastructure Domains

| Context | Purpose | Strategic Value |
|---------|---------|-----------------|
| **Networking** | Allocates IPs, ports, and network interfaces | Medium - commodity but essential |
| **Storage** | Manages rootfs files with COW optimization | Medium - commodity but essential |
| **Hypervisor** | Controls Firecracker processes | Medium - commodity but essential |

---

## Context Relationships

### VM Lifecycle → Template
**Relationship:** Customer-Supplier
**Direction:** VM Lifecycle depends on Template
**Integration:**
- VM creation reads from Template context to copy rootfs
- VM snapshotting writes to Template context to create new templates

### VM Lifecycle → Networking
**Relationship:** Customer-Supplier
**Direction:** VM Lifecycle depends on Networking
**Integration:**
- VM creation requests IP, port, and TAP device allocation
- VM deletion releases allocated network resources

### VM Lifecycle → Storage
**Relationship:** Customer-Supplier
**Direction:** VM Lifecycle depends on Storage
**Integration:**
- VM creation copies rootfs and injects SSH keys
- VM deletion removes rootfs
- Snapshotting copies rootfs to template location

### VM Lifecycle → Hypervisor
**Relationship:** Customer-Supplier
**Direction:** VM Lifecycle depends on Hypervisor
**Integration:**
- VM creation starts Firecracker process
- VM deletion stops Firecracker process
- Snapshotting pauses/resumes VM

### VM Lifecycle → Access
**Relationship:** Customer-Supplier
**Direction:** VM Lifecycle depends on Access
**Integration:**
- VM creation starts TCP proxy
- VM deletion stops TCP proxy
- VM creation/deletion triggers Caddy config update

### Template → Storage
**Relationship:** Shared Kernel
**Direction:** Both operate on same storage paths
**Integration:**
- Template listing reads from templates directory
- Template deletion removes files from templates directory

---

## Anti-Corruption Layers

The system currently has minimal ACL needs due to:
1. Single codebase (no external bounded context integration)
2. Infrastructure contexts are thin wrappers around system calls
3. All contexts share the same data model conventions

**Future consideration:** If integrating external VM providers (AWS, GCP), an ACL would be needed to translate between provider-specific models and Scalebox's domain model.

---

## Shared Kernel

The following are shared across contexts:

| Shared Element | Location | Used By |
|----------------|----------|---------|
| `config` | `src/config.ts` | All contexts |
| `VM` type | `src/types.ts` | VM Lifecycle, Access |
| `vms` Map | `src/services/vm.ts` | VM Lifecycle, Access (Caddy) |

---

## Context Communication

All context communication is **synchronous** and **in-process**:

```
API Request
    │
    ▼
┌─────────────────┐
│  HTTP Handler   │  (src/index.ts)
│  (Application)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  VM Lifecycle   │  Orchestrates all operations
│  (Domain)       │
└────────┬────────┘
         │
    ┌────┴────┬─────────┬──────────┬─────────┐
    ▼         ▼         ▼          ▼         ▼
Template  Networking  Storage  Hypervisor  Access
```

No message queues, event buses, or async communication patterns are currently used. Domain events are implicit (not explicitly published).

---

## File to Context Mapping

| File | Context |
|------|---------|
| `src/services/vm.ts` | VM Lifecycle |
| `src/services/template.ts` | Template |
| `src/services/network.ts` | Networking |
| `src/services/storage.ts` | Storage |
| `src/services/firecracker.ts` | Hypervisor |
| `src/services/proxy.ts` | Access (TCP Proxy) |
| `src/services/caddy.ts` | Access (HTTPS Gateway) |
| `src/services/nameGenerator.ts` | VM Lifecycle (supporting) |
| `src/services/wordlists.ts` | VM Lifecycle (supporting) |
| `src/types.ts` | Shared Kernel |
| `src/config.ts` | Shared Kernel |
| `src/index.ts` | Application Layer |
