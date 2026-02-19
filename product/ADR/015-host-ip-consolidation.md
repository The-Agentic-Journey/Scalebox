# ADR 015: Required Host IP Configuration

## Status

Accepted

## Context

The system had two environment variables serving the same purpose — identifying the external IP of the Scalebox host:

- `VM_HOST`: Used in `vmToResponse()` for the SSH command field. Not set in the server config; defaults to `localhost`.
- `HOST_IP`: Used in the `/info` endpoint with auto-detection fallback via `ip route get 1.1.1.1`.

This caused two problems:
1. The `ip` field in VM API responses returned the internal bridge IP (`172.16.x.x`), which is unreachable by API consumers.
2. The `ssh` field defaulted to `localhost`, which is only correct when the client runs on the same machine as the server.

Runtime auto-detection via `ip route get 1.1.1.1` is unreliable on cloud VMs behind NAT (GCE, AWS), where it returns the VPC-internal IP rather than the public IP.

## Decision

Make `HOST_IP` a required configuration value set at install time:

1. The bootstrap installer prompts for the host IP during interactive setup, with `hostname -I` as a suggested default.
2. The value is written to `/etc/scaleboxd/config` as `HOST_IP=<value>`.
3. The server refuses to start if `HOST_IP` is not set, with a clear error message.
4. `vmToResponse()` uses `config.hostIp` directly for the `ip` and `ssh` fields.
5. The `/info` endpoint uses `config.hostIp` directly.
6. `VM_HOST` is removed from server-side code.
7. `scalebox-update` adds `HOST_IP` to existing configs (auto-detected) during upgrades.

## Consequences

- **API breaking change**: The `ip` field in VM responses changes from internal IP (`172.16.x.x`) to host IP. No known consumers relied on the internal IP.
- **Install-time configuration**: Operators explicitly set the IP during install, ensuring correctness even on NAT-ed cloud VMs.
- **Strict startup validation**: Missing `HOST_IP` prevents the server from starting, catching configuration errors early.
- **Backwards compatible on upgrade**: `scalebox-update` auto-detects and adds `HOST_IP` to existing configs. Operators on NAT-ed environments should verify the auto-detected value.
- **Test infrastructure unaffected**: Tests use `VM_HOST` in the test runner process (not the server), which remains unchanged. The `./do` script passes `HOST_IP=$VM_IP` (the GCE external IP) during automated bootstrap.
