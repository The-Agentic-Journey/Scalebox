# GitHub CI + Continuous Releases Plan

## Overview

Set up GitHub Actions to run the full test suite (`./do check`) on every push to `main`, then automatically create a GitHub Release with build artifacts. Every push gets a release named `build-N` where N is the run number.

---

## Prerequisites (Manual Setup Required)

Before implementing this plan, you must complete these one-time setup steps:

### 1. GCP Service Account

Create a service account for CI with the following IAM roles:
- `roles/compute.instanceAdmin.v1` (create/delete VMs)
- `roles/compute.networkAdmin` (manage firewall rules)
- `roles/dns.admin` (manage DNS records)
- `roles/iam.serviceAccountUser` (use service account for VMs)

```bash
# Create service account
gcloud iam service-accounts create scalebox-ci \
  --display-name="Scalebox CI"

# Grant roles
PROJECT_ID=$(gcloud config get-value project)
SA_EMAIL="scalebox-ci@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/compute.instanceAdmin.v1"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/compute.networkAdmin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/dns.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/iam.serviceAccountUser"

# Create and download key
gcloud iam service-accounts keys create scalebox-ci-key.json \
  --iam-account=$SA_EMAIL
```

### 2. GCP Firewall Rule

Ensure the firewall rule exists (may already exist from development):

```bash
gcloud compute firewall-rules create scalebox-test-allow \
  --allow=tcp:8080,tcp:443,tcp:22000-32000 \
  --target-tags=scalebox-test \
  --description="Allow traffic to Scalebox test VMs"
```

### 3. GCP DNS Zone

Ensure the DNS zone exists and you control the domain:

```bash
gcloud dns managed-zones create scalebox-dns \
  --dns-name="testing.yourdomain.com." \
  --description="Scalebox CI testing domain"
```

Update your domain registrar to delegate `testing.yourdomain.com` to the Cloud DNS nameservers.

### 4. GitHub Repository Secrets

Add these secrets in GitHub repo settings (Settings → Secrets and variables → Actions):

| Secret | Value |
|--------|-------|
| `GCP_PROJECT_ID` | Your GCP project ID |
| `GCP_SA_KEY` | Contents of `scalebox-ci-key.json` (the entire JSON) |
| `DNS_ZONE` | `scalebox-dns` (or your zone name) |
| `DNS_SUFFIX` | `testing.yourdomain.com` (your DNS zone domain) |

### 5. Choose a License

Decide on an open source license (recommended: MIT).

---

## Phase 1: License and install.sh Fix

### Goal
Add LICENSE file and fix install.sh to work when run from an extracted tarball.

### Changes

**Create `LICENSE`** (MIT):
```
MIT License

Copyright (c) 2024 [Your Name]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**Modify `scripts/install.sh`**:

Change the configuration section to auto-detect script directory:
```bash
# === Configuration ===
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$SCRIPT_DIR}"
DATA_DIR="${DATA_DIR:-/var/lib/scalebox}"
# ... rest unchanged
```

### Verification
- `LICENSE` file exists in repo root
- Running `bash install.sh` from any directory works (looks for binaries relative to script location)

---

## Phase 2: GitHub Actions Workflow

### Goal
Create CI workflow that runs `./do check` and creates releases.

### Changes

**Create `.github/workflows/ci.yml`**:

```yaml
name: CI

on:
  push:
    branches: [main]

concurrency:
  group: ci-main
  cancel-in-progress: true

env:
  GCLOUD_PROJECT: ${{ secrets.GCP_PROJECT_ID }}
  DNS_ZONE: ${{ secrets.DNS_ZONE }}
  DNS_SUFFIX: ${{ secrets.DNS_SUFFIX }}

jobs:
  test-and-release:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Authenticate to GCP
        uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_SA_KEY }}

      - name: Setup gcloud CLI
        uses: google-github-actions/setup-gcloud@v2

      - name: Cache bun
        uses: actions/cache@v4
        with:
          path: .bun
          key: bun-${{ runner.os }}

      - name: Cache node_modules
        uses: actions/cache@v4
        with:
          path: node_modules
          key: node-${{ runner.os }}-${{ hashFiles('package.json', 'bun.lockb') }}

      - name: Run CI (lint, build, test)
        env:
          GCLOUD_PROJECT: ${{ secrets.GCP_PROJECT_ID }}
          DNS_ZONE: ${{ secrets.DNS_ZONE }}
          DNS_SUFFIX: ${{ secrets.DNS_SUFFIX }}
        run: ./do check

      - name: Create release tarball
        run: |
          cd builds
          tar -czvf ../scalebox-build-${{ github.run_number }}.tar.gz .

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          tag_name: build-${{ github.run_number }}
          name: Build ${{ github.run_number }}
          files: scalebox-build-${{ github.run_number }}.tar.gz
          body: |
            Automated build from commit ${{ github.sha }}

            ## Installation
            ```bash
            curl -L https://github.com/${{ github.repository }}/releases/download/build-${{ github.run_number }}/scalebox-build-${{ github.run_number }}.tar.gz | tar xz
            sudo ./install.sh
            ```
```

### Verification
- Push to main triggers workflow
- Workflow authenticates to GCP
- `./do check` runs successfully (creates VM, tests, cleans up)
- Release `build-N` is created with tarball

---

## Phase 3: Cleanup Workflow

### Goal
Scheduled job to clean up orphaned test VMs (in case of workflow cancellation).

### Changes

**Create `.github/workflows/cleanup.yml`**:

```yaml
name: Cleanup Orphaned VMs

on:
  schedule:
    - cron: '0 * * * *'  # Every hour
  workflow_dispatch:  # Manual trigger

jobs:
  cleanup:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Authenticate to GCP
        uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_SA_KEY }}

      - name: Setup gcloud CLI
        uses: google-github-actions/setup-gcloud@v2

      - name: Delete stale VMs
        run: |
          # Find VMs older than 1 hour with scalebox-test prefix
          CUTOFF=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S)

          gcloud compute instances list \
            --filter="name~'^scalebox-test-' AND creationTimestamp<'${CUTOFF}'" \
            --format="value(name,zone)" \
            --project=${{ secrets.GCP_PROJECT_ID }} | \
          while read NAME ZONE; do
            echo "Deleting stale VM: $NAME in $ZONE"
            gcloud compute instances delete "$NAME" \
              --zone="$ZONE" \
              --project=${{ secrets.GCP_PROJECT_ID }} \
              --quiet || true
          done

      - name: Delete stale DNS records
        run: |
          # Delete any scalebox-test-* DNS records
          gcloud dns record-sets list \
            --zone=${{ secrets.DNS_ZONE }} \
            --project=${{ secrets.GCP_PROJECT_ID }} \
            --filter="name~'^scalebox-test-'" \
            --format="value(name,type)" | \
          while read NAME TYPE; do
            echo "Deleting stale DNS record: $NAME"
            gcloud dns record-sets delete "$NAME" \
              --zone=${{ secrets.DNS_ZONE }} \
              --project=${{ secrets.GCP_PROJECT_ID }} \
              --type="$TYPE" \
              --quiet || true
          done
```

### Verification
- Workflow runs hourly
- Can be triggered manually
- Cleans up VMs older than 1 hour with `scalebox-test-` prefix

---

## Phase 4: Update README

### Goal
Update installation instructions to use GitHub releases.

### Changes

**Modify `README.md`** - Update the Quick Install section:

```markdown
### Quick Install

```bash
# Download latest release
curl -L https://github.com/OWNER/scalebox/releases/latest/download/scalebox-build-LATEST.tar.gz -o scalebox.tar.gz
tar xzf scalebox.tar.gz
sudo ./install.sh
```

Or download a specific version from the [Releases page](https://github.com/OWNER/scalebox/releases).
```

Note: The `latest` download URL requires GitHub's redirect. Alternative approach is to always use a specific build number, or create a `latest` tag that gets updated.

### Verification
- README has correct installation instructions
- Instructions work for a fresh server

---

## Phase 5: Parameterize ./do Script

### Goal
Make the `./do` script read DNS configuration from environment variables (for CI).

### Changes

**Modify `do`** - Update the variable declarations:

```bash
DNS_ZONE="${DNS_ZONE:-scalebox-dns}"
DNS_SUFFIX="${DNS_SUFFIX:-testing.holderbaum.cloud}"
```

These are already environment variable defaults, but ensure they're being used correctly throughout the script.

### Verification
- `DNS_ZONE=my-zone DNS_SUFFIX=my.domain ./do check` works
- CI can pass these as environment variables

---

## Files Summary

| File | Action | Purpose |
|------|--------|---------|
| `LICENSE` | Create | MIT license |
| `scripts/install.sh` | Modify | Auto-detect script directory |
| `.github/workflows/ci.yml` | Create | Main CI + release workflow |
| `.github/workflows/cleanup.yml` | Create | Hourly orphan VM cleanup |
| `README.md` | Modify | GitHub releases install instructions |
| `do` | Verify | Ensure DNS vars are parameterized |

---

## Verification

After all phases:

1. Push a commit to `main`
2. Verify GitHub Actions workflow runs
3. Verify GCE VM is created, tests pass, VM is deleted
4. Verify GitHub Release `build-N` is created with tarball
5. Download tarball on a fresh server and run `sudo ./install.sh`
6. Verify Scalebox is running and functional
