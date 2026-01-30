# Claude Guide for Scalebox

This document helps Claude instances understand and work effectively with the Scalebox codebase.

## Project Overview

Scalebox is a REST API for managing Firecracker microVMs. Users create VMs from templates, access them via SSH or HTTPS, and can snapshot VMs back to templates.

**Tech stack**: Bun, TypeScript, Hono, Firecracker, btrfs, Caddy

## Documentation Structure

```
product/
├── DDD/                          # Domain-Driven Design documentation
│   ├── glossary.md               # Ubiquitous language (50+ terms)
│   ├── context-map.md            # Bounded contexts overview
│   └── contexts/                 # Detailed context documentation
│       ├── vm-lifecycle.md       # Core domain - VM aggregate
│       ├── template.md           # Template management
│       ├── networking.md         # IP/port/TAP allocation
│       ├── storage.md            # Rootfs and COW operations
│       ├── hypervisor.md         # Firecracker process control
│       └── access.md             # TCP proxy + HTTPS gateway
│
├── ADR/                          # Architecture Decision Records
│   ├── 001-firecracker-hypervisor.md
│   ├── 002-bun-runtime.md
│   ├── ...                       # 12 ADRs documenting key decisions
│   └── 012-systemd-service-management.md
│
└── plans/
    ├── todo/                     # Plans awaiting implementation
    └── done/                     # Completed plans (historical reference)
        ├── 001-PLAN.md           # Original Firecracker VM API
        ├── 002-PLAN-SCALEBOX.md  # Scalebox refactoring
        ├── 003-PLAN-HTTPS.md     # HTTPS via Caddy
        └── 004-PLAN-VM-NAMES.md  # Three-word VM names
```

## Before Starting Work

### 1. Understand the Domain

Read in this order:
1. `product/DDD/glossary.md` - Learn the vocabulary
2. `product/DDD/context-map.md` - Understand bounded contexts
3. Relevant context file in `product/DDD/contexts/` for the area you'll modify

### 2. Check Existing Decisions

Review `product/ADR/` for architecture decisions. Don't contradict established patterns without good reason and a new ADR.

### 3. Check for Pending Plans

Look in `product/plans/todo/` for any plans awaiting implementation.

## Source Code Structure

```
src/
├── index.ts              # HTTP routes (Hono app)
├── config.ts             # Environment configuration
├── types.ts              # TypeScript interfaces
└── services/
    ├── vm.ts             # VM lifecycle (core domain)
    ├── template.ts       # Template management
    ├── firecracker.ts    # Hypervisor control
    ├── storage.ts        # Rootfs operations
    ├── network.ts        # IP/port/TAP allocation
    ├── proxy.ts          # TCP proxy for SSH
    ├── caddy.ts          # HTTPS gateway config
    ├── nameGenerator.ts  # Three-word name generation
    └── wordlists.ts      # Word lists for names

scripts/
├── install.sh            # Self-contained installer
├── scalebox              # CLI bash script
└── scaleboxd.service     # Systemd unit file

test/
└── integration.test.ts   # Integration tests
```

## Planning a New Feature

### 1. Create a Plan Document

Create `product/plans/todo/XXX-PLAN-FEATURE-NAME.md` with:

```markdown
# Feature Name Plan

## Overview
Brief description of what this feature does.

## Phases
Break into implementable phases, each with:
- Goal
- Specific changes (files to create/modify)
- Verification steps

## Files Summary
| File | Action | Purpose |
|------|--------|---------|
| ... | Create/Modify | ... |

## Verification
How to test the feature works.
```

### 2. Follow Existing Patterns

- Look at `product/plans/done/` for plan format examples
- Match the phase-based structure
- Include verification steps for each phase

### 3. Consider DDD Implications

- Which bounded context does this belong to?
- Does it need new aggregates, entities, or value objects?
- Update DDD docs if adding new domain concepts

## Implementing Features

### Development Commands

```bash
./do lint      # Run linter
./do test      # Run integration tests
./do build     # Compile to single binary
./do deploy    # Deploy to test VM
./do check     # Full CI: lint + deploy + test
```

### Implementation Guidelines

1. **Read before modifying** - Always read files before editing
2. **Follow existing patterns** - Match the style of surrounding code
3. **Keep changes minimal** - Only change what's necessary
4. **Test your changes** - Run `./do check` before committing

### Commit Guidelines

- Commit messages should be clear and descriptive
- Reference the plan if implementing one
- End with `Co-Authored-By: Claude <model>` line

### After Implementation

Move completed plan from `product/plans/todo/` to `product/plans/done/` with appropriate number prefix.

## Key Architectural Patterns

### VM Lifecycle is the Core Domain

All VM operations go through `src/services/vm.ts`. It orchestrates:
- Template (for rootfs source)
- Storage (for rootfs copying)
- Networking (for IP/port/TAP)
- Hypervisor (for Firecracker process)
- Access (for proxy/Caddy)

### In-Memory State

VMs are stored in a Map, not persisted. On restart, all VMs are lost. Templates are the persistent state.

### Copy-on-Write Storage

VM creation uses `cp --reflink=auto` for instant copies. Requires btrfs filesystem.

### TCP Proxy for SSH

Each VM gets a unique host port (22001-32000) that forwards to VM port 22.

### On-Demand HTTPS

Caddy validates subdomains via `/caddy/check` before issuing certificates.

## Common Tasks

### Adding a New API Endpoint

1. Add route in `src/index.ts`
2. Add types in `src/types.ts` if needed
3. Implement logic in appropriate service file
4. Add test in `test/integration.test.ts`

### Adding a New Service

1. Create `src/services/newservice.ts`
2. Export functions (not classes)
3. Import and use from `vm.ts` or `index.ts`
4. Document in DDD if it's a new bounded context

### Modifying VM Creation

Changes to VM creation flow go in `src/services/vm.ts:createVm()`. This function orchestrates all the steps.

### Adding Configuration

1. Add to `src/config.ts`
2. Add to `scripts/install.sh` (config file generation)
3. Document in README.md

## Testing

Integration tests run against a real Firecracker host:

```bash
# Set environment
export VM_HOST=your-test-host
export API_TOKEN=your-token

# Run tests
./do test
```

Tests create real VMs, so they need a host with KVM support.

## Questions to Ask Before Major Changes

1. Does this align with existing ADRs?
2. Which bounded context does this belong to?
3. Should this be a new plan document first?
4. Have I read the existing code I'm modifying?
5. Does this maintain the simplicity principle?
