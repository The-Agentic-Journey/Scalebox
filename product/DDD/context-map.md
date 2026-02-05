# Bounded Context Map

This document provides an overview of all bounded contexts in the Scalebox system and their relationships.

---

## External Clients

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                             EXTERNAL CLIENTS                                     │
│                                                                                  │
│   ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐            │
│   │    sb CLI       │    │   curl / HTTP   │    │   AI Agents     │            │
│   │  (user machines)│    │    clients      │    │                 │            │
│   └────────┬────────┘    └────────┬────────┘    └────────┬────────┘            │
│            │                      │                      │                      │
│            └──────────────────────┼──────────────────────┘                      │
│                                   │                                              │
│                            HTTPS (REST API)                                      │
│                                   │                                              │
└───────────────────────────────────┼─────────────────────────────────────────────┘
                                    │
                                    ▼
```

The sb CLI and other HTTP clients are **external** to the Scalebox server. They interact exclusively through the REST API over HTTPS. The CLI has no special access—it uses the same endpoints available to any authenticated client.

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
| [**VM Lifecycle**](contexts/vm-lifecycle.md) | Orchestrates VM creation, deletion, and snapshotting | Highest - this is the product's core value proposition |

### Supporting Domains

| Context | Purpose | Strategic Value |
|---------|---------|-----------------|
| [**Template**](contexts/template.md) | Manages reusable VM images | High - enables fast, repeatable VM creation |
| [**Access**](contexts/access.md) | Provides external connectivity to VMs | High - makes VMs usable |

### Infrastructure Domains

| Context | Purpose | Strategic Value |
|---------|---------|-----------------|
| [**Networking**](contexts/networking.md) | Allocates IPs, ports, and network interfaces | Medium - commodity but essential |
| [**Storage**](contexts/storage.md) | Manages rootfs files with COW optimization | Medium - commodity but essential |
| [**Hypervisor**](contexts/hypervisor.md) | Controls Firecracker processes | Medium - commodity but essential |

---

## Context Relationships

### [VM Lifecycle](contexts/vm-lifecycle.md) → [Template](contexts/template.md)
**Relationship:** Customer-Supplier
**Direction:** VM Lifecycle depends on Template
**Integration:**
- VM creation reads from Template context to copy rootfs
- VM snapshotting writes to Template context to create new templates

### [VM Lifecycle](contexts/vm-lifecycle.md) → [Networking](contexts/networking.md)
**Relationship:** Customer-Supplier
**Direction:** VM Lifecycle depends on Networking
**Integration:**
- VM creation requests IP, port, and TAP device allocation
- VM deletion releases allocated network resources

### [VM Lifecycle](contexts/vm-lifecycle.md) → [Storage](contexts/storage.md)
**Relationship:** Customer-Supplier
**Direction:** VM Lifecycle depends on Storage
**Integration:**
- VM creation copies rootfs and injects SSH keys
- VM deletion removes rootfs
- Snapshotting copies rootfs to template location

### [VM Lifecycle](contexts/vm-lifecycle.md) → [Hypervisor](contexts/hypervisor.md)
**Relationship:** Customer-Supplier
**Direction:** VM Lifecycle depends on Hypervisor
**Integration:**
- VM creation starts Firecracker process
- VM deletion stops Firecracker process
- Snapshotting pauses/resumes VM

### [VM Lifecycle](contexts/vm-lifecycle.md) → [Access](contexts/access.md)
**Relationship:** Customer-Supplier
**Direction:** VM Lifecycle depends on Access
**Integration:**
- VM creation starts TCP proxy
- VM deletion stops TCP proxy
- VM creation/deletion triggers Caddy config update

### [Template](contexts/template.md) → [Storage](contexts/storage.md)
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

Context links: [VM Lifecycle](contexts/vm-lifecycle.md) → [Template](contexts/template.md), [Networking](contexts/networking.md), [Storage](contexts/storage.md), [Hypervisor](contexts/hypervisor.md), [Access](contexts/access.md)

No message queues, event buses, or async communication patterns are currently used. Domain events are implicit (not explicitly published).

---

## File to Context Mapping

| File | Context |
|------|---------|
| `src/services/vm.ts` | [VM Lifecycle](contexts/vm-lifecycle.md) |
| `src/services/template.ts` | [Template](contexts/template.md) |
| `src/services/network.ts` | [Networking](contexts/networking.md) |
| `src/services/storage.ts` | [Storage](contexts/storage.md) |
| `src/services/firecracker.ts` | [Hypervisor](contexts/hypervisor.md) |
| `src/services/proxy.ts` | [Access](contexts/access.md) (TCP Proxy) |
| `src/services/caddy.ts` | [Access](contexts/access.md) (HTTPS Gateway) |
| `src/services/nameGenerator.ts` | [VM Lifecycle](contexts/vm-lifecycle.md) (supporting) |
| `src/services/wordlists.ts` | [VM Lifecycle](contexts/vm-lifecycle.md) (supporting) |
| `src/types.ts` | Shared Kernel |
| `src/config.ts` | Shared Kernel |
| `src/index.ts` | Application Layer |

---

## Deployment Topology

Scalebox has a clear separation between server-side and client-side components:

### Server-Side (installed on Scalebox host)

| Component | Location | Purpose |
|-----------|----------|---------|
| `scaleboxd` | `/usr/local/bin/scaleboxd` | API server daemon |
| `scalebox-update` | `/usr/local/bin/scalebox-update` | Server update tool |
| Firecracker | `/usr/local/bin/firecracker` | VM hypervisor |
| Caddy | System package | HTTPS reverse proxy |

### Client-Side (installed on user machines)

| Component | Location | Purpose |
|-----------|----------|---------|
| `sb` | User's PATH | CLI for API interaction |

### Key Principle

The `sb` CLI is **not** installed on the server. It is distributed separately and installed on user machines (developer laptops, CI systems, etc.). This separation:

1. Keeps the server minimal and secure
2. Allows CLI updates independent of server updates
3. Makes the CLI portable across macOS, Linux, and Windows
4. Ensures the CLI has no privileged access—it uses the same REST API as any other client
