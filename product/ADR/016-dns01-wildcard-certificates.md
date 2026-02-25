# ADR 016: DNS-01 Wildcard Certificates

## Status

Accepted

## Context

ADR 009 established Caddy with on-demand TLS using HTTP-01 challenges for per-VM certificate issuance. This approach had several drawbacks:

1. **Slow VM readiness**: Each new VM triggered an individual certificate request via HTTP-01. The ACME handshake added seconds to VM creation, delaying when the VM's HTTPS endpoint became usable.

2. **Validation endpoint complexity**: On-demand TLS required a `/caddy/check` endpoint in Scalebox so Caddy could verify whether a subdomain belonged to an active VM before requesting a certificate. This was additional code and an additional internal HTTP round-trip on every new connection.

3. **Scaling limitations**: Let's Encrypt enforces rate limits of 50 certificates per registered domain per week. As VM creation volume increased, this ceiling became a practical constraint.

4. **Per-VM certificate overhead**: Every VM had its own certificate, meaning Caddy managed potentially hundreds of certificates with independent renewal timers.

## Decision

Replace per-VM HTTP-01 certificates with a single wildcard certificate obtained via DNS-01 challenge:

1. **Wildcard certificate**: A single certificate covers `*.vm.{BASE_DOMAIN}` (all VM subdomains) and `api.{BASE_DOMAIN}` (API endpoint). One cert, one renewal cycle.

2. **In-process DNS server**: Run an authoritative DNS server (`dns2` library) inside the scaleboxd process. This server handles `_acme-challenge` TXT record queries that the ACME provider sends during DNS-01 validation.

3. **Caddy with acmeproxy**: Use the `caddy-dns/acmeproxy` module so Caddy delegates DNS-01 challenge record creation to the local DNS server via an HTTP API, rather than requiring credentials for an external DNS provider.

4. **NS delegation**: The domain operator creates a single NS record delegating `_acme-challenge.vm.{BASE_DOMAIN}` (and `_acme-challenge.api.{BASE_DOMAIN}`) to the Scalebox host. This allows the in-process DNS server to answer ACME validation queries authoritatively.

5. **Single domain config**: `BASE_DOMAIN` replaces the previous `API_DOMAIN` / `VM_DOMAIN` split. The API lives at `api.{BASE_DOMAIN}`, VMs live at `{name}.vm.{BASE_DOMAIN}`.

## Consequences

### Positive

- VM creation is faster — no per-VM certificate wait; the wildcard cert is already issued
- Simpler Caddy configuration — no on-demand TLS block, no `/caddy/check` validation endpoint
- No Let's Encrypt rate limit concerns — one certificate regardless of VM count
- Fewer moving parts — one certificate renewal instead of one per VM

### Negative

- Requires NS delegation for `_acme-challenge` subdomains in the domain's DNS configuration
- Requires port 53 (UDP and TCP) open on the host for inbound DNS queries from ACME providers
- Additional in-process component (DNS server) that must be reliable for certificate renewal

### Neutral

- Single `BASE_DOMAIN` configuration replaces separate `API_DOMAIN` and `VM_DOMAIN` variables
- Caddy still handles TLS termination and reverse proxying — only the certificate acquisition method changes
- DNS server only needs to respond to `_acme-challenge` queries; it is not a general-purpose DNS server

## Supersedes

- **ADR 009 (Caddy for HTTPS with Automatic TLS)**: ADR 009 used per-VM HTTP-01 challenges with on-demand TLS and a `/caddy/check` validation endpoint. This ADR replaces that with a single DNS-01 wildcard certificate, eliminating the per-VM issuance delay and the check endpoint.
