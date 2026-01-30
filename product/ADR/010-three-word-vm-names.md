# ADR-010: Three-Word Human-Readable VM Names

## Status

Accepted

## Context

VMs need identifiers. Options:

1. **UUID** - Standard unique identifier (e.g., `550e8400-e29b-41d4-a716-446655440000`)
2. **Short ID** - Truncated random hex (e.g., `vm-a1b2c3d4`)
3. **Sequential** - Auto-incrementing numbers (e.g., `vm-1`, `vm-2`)
4. **Human-readable words** - Memorable combinations (e.g., `very-silly-penguin`)

## Decision

We chose **three-word human-readable names** in the format `adverb-adjective-noun`.

VMs also have a short hex ID (`vm-a1b2c3d4e5f6`) for internal use, but the name is the primary user-facing identifier.

## Rationale

### Why Three-Word Names

1. **Memorable** - "very-silly-penguin" is easier to remember than "vm-a1b2c3d4"

2. **Speakable** - Can be communicated verbally: "Check the logs on very-silly-penguin"

3. **Typeable** - No special characters. Easy to type in terminals and URLs.

4. **DNS compatible** - Works directly as subdomain: `very-silly-penguin.vms.example.com`

5. **Sufficient uniqueness** - 30 adverbs × 100 adjectives × 100 nouns = 300,000 combinations

### Why Not Alternatives

- **UUID**: Impossible to remember or type. Poor UX.
- **Short ID**: Still random characters. Not memorable.
- **Sequential**: Reveals information about system (how many VMs created). Collisions if reset.

### Why adverb-adjective-noun

- Three words provides good uniqueness (300K combinations)
- Adverbs as intensifiers add variety: "very-happy" vs "barely-happy"
- Results are grammatically sensible phrases
- Similar approach used by Docker, Heroku, what3words

## Implementation

### Word Lists

```typescript
// src/services/wordlists.ts
export const adverbs = ["almost", "barely", "boldly", "clearly", ...]; // ~30
export const adjectives = ["amber", "azure", "bold", "brave", ...];    // ~100
export const nouns = ["alpaca", "badger", "beacon", "bear", ...];      // ~100
```

### Generation Algorithm

```typescript
// src/services/nameGenerator.ts
export function generateUniqueName(): string {
  const existingNames = new Set(Array.from(vms.values()).map(vm => vm.name));

  for (let i = 0; i < 100; i++) {
    const name = `${pickRandom(adverbs)}-${pickRandom(adjectives)}-${pickRandom(nouns)}`;
    if (!existingNames.has(name)) {
      return name;
    }
  }

  // Fallback: append timestamp suffix
  const name = `${pickRandom(adverbs)}-${pickRandom(adjectives)}-${pickRandom(nouns)}`;
  return `${name}-${Date.now().toString().slice(-4)}`;
}
```

### Integration

- Names assigned automatically on VM creation
- Users can optionally provide custom names
- Names used in HTTPS URLs: `https://{name}.{base-domain}`

## Examples

| Generated Name | URL |
|----------------|-----|
| very-silly-penguin | https://very-silly-penguin.vms.example.com |
| quite-bold-falcon | https://quite-bold-falcon.vms.example.com |
| super-calm-tiger | https://super-calm-tiger.vms.example.com |

## Consequences

### Positive

- Excellent user experience
- Works naturally with DNS
- Easy to communicate and remember
- Fun and friendly system personality

### Negative

- 300K limit (sufficient for single-host deployment)
- Collision checking required
- Name uniqueness only within running VMs (deleted names can be reused)

### Neutral

- Internal ID still exists for programmatic use
- Custom names supported for users who want control

## Word List Curation

Words are chosen to be:
- Positive or neutral (no negative words)
- Easy to spell
- Unambiguous pronunciation
- Family-friendly
- DNS-safe (no special characters)

## References

- Word lists: `src/services/wordlists.ts`
- Generator: `src/services/nameGenerator.ts`
- Plan: `product/plans/done/004-PLAN-VM-NAMES.md`
