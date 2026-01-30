# Ubiquitous Language Glossary

This glossary defines the shared vocabulary used throughout the Scalebox system. All team members and documentation should use these terms consistently.

---

## Core Domain Terms

### VM (Virtual Machine)
A running Firecracker microVM instance. The central concept in the system. Each VM has:
- A unique **ID** (e.g., `vm-a1b2c3d4e5f6`)
- A human-readable **Name** (e.g., `very-silly-penguin`)
- An associated **Template** it was created from
- Allocated resources (IP, port, TAP device, rootfs)

**Lifecycle states:** running, stopped (via deletion only - no pause/resume exposed to API)

### Template
A reusable golden image (ext4 rootfs) that VMs are created from. Templates enable fast VM creation via copy-on-write cloning.

- **Base Template:** The foundational template (e.g., `debian-base`) that cannot be deleted
- **Protected Template:** A template marked as undeletable in configuration
- **Derived Template:** A template created by snapshotting a running VM

### Snapshot
The act of capturing a running VM's state as a new Template. The VM is briefly paused, its rootfs is cloned, and the VM resumes.

### Rootfs (Root Filesystem)
The ext4 disk image containing the VM's operating system and files. Stored in `/var/lib/scalebox/vms/` for running VMs and `/var/lib/scalebox/templates/` for templates.

---

## Networking Terms

### TAP Device
A virtual network interface (`tap-*`) that connects a VM to the host's network bridge. Each VM gets one TAP device.

### Bridge (br0)
The network bridge (`172.16.0.1/16`) that connects all VM TAP devices, enabling VM-to-host and VM-to-internet communication.

### IP Address
Private IP assigned to each VM from the `172.16.0.0/16` range. Sequential allocation starting from `172.16.0.2`.

### MAC Address
Unique hardware address derived from the VM ID. Format: `AA:FC:XX:XX:XX:XX` where XX bytes come from the VM ID.

### SSH Port
The host port (range `22001-32000`) that proxies to the VM's internal SSH port (22). Enables external SSH access without exposing VMs directly.

---

## Access Terms

### TCP Proxy
A port-forwarding mechanism that maps a host port to a VM's internal port. Used for SSH access: `host:22001 → vm:22`.

### HTTPS Gateway
Caddy reverse proxy that routes `https://{vm-name}.{base-domain}` to the VM's port 8080. Provides automatic TLS via Let's Encrypt.

### Base Domain
The configured domain suffix for VM subdomains (e.g., `vms.example.com`). When set, VMs are accessible at `https://{name}.{base-domain}`.

### On-Demand TLS
Caddy's mechanism for obtaining TLS certificates only when first requested. Validated via the `/caddy/check` endpoint.

---

## Infrastructure Terms

### Firecracker
Amazon's lightweight microVM hypervisor. Provides fast boot times and strong isolation. Controlled via Unix socket API.

### Kernel
The Linux kernel image (`vmlinux`) booted by Firecracker. Shared by all VMs.

### Socket Path
The Unix socket (`/tmp/firecracker-{vm-id}.sock`) used to configure and control a Firecracker instance.

### Reflink Copy
A btrfs feature enabling instant, space-efficient file copies via copy-on-write. Used when creating VMs from templates.

### COW (Copy-on-Write)
Storage optimization where copies share data until modified. Enables fast VM creation without duplicating entire disk images.

---

## API Terms

### Bearer Token
The authentication token required for all protected API endpoints. Passed via `Authorization: Bearer {token}` header.

### Health Check
The unauthenticated `/health` endpoint returning `{"status": "ok"}`. Used for load balancer and monitoring probes.

### VM Response
The external representation of a VM returned by the API, containing only safe-to-expose fields (no PIDs, socket paths, etc.).

---

## Configuration Terms

### Data Directory
The root storage path (`/var/lib/scalebox`) containing templates, VMs, and kernel.

### Port Range
The configurable range (`PORT_MIN` to `PORT_MAX`) from which SSH proxy ports are allocated.

### Protected Templates
List of template names that cannot be deleted via API. Default: `["debian-base"]`.

---

## Process Terms

### VM Creation
The orchestrated process of: allocate resources → copy rootfs → inject SSH key → create TAP → start Firecracker → start proxy.

### VM Deletion
The cleanup process of: stop proxy → kill Firecracker → delete TAP → delete rootfs → release resources.

### VM Snapshotting
The process of: pause VM → copy rootfs to templates → resume VM → clear SSH keys from template.

---

## Name Generation Terms

### Three-Word Name
Human-readable VM identifier in format `{adverb}-{adjective}-{noun}` (e.g., `very-silly-penguin`). Auto-generated if not provided.

### Word Lists
Curated lists of ~30 adverbs, ~100 adjectives, and ~100 nouns providing ~300,000 unique name combinations.

### Fallback Suffix
A timestamp suffix appended to names when all combinations are exhausted (extremely unlikely).
