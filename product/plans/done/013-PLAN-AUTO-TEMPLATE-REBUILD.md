# Template Rebuild in Check-Update Test Plan

## Overview

The `check-update` CI test is failing because after upgrading from an old release to the current build, the old template lacks the `user` account, causing SSH tests to fail.

## Problem Analysis

The `check-update` test flow:
1. Install OLD release (template version 3, no `user` account)
2. Run `scalebox-update` to upgrade to current build
3. `scalebox-update` warns about outdated template but doesn't rebuild (by design)
4. Tests run expecting `user` account → SSH fails

The `scalebox-update` script should NOT auto-rebuild templates - this could be slow and disruptive in production. Users should explicitly run `scalebox-rebuild-template` when ready.

However, the **test runner** should rebuild the template to verify the upgrade path works correctly.

## Solution

Add `scalebox-rebuild-template` call in the `./do check-update` test runner after running `scalebox-update`.

## Phase 1: Rebuild Template in Test Runner

**Goal:** After `scalebox-update` runs in `check-update`, run `scalebox-rebuild-template` to ensure tests use the updated template.

**Changes:**

1. Modify `do` script - in `do_check_update()`, after running `scalebox-update`, run the template rebuild:
   ```bash
   echo "==> Running scalebox-update (last release → current build)..."
   gcloud compute ssh "$VM_NAME" \
     --zone="$GCLOUD_ZONE" \
     --project="$GCLOUD_PROJECT" \
     --command="sudo SCALEBOX_RELEASE_URL='$update_url' scalebox-update"

   echo "==> Rebuilding template for updated version..."
   gcloud compute ssh "$VM_NAME" \
     --zone="$GCLOUD_ZONE" \
     --project="$GCLOUD_PROJECT" \
     --command="sudo scalebox-rebuild-template"
   ```

**Verification:**
- Run `./do check-update` - should pass
- Verify template is rebuilt with version 4
- Verify `user` account exists in new template

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `do` | Modify | Run scalebox-rebuild-template after scalebox-update in check-update test |

## Update Considerations

- **Config changes**: None
- **Storage changes**: None
- **Dependency changes**: None
- **Migration needed**: No
- **Production behavior**: Unchanged - users still manually run scalebox-rebuild-template
