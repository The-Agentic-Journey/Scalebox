# User Experience Improvements Plan

## Overview

A collection of UX improvements to make Scalebox more user-friendly:
1. Use a non-root `user` account with passwordless sudo
2. Add `sb go` command to create and connect in one step
3. Improve `vm create` output with actionable information
4. Enhance `status` command with system overview

## Phase 1: Template User Account

**Goal:** Create a `user` account in the template with passwordless sudo.

**Changes:**

1. Update `scripts/template-build.sh` - in `configure_rootfs()`:
   ```bash
   # Create user with passwordless sudo
   useradd -m -s /bin/bash user
   echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/user
   chmod 440 /etc/sudoers.d/user
   ```

2. Update `scripts/install.sh` - same changes in inline `create_rootfs()` fallback

3. Bump `TEMPLATE_VERSION` to 4 in:
   - `scripts/template-build.sh`
   - `scripts/install.sh`
   - `scripts/scalebox-rebuild-template`
   - `scripts/scalebox-update` (REQUIRED_TEMPLATE_VERSION)

**Verification:**
- Rebuild template
- Create VM, SSH as `user@host` - should work
- Run `sudo whoami` - should return "root" without password prompt

---

## Phase 2: SSH Key for User Account

**Goal:** Put SSH keys in the `user` account instead of root.

**Changes:**

1. Update `src/services/vm.ts` - in `createVm()`:
   - Change SSH key injection path from `/root/.ssh/authorized_keys` to `/home/user/.ssh/authorized_keys`
   - Ensure proper ownership: `chown -R user:user /home/user/.ssh`

2. Update `scripts/sb` - in `cmd_connect()`:
   - Change SSH user from `root` to `user`

**Verification:**
- Create VM with SSH key
- `sb connect <vm>` connects as `user`
- `sudo` works without password

---

## Phase 3: System Info Endpoint

**Goal:** Add `/info` endpoint with system stats for status command.

**Changes:**

1. Update `src/index.ts` - add `/info` endpoint:
   ```typescript
   app.get("/info", async (c) => {
     const templates = await listTemplates();
     const vms = listVms();

     // Get btrfs filesystem stats
     const storageStats = await getStorageStats();

     // Get system stats
     const memInfo = await getMemoryStats();
     const cpuUsage = await getCpuUsage();

     return c.json({
       host_ip: config.hostIp,  // Need to add to config
       api_domain: config.apiDomain,
       vm_domain: config.vmDomain,
       templates_count: templates.length,
       vms_count: vms.length,
       storage: {
         total_gb: storageStats.totalGb,
         used_gb: storageStats.usedGb,
         free_gb: storageStats.freeGb,
       },
       memory: {
         total_gb: memInfo.totalGb,
         free_gb: memInfo.freeGb,
       },
       cpu_percent: cpuUsage,
     });
   });
   ```

2. Create helper functions in `src/services/system.ts`:
   - `getStorageStats()` - parse `df` or `btrfs filesystem df`
   - `getMemoryStats()` - parse `/proc/meminfo`
   - `getCpuUsage()` - parse `/proc/stat` or use quick sample

3. Update `src/config.ts`:
   - Add `hostIp` - detect from network interface or require config

**Verification:**
- `curl /info` returns system stats
- Stats are accurate

---

## Phase 4: Enhanced Status Command

**Goal:** Show system overview in `sb status`.

**Changes:**

1. Update `scripts/sb` - modify `cmd_status()`:
   ```bash
   cmd_status() {
     need_config
     local response
     if response=$(api GET /info); then
       echo "Scalebox Status"
       echo "==============="
       echo ""
       echo "Host: $(echo "$response" | jq -r '.host_ip')"
       echo "API:  $(echo "$response" | jq -r '.api_domain // "N/A"')"
       echo ""
       echo "Resources:"
       echo "  Templates: $(echo "$response" | jq -r '.templates_count')"
       echo "  VMs:       $(echo "$response" | jq -r '.vms_count')"
       echo ""
       echo "Storage: $(echo "$response" | jq -r '.storage.free_gb')GB free / $(echo "$response" | jq -r '.storage.total_gb')GB"
       echo "Memory:  $(echo "$response" | jq -r '.memory.free_gb')GB free / $(echo "$response" | jq -r '.memory.total_gb')GB"
       echo "CPU:     $(echo "$response" | jq -r '.cpu_percent')% used"
     else
       echo "$response"
       return 1
     fi
   }
   ```

**Verification:**
- `sb status` shows formatted system overview
- All values are accurate

---

## Phase 5: Improved VM Create Output

**Goal:** Pretty-print VM creation with actionable commands.

**Changes:**

1. Update `scripts/sb` - modify `cmd_vm_create()`:
   - After successful creation, format output nicely:
   ```
   Created VM: wildly-fresh-reef

   Connect: sb connect wildly-fresh-reef
   SSH:     ssh -p 22001 user@sbapi.example.com
   URL:     https://wildly-fresh-reef.vms.example.com (if VM_DOMAIN configured)
   ```

2. The host and port info comes from the API response (ssh_port) and config (host)

**Verification:**
- `sb vm create -t debian-base` shows formatted output
- Commands shown are copy-pasteable and work

---

## Phase 6: Go Command

**Goal:** Add `sb go` to create and connect in one step.

**Changes:**

1. Update `scripts/sb` - add `cmd_go()`:
   ```bash
   cmd_go() {
     # Parse same options as vm create
     local template="debian-base"
     local key=""

     while [[ $# -gt 0 ]]; do
       case "$1" in
         -t|--template) template="$2"; shift 2 ;;
         -k|--key) # same key handling as vm create
           ...
           shift 2 ;;
         *) die "Unknown option: $1" ;;
       esac
     done

     # Create VM (reuse logic from cmd_vm_create but capture name)
     local response
     response=$(api POST /vms -d "$(jq -n --arg t "$template" --arg k "$key" '{template:$t,ssh_public_key:$key}')")

     local name
     name=$(echo "$response" | jq -r '.name')

     echo "Created VM: $name"
     echo ""

     # Connect
     cmd_connect "$name"
   }
   ```

2. Add to help text and command dispatch

**Verification:**
- `sb go` creates VM with defaults and connects
- `sb go -t debian-base` works with explicit template

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `scripts/template-build.sh` | Modify | Add user account, bump version |
| `scripts/install.sh` | Modify | Add user account (fallback), bump version |
| `scripts/scalebox-rebuild-template` | Modify | Bump version |
| `scripts/scalebox-update` | Modify | Bump required version |
| `src/services/vm.ts` | Modify | SSH key to user account |
| `src/services/system.ts` | Create | System stats helpers |
| `src/index.ts` | Modify | Add /info endpoint |
| `src/config.ts` | Modify | Add hostIp |
| `scripts/sb` | Modify | Update connect user, status, create output, add go |

## Update Considerations

- **Config changes**: Optional HOST_IP in config (auto-detected if not set)
- **Storage changes**: None
- **Dependency changes**: None
- **Migration needed**: Yes - `scalebox-rebuild-template` for user account
- **Template version**: Bumped to 4
