# ADR-002: Use Bun as Runtime

## Status

Accepted

## Context

The API server needs a runtime environment. Options considered:

1. **Node.js** - Mature ecosystem, widespread adoption
2. **Deno** - Security-first, TypeScript native
3. **Bun** - Fast all-in-one toolkit with TypeScript support
4. **Go** - Compiled, excellent for systems programming
5. **Rust** - Memory safe, high performance

## Decision

We chose **Bun** as the runtime for the API server.

## Rationale

### Why Bun

1. **TypeScript native** - No transpilation step required. Write TypeScript, run TypeScript.

2. **Single-binary compilation** - `bun build --compile` produces a self-contained executable with no runtime dependencies. Simplifies deployment.

3. **Fast startup** - Bun starts faster than Node.js, beneficial for serverless-style workloads.

4. **Built-in tooling** - Package manager, test runner, and bundler included. No need for npm/yarn, Jest/Vitest, webpack/esbuild.

5. **Node.js compatibility** - Most npm packages work unchanged. Can leverage existing ecosystem.

6. **Shell integration** - `Bun.$` template literal makes shell commands ergonomic in TypeScript.

### Why Not Alternatives

- **Node.js**: Requires separate TypeScript compilation step. Deployment requires shipping node_modules or bundling.
- **Deno**: Less mature ecosystem, some npm packages don't work. No single-binary compilation.
- **Go**: Would work well, but team has more TypeScript experience. Less ergonomic for rapid iteration.
- **Rust**: Higher development overhead. Compile times slow iteration speed.

## Consequences

### Positive

- Zero-config TypeScript development
- Simple deployment (single binary)
- Fast test execution with `bun test`
- Shell commands feel natural in code

### Negative

- Bun is younger than Node.js, potential for undiscovered bugs
- Some Node.js APIs have subtle differences
- Smaller community for troubleshooting
- IDE support slightly behind Node.js

### Neutral

- Team needed to learn Bun-specific APIs
- Build process is straightforward: `bun build --compile --outfile scaleboxd src/index.ts`

## References

- [Bun Documentation](https://bun.sh/docs)
- [Bun vs Node.js](https://bun.sh/docs/runtime/nodejs-apis)
- Initial commit: `1087c98` - "Initialize Bun project structure"
