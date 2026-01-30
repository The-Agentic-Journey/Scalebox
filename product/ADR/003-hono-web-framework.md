# ADR-003: Use Hono as Web Framework

## Status

Accepted

## Context

The API server needs a web framework for HTTP routing and middleware. Options considered:

1. **Express** - Industry standard, huge ecosystem
2. **Fastify** - Performance-focused, schema validation
3. **Hono** - Ultralight, multi-runtime support
4. **Koa** - Minimalist, middleware-focused
5. **No framework** - Use Bun's native HTTP server directly

## Decision

We chose **Hono** as the web framework.

## Rationale

### Why Hono

1. **Ultralight** - Tiny bundle size (~14KB). Minimal overhead for a simple API.

2. **Multi-runtime** - Works on Bun, Node.js, Deno, Cloudflare Workers. Not locked to one runtime.

3. **TypeScript-first** - Excellent type inference for routes, middleware, and context.

4. **Fast routing** - Uses Trie-based router. Not a bottleneck for our use case, but nice to have.

5. **Built-in middleware** - Bearer auth, CORS, and other common middleware included.

6. **Bun optimized** - Designed to work well with Bun's HTTP server.

### Why Not Alternatives

- **Express**: Large dependency tree. Callback-style API feels dated with async/await.
- **Fastify**: More complex than needed. Schema validation overhead not required for internal API.
- **Koa**: Similar philosophy to Hono but less active development.
- **No framework**: Would need to reinvent routing, middleware composition, error handling.

## Consequences

### Positive

- Minimal dependencies (just `hono` package)
- Clean, modern API with async/await
- Easy to understand routing code
- Built-in bearer token middleware

### Negative

- Less ecosystem support than Express
- Fewer Stack Overflow answers for troubleshooting
- Some Express middleware not directly compatible

### Neutral

- Learning curve minimal for anyone familiar with Express
- Middleware model is similar to other frameworks

## Code Example

```typescript
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));
app.use("/*", bearerAuth({ token: config.apiToken }));
app.get("/vms", (c) => c.json({ vms: listVms() }));
```

## References

- [Hono Documentation](https://hono.dev/)
- [Hono GitHub](https://github.com/honojs/hono)
- Package.json shows single dependency: `"hono": "^4.6.0"`
