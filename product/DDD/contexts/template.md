# Template Context

**Classification:** Supporting Domain
**Source:** `src/services/template.ts`

---

## Purpose

The Template context manages reusable VM images (golden images). Templates enable rapid VM creation through copy-on-write cloning and provide a way to capture and share VM configurations.

---

## Aggregate: Template

### Identity

```typescript
name: string  // Alphanumeric with dashes/underscores, e.g., "debian-base"
```

Template names map directly to filesystem paths: `/var/lib/scalebox/templates/{name}.ext4`

### State

```typescript
interface Template {
  name: string;        // Unique identifier
  size_bytes: number;  // File size on disk
  created_at: string;  // ISO 8601 timestamp (file mtime)
}
```

**Note:** Template state is derived from filesystem metadata, not stored separately.

### Invariants

1. **Valid Name Format:** Must match `/^[a-zA-Z0-9_-]+$/` (prevents path traversal)
2. **Unique Name:** No two templates share the same name
3. **Protected Templates Cannot Be Deleted:** Templates in `config.protectedTemplates` are immutable
4. **File Must Exist:** Template only exists if corresponding `.ext4` file exists

### Lifecycle

```
                    ┌─────────┐
                    │ (none)  │
                    └────┬────┘
                         │ snapshot (from VM Lifecycle)
                         ▼
                    ┌─────────┐
                    │ Active  │
                    └────┬────┘
                         │ delete (if not protected)
                         ▼
                    ┌─────────┐
                    │ Deleted │
                    └─────────┘
```

**Creation Note:** Templates are NOT created directly in this context. They are created by:
1. The VM Lifecycle context (via snapshotting)
2. External provisioning (e.g., `debian-base` from install script)

---

## Domain Services

### listTemplates(): Promise<Template[]>

Lists all available templates by scanning the templates directory:

```
1. Read /var/lib/scalebox/templates/ directory
2. Filter for .ext4 files
3. For each file:
   - Extract name (remove .ext4 extension)
   - Read file stats (size, mtime)
4. Return template list
```

**Edge Case:** Returns empty array if directory doesn't exist.

### deleteTemplate(name: string): Promise<void>

Deletes a template with safety checks:

```
1. Validate name format (path traversal prevention)
2. Check if template is protected → 403 Forbidden
3. Check if template exists → 404 Not Found
4. Delete file
```

**Security:** Name validation prevents attacks like `deleteTemplate("../../../etc/passwd")`.

---

## Business Rules

### Protected Templates

```typescript
config.protectedTemplates = ["debian-base"]
```

- Protected templates cannot be deleted via API
- Provides safety net against accidental deletion of base images
- Configurable via environment/config

### Template Naming

| Rule | Regex | Example |
|------|-------|---------|
| Alphanumeric | `[a-zA-Z0-9]` | `debian12` |
| Dashes | `-` | `my-template` |
| Underscores | `_` | `my_template` |
| Combined | `^[a-zA-Z0-9_-]+$` | `debian-12_base` |

Invalid: `.hidden`, `path/traversal`, `name.ext4`

---

## Storage Integration

Templates are stored as ext4 filesystem images:

```
/var/lib/scalebox/
└── templates/
    ├── debian-base.ext4      # Protected base template
    ├── my-snapshot.ext4      # User-created template
    └── custom-image.ext4     # Another template
```

**File Format:** ext4 filesystem, typically 1-10 GB
**Optimization:** btrfs reflink copies for COW efficiency

---

## Interaction with VM Lifecycle

### Template as Source

When a VM is created:
1. VM Lifecycle requests template by name
2. Storage context copies template's rootfs
3. Template is not modified

### Template Creation via Snapshot

When a VM is snapshotted:
1. VM Lifecycle pauses VM
2. Storage context copies VM's rootfs to templates directory
3. Storage context clears SSH keys from new template
4. New template becomes available in this context

**Note:** Template context is passive in creation—it receives templates from VM Lifecycle via Storage.

---

## Error Responses

| Scenario | HTTP Status | Message |
|----------|-------------|---------|
| Invalid name format | 400 | "Invalid template name" |
| Protected template | 403 | "Cannot delete protected template" |
| Template not found | 404 | "Template not found" |

---

## Domain Events (Implicit)

| Event | Trigger | Notes |
|-------|---------|-------|
| TemplateCreated | Snapshot completes | Triggered by VM Lifecycle, not this context |
| TemplateDeleted | `deleteTemplate()` | Explicit deletion |

---

## Dependencies

| Context | Direction | Purpose |
|---------|-----------|---------|
| VM Lifecycle | Upstream | Provides templates for VM creation |
| Storage | Downstream | Template files are managed via Storage |

---

## Code Location

| Component | File | Lines |
|-----------|------|-------|
| Template interface | `src/services/template.ts` | 5-9 |
| listTemplates | `src/services/template.ts` | 11-34 |
| deleteTemplate | `src/services/template.ts` | 36-54 |
