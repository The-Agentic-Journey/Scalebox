# VM Create Improvements Plan

## Overview

Improve the `sb vm create` and `sb vm up` commands:
1. Add `--disk` and `--mem` options
2. Increase default memory from 512 MiB to 2 GiB
3. Make `debian-base` the default template (no longer required to specify)

## Current State

- API supports `disk_size_gib` and `mem_size_mib` in POST /vms request body
- `sb` CLI does not expose these options
- Default memory: 512 MiB (too small for many workloads)
- Default disk: 2 GiB
- Template is required (`-t` flag mandatory)
- Output already shows both `sb connect` and `ssh` commands

## Changes

### Phase 1: Update Default Memory

**File: `src/config.ts`**
- Change `defaultMemSizeMib` from 512 to 2048 (2 GiB)

### Phase 2: Add CLI Options and Default Template

**File: `scripts/sb`**

In `cmd_vm_create()`:
1. Change template default from empty to "debian-base":
   ```bash
   local template="debian-base" key="" key_file=""
   ```
2. Remove the template required check:
   ```bash
   # Remove: [[ -n "$template" ]] || die "Template required: -t TEMPLATE"
   ```
3. Add disk and mem options:
   ```bash
   -d|--disk) disk="$2"; shift 2 ;;
   -m|--mem) mem="$2"; shift 2 ;;
   ```
4. Update API call to include optional disk/mem in JSON body

Apply same changes to `cmd_vm_up()`.

### Phase 3: Update Help Text

**File: `scripts/sb`**

Update `cmd_help()` to document new options and defaults:
```
  vm create [options]           Create a new VM
      -t, --template NAME       Template to use (default: debian-base)
      -k, --key FILE|KEY        SSH public key (default: ~/.ssh/id_*.pub)
      -d, --disk GIB            Disk size in GiB (default: 2)
      -m, --mem MIB             Memory size in MiB (default: 2048)
```

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| src/config.ts | Modify | Change default memory to 2048 MiB |
| scripts/sb | Modify | Add --disk/--mem options, default template to debian-base |

## Verification

```bash
# Test default template (no -t flag needed)
sb vm create
# Should create VM using debian-base template

# Test with custom options
sb vm create --disk 10 --mem 4096
sb vm get <name>  # Verify disk_size_gib=10, mem_size_mib=4096

# Test vm up with options
sb vm up --disk 5 --mem 1024

# Verify output shows both connect commands
# Expected output:
#   Created VM: <name>
#
#   Connect: sb connect <name>
#   SSH:     ssh -p <port> user@<host>
```

## Update Considerations

- **Config changes**: Default memory increases from 512 to 2048 MiB - existing VMs unaffected, only new VMs
- **Storage changes**: None
- **Dependency changes**: None
- **Migration needed**: No
