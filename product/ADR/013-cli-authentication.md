# ADR-013: CLI Authentication and Configuration

## Status

Accepted

## Context

The Scalebox CLI needs to authenticate against the API server. ADR-008 established bearer token authentication for the API itself. This ADR addresses how the CLI obtains and stores credentials.

Use cases:
1. **Server-side admin**: Running `sb` on the same machine as `scaleboxd`
2. **Remote client**: Running `sb` from a developer workstation against a remote server
3. **CI/CD automation**: Running `sb` in scripts without interactive prompts
4. **Testing**: Running `sb` with isolated config to avoid affecting user settings

## Decision

### Configuration Hierarchy

The CLI reads configuration from multiple sources with clear precedence (highest to lowest):

1. **CLI flags**: `--host`, `--token` (not implemented initially, reserved for future)
2. **Environment variables**: `SCALEBOX_HOST`, `SCALEBOX_TOKEN`
3. **User config file**: `~/.config/scalebox/config`
4. **System config file**: `/etc/scalebox/config` (for server-side usage)

The config directory can be overridden via `SCALEBOX_CONFIG_DIR` environment variable, enabling isolated testing.

### Config File Format

Shell-sourceable format for simplicity:

```
SCALEBOX_HOST=https://api.example.com:8080
SCALEBOX_TOKEN=sb-abc123...
```

### Login Flow

`sb login` provides interactive and non-interactive modes:

```bash
# Interactive (prompts for host and token)
sb login

# Non-interactive (for scripts)
sb login --host https://api.example.com --token-stdin < token.txt
```

Token input is masked during interactive prompt. The `--token-stdin` flag reads from stdin to avoid exposing tokens in process lists or shell history.

### Security Measures

- Config file created with mode 600 (owner read/write only)
- Config directory created with mode 700
- Tokens never passed as command-line arguments (use `--token-stdin` or interactive prompt)
- `sb config show` masks tokens by default

## Consequences

### Positive

- Standard UX familiar from other CLI tools (gh, aws, gcloud)
- Works for both local server admin and remote client usage
- Testable with isolated config directories
- No root required for client-only installation

### Negative

- Two config file locations to understand (user vs system)

### Backward Compatibility

The existing `SCALEBOX_URL` environment variable is mapped to `SCALEBOX_HOST` internally for backward compatibility.
