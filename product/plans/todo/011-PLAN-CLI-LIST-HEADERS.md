# CLI List Command Headers Plan

## Overview

The `sb vm list` and `sb template list` commands output data without column headers, making it difficult to understand what each column represents. Additionally, template sizes are shown in raw bytes rather than human-readable format.

## Problem Statement

Current output:
```
$ sb vm list
wildly-fresh-reef  vm-336b61c9fd8c  debian-base  172.16.0.2  22001

$ sb template list
debian-base  2147483648
```

Users can't tell which column is which without consulting documentation.

## Solution

Add column headers to list commands and format sizes for readability.

Desired output:
```
$ sb vm list
NAME                ID                TEMPLATE     IP          PORT
wildly-fresh-reef   vm-336b61c9fd8c   debian-base  172.16.0.2  22001

$ sb template list
NAME         SIZE
debian-base  2.0 GB
```

## Phase 1: Add Headers and Format Sizes

**Goal:** Improve list command readability with headers and human-readable sizes.

**Changes to `scripts/sb`:**

1. Modify `output_table()` to accept an optional header parameter:
   ```bash
   output_table() {
     local jq_filter="$1"
     local header="${2:-}"
     if [[ "$JSON_OUTPUT" == "true" ]]; then
       jq .
     else
       if [[ -n "$header" ]]; then
         { echo "$header"; jq -r "$jq_filter"; } | column -t 2>/dev/null || cat
       else
         jq -r "$jq_filter" | column -t 2>/dev/null || cat
       fi
     fi
   }
   ```

2. Update `cmd_vm_list()` to pass header:
   ```bash
   echo "$response" | output_table '.vms[] | [.name, .id, .template, .ip, .ssh_port] | @tsv' \
     "NAME	ID	TEMPLATE	IP	PORT"
   ```

3. Update `cmd_template_list()` to pass header and format size:
   ```bash
   # Format size as human-readable (e.g., "2.0 GB")
   echo "$response" | output_table '.templates[] | [.name, (.size_bytes / 1073741824 | floor | tostring + " GB")] | @tsv' \
     "NAME	SIZE"
   ```

**Note:** Headers should use tab characters (`\t`) to align with the TSV output from jq.

**Verification:**
- `sb vm list` shows header row followed by data
- `sb template list` shows header row with human-readable sizes
- `sb vm list --json` still outputs raw JSON (no headers)
- `sb template list --json` still outputs raw JSON with size_bytes

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `scripts/sb` | Modify | Add headers to output_table, update list commands |

## Update Considerations

- **Config changes**: None
- **Storage changes**: None
- **Dependency changes**: None
- **Migration needed**: No
- **Backwards compatibility**: JSON output unchanged, only text output affected
