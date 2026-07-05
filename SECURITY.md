# Security Policy

`@cliwant/mcp-sam-gov` is a **keyless, read-only** MCP server: it holds no
credentials, writes nothing, and only reads public US federal procurement data
(SAM.gov, USAspending, eCFR/FAR, Federal Register, Grants.gov, GAO, SBA). It
still processes **untrusted input** — a caller-supplied attachment URL that it
fetches, and document/feed bytes it parses — so we take security seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report privately via **GitHub Security Advisories**:
[github.com/cliwant/mcp-sam-gov/security/advisories/new](https://github.com/cliwant/mcp-sam-gov/security/advisories/new)
(repo → **Security** → **Report a vulnerability**). Include a description, the
affected version, and a minimal reproduction if possible.

We aim to acknowledge a report within **5 business days** and to ship a fix or a
mitigation for a confirmed high-severity issue promptly, crediting the reporter
unless anonymity is requested.

## Supported versions

The latest published `0.x` minor is supported. Pre-`1.0`, fixes land on `main`
and a new patch/minor release; there is no long-term back-porting yet.

## Threat model & hardening

This server runs as a local stdio subprocess of an MCP host (Claude Desktop,
Codex CLI, etc.). Notable surfaces and their mitigations:

- **SSRF (attachment fetching).** `sam_fetch_attachment_text` fetches a
  caller-supplied URL. It is restricted by an allow-list: `https://` only, host
  must be `sam.gov`, `api.sam.gov`, or a `.sam.gov` subdomain. Because SAM's
  download endpoint 303-redirects to a time-signed S3 URL, redirects are
  followed but the **final** host is re-validated against a pinned allow-list
  (only `*.sam.gov` or SAM's specific S3 attachment bucket is accepted — not all
  of AWS S3; an unverifiable/hidden redirect target is rejected). Internal IPs, cloud-metadata endpoints (`169.254.169.254`),
  `localhost`/`[::1]`, non-`https` schemes, and userinfo/look-alike hosts are
  refused before any bytes are read back.
- **Resource exhaustion.** Attachment downloads are capped
  (`MAX_ATTACHMENT_BYTES`); DOCX/ZIP inflation is bounded (`maxOutputLength`) to
  defuse zip bombs; the hand-rolled ZIP/CSV/XML/RSS parsers are bounds-checked
  and fuzz-tested against hostile bytes (they return a classified error, never
  crash/hang/OOB).
- **No secrets.** The server needs no API key. Do not commit credentials; none
  are required to run it.
- **Truthful failure.** A degraded/unavailable upstream throws a classified
  error — it is never silently reported as "no results" (a CI lint enforces
  this), so a consumer is not misled into acting on a masked failure.

## Supply chain

Three runtime dependencies: `@modelcontextprotocol/sdk`, `unpdf`, `zod`. A
non-blocking CI job runs `npm audit --omit=dev` on every push for visibility.

`@modelcontextprotocol/sdk` bundles a full HTTP/SSE server transport (`express`,
`@hono/node-server`, `ajv`) for hosts that speak MCP over HTTP. **This server uses
only the stdio transport** — it never imports or instantiates the HTTP transport
(verified: no `express`/`hono`/`StreamableHTTP` references in `src/`) — so
advisories in those packages are **not reachable** in this deployment. We
nonetheless patch them, for supply-chain hygiene and a clean audit, via
`package.json` `overrides` pinning within-major, non-breaking patched versions
(e.g. `qs`, `fast-uri`, `hono`, `ip-address`); the deterministic gate + fault
suite verify the stdio path is unchanged by these bumps. When the SDK updates its
transitive deps upstream, we drop the overrides. `npm audit --omit=dev` currently
reports **0** production vulnerabilities.

## Scope

In scope: the server code in this repository (tool handlers, fetch/parse paths,
input validation). Out of scope: vulnerabilities in the upstream government data
services themselves, and in the MCP host that launches this server.
