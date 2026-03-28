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

### IP Address (Internal)
Private IP assigned to each VM from the `172.16.0.0/16` range. Sequential allocation starting from `172.16.0.2`. Used internally for bridge networking, proxy forwarding, and Caddy routing. Not exposed to API consumers (see **Host IP**).

### Host IP
The external IP address of the Scalebox host server. Required config value (`HOST_IP` in `/etc/scaleboxd/config`), set during installation. Returned in the `ip` field of VM API responses so clients know where to connect. The server refuses to start if `HOST_IP` is not set.

### MAC Address
Unique hardware address derived from the VM ID. Format: `AA:FC:XX:XX:XX:XX` where XX bytes come from the VM ID.

### SSH Port
The host port (range `22001-32000`) that proxies to the VM's internal SSH port (22). Enables external SSH access without exposing VMs directly.

---

## Access Terms

### TCP Proxy
A port-forwarding mechanism that maps a host port to a VM's internal port. Used for SSH access: `host:22001 → vm:22`.

### UDP Proxy
Kernel-level NAT (iptables DNAT + MASQUERADE) that forwards UDP datagrams to VMs for mosh connectivity. Uses the same port number as SSH (e.g., `host:22001/udp → vm:22001/udp`).

### Mosh Port
The UDP port (same number as SSH port) used for mosh sessions. Forwarded via iptables NAT to the VM's mosh-server. Mosh requires the same port number for client and server.

### HTTPS Gateway
Caddy reverse proxy that routes `https://{vm-name}.vm.{base-domain}` to the VM's port 8080. Provides automatic TLS via a wildcard certificate.

### Base Domain (BASE_DOMAIN)
The single root domain for the Scalebox installation (e.g., `example.com`). When set, the API is accessible at `https://api.{base-domain}` and VMs are accessible at `https://{vm-name}.vm.{base-domain}` (routes to port 8080 inside the VM).

### DNS Server
A built-in DNS server that handles DNS resolution for the Scalebox domain. Responds to queries for `api.{base-domain}`, `*.vm.{base-domain}`, and `_acme-challenge` TXT records used during wildcard certificate issuance via DNS-01 challenge.

### Wildcard Certificate
A single TLS certificate covering `*.vm.{base-domain}`, issued by Let's Encrypt via DNS-01 challenge. Covers all VM subdomains, eliminating the need for per-VM certificate issuance.

### ACME Proxy
The acmeproxy module in Caddy that delegates DNS-01 challenge responses to the built-in DNS server. When Let's Encrypt needs to verify domain ownership, the ACME proxy instructs the DNS server to serve the required TXT record at `_acme-challenge.vm.{base-domain}`.

### DNS-01 Challenge
The ACME challenge type used for wildcard certificate issuance. Unlike HTTP-01 (which requires per-domain HTTP requests), DNS-01 proves domain ownership by serving a TXT record at `_acme-challenge.{domain}`. This enables a single wildcard certificate to cover all VM subdomains.

---

## Infrastructure Terms

### Firecracker
Amazon's lightweight microVM hypervisor. Provides fast boot times and strong isolation. Controlled via Unix socket API.

### Kernel
The Linux kernel image (`vmlinux`) booted by Firecracker. Shared by all VMs. Minimum kernel 5.6+ is required for Bun runtime compatibility. The installed version is tracked by a kernel version file for automated upgrades.

### Kernel Version File
A file at `/var/lib/scalebox/kernel/version` containing the kernel version string (e.g., `5.10.245`). Created during installation and checked by `scalebox-update` to detect when a kernel upgrade is needed. Absent on pre-024 installations, which triggers an automatic upgrade.

### Socket Path
The Unix socket (`/tmp/firecracker-{vm-id}.sock`) used to configure and control a Firecracker instance.

### Reflink Copy
A btrfs feature enabling instant, space-efficient file copies via copy-on-write. Used when creating VMs from templates.

### COW (Copy-on-Write)
Storage optimization where copies share data until modified. Enables fast VM creation without duplicating entire disk images.

### Base Image (BASE_IMAGE)
The Docker image used as the source for building the base template. Configured via `BASE_IMAGE` in `/etc/scaleboxd/config`. Default: `ghcr.io/the-agentic-journey/agenticbaseimage:latest`. The image is pulled and extracted using `crane` during template creation.

### crane
A CLI tool from Google's go-containerregistry project used to pull and export Docker images without requiring a Docker daemon. Installed at `/usr/local/bin/crane`. Used by `template-build.sh` to convert a Docker image into a rootfs directory.

### ACME Staging
Let's Encrypt's staging environment for testing certificate issuance. Unlike the production ACME server, the staging environment has no rate limits, making it ideal for testing and development. Certificates issued by the staging environment are **not browser-trusted** (they are signed by a fake root CA), but they verify that the ACME flow works correctly.

**Use cases:**
- Testing Caddy configuration before going to production
- CI/CD environments where real certificates aren't needed
- Development setups to avoid hitting Let's Encrypt rate limits

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
The orchestrated process of: allocate resources → copy rootfs → inject SSH key → set hostname → create TAP → start Firecracker → start proxy.

### VM Deletion
The cleanup process of: stop proxy → kill Firecracker → delete TAP → delete rootfs → release resources.

### VM Snapshotting
The process of: pause VM → copy rootfs to templates → resume VM → clear SSH keys from template. If the target template already exists, the API returns 409 unless `overwrite: true` is specified, in which case the existing template is replaced. Protected templates cannot be overwritten.

---

## Name Generation Terms

### Three-Word Name
Human-readable VM identifier in format `{adverb}-{adjective}-{noun}` (e.g., `very-silly-penguin`). Auto-generated if not provided.

### Word Lists
Curated lists of ~30 adverbs, ~100 adjectives, and ~100 nouns providing ~300,000 unique name combinations.

### Fallback Suffix
A timestamp suffix appended to names when all combinations are exhausted (extremely unlikely).

---

## Operations Terms

### Update
The process of replacing the scaleboxd binary and related files on a running server with a newer version. Performed by running `scalebox-update` as root on the server.

### Rollback
Automatic restoration of the previous scaleboxd binary if a health check fails after an update. The previous binary is saved as `scaleboxd.prev` during the update process.

### scalebox-update
A server-side administration tool (installed at `/usr/local/bin/scalebox-update`) that handles updating Scalebox. Downloads the latest release, backs up the current binary, installs new files, restarts the service, and rolls back automatically if health checks fail.

**Note:** This is different from `sb CLI`, which is a user-facing tool for interacting with the Scalebox API.

### sb CLI
The user-facing command-line tool for interacting with the Scalebox API. Named `sb` for brevity.

**Installation:** Installed on user machines (macOS, Linux), not on the Scalebox server. Communicates with the server over HTTPS.

**Configuration:** Reads `SCALEBOX_URL` and `SCALEBOX_TOKEN` from environment variables or `~/.config/scalebox/config`.

**Note:** This is different from `scalebox-update`, which is a server-side administration tool.

### Managed SSH Key
An ed25519 SSH key pair automatically generated and stored by the `sb` CLI at `~/.config/scalebox/id_ed25519`. Used by default for VM creation and connection, removing the need for users to manage SSH keys manually.

**Limitation:** Per-machine. VMs created from one machine are not accessible from another without manually syncing keys or using explicit `-k` flag.

### Connect Command
The `sb connect` command that establishes a mosh (or SSH fallback) session to a VM. Uses the managed SSH key automatically and retrieves connection details from the API.

### Template Version
A version number stored in `debian-base.version` that tracks template contents. Incremented when template packages change (e.g., when mosh was added). Used by `scalebox-update` to detect when templates need rebuilding.

### Template Rebuild
The process of recreating the base template from the configured Docker image using `scalebox-rebuild-template`. The Docker image is pulled via `crane`, extracted to a rootfs directory, and packaged as an ext4 image. Running VMs are not affected due to btrfs copy-on-write.

### Orphaned Resource
A system resource (Firecracker process, TAP device, rootfs file) that exists on the host but is not tracked in scaleboxd's in-memory VM state. Orphans occur when state.json is missing, corrupted, or predates the state persistence feature (plan 018). Orphaned resources are automatically discovered and cleaned up on startup by the reconciliation process.

### Reconciliation
The startup process that scans the host for system resources not tracked in state.json and cleans them up. Runs after VM recovery. Discovers orphaned Firecracker processes (via `pgrep`), TAP devices (via `/sys/class/net/`), and rootfs files (via directory listing). Each discovered orphan is logged with `[reconcile]` prefix and cleaned up automatically.
