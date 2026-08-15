# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| `0.1.x` | Yes |
| `< 0.1` | No |

The bridge is pinned to DeepSeek Harness `0.1.0-rc.6`. Treat a DSH upgrade as a security-sensitive compatibility change and rerun the full validation suite before deployment.

## Reporting a vulnerability

Please use GitHub's private vulnerability-reporting flow for `ishuowang/dsh-rolehub-bridge`. Do not open a public issue containing credentials, private Hub URLs, Session or Room ids, transcripts, archive contents, or exploit details. Include the affected version, Host/Node versions, minimal reproduction, expected boundary, and observed behavior. Rotate any credential that may have been exposed before reporting it.

## Threat model

Downloaded catalogs and role archives are untrusted input. A role is portable data, not trusted Host code, and may request capabilities but can never grant them to itself. The bridge and the installed DSH/RoleHub compatibility packages do execute inside the trusted Host process and must be reviewed as privileged code.

The bridge protects against accidental or malicious broadening through size limits, HTTPS-only credential-free endpoints, safe extraction, exact digests, a Host-owned allowlist, fixed tool bindings, durable receipts, and fail-closed activation. It does not claim to protect against a compromised Host process, malicious DSH plugin, compromised dependency, kernel escape, or an operator who grants an unsafe configuration.

## Hub, archive, and filesystem boundary

- Configure only credential-free `https:` catalog and archive templates. Redirects remain on the request host unless the exact target hostname is allowlisted for that Hub; IP-literal and insecure targets are rejected.
- Hostname checks do not pin DNS answers or replace an egress firewall. Run untrusted/community Hubs behind network policy that blocks loopback, private, link-local, and metadata-service ranges.
- Catalog and archive bodies are bounded by `maxCatalogBytes` and `maxArchiveBytes`; timeouts are bounded by `fetchTimeoutMs`.
- Archive extraction rejects traversal, symlinks, links, device entries, and content outside the deployment root. RoleHub validation rejects executable role payload patterns unsupported by the protocol.
- Catalog metadata, archive SHA-256, manifest digest, and final bundle digest must agree before a role becomes installable.
- Publisher trust is scoped to one configured Hub. A third-party Hub cannot inherit another Hub's trusted publisher names merely by copying `publisher` and `trust` fields.
- Validated catalog fallback has a bounded age (24 hours by default); expired cache is unavailable rather than silently treated as current discovery data.
- Offline cache may support inspection and an already pinned deployment, but it cannot authorize a first-time installation.
- The cache root requires a private, dedicated ownership marker; dangerous roots and non-private or non-empty unclaimed directories fail closed without permission changes. Files use `0600`, writes use atomic replacement, and records have explicit schemas. Do not share or hand-edit the directory.
- Digest equality proves content integrity against the selected catalog entry. It is not a publisher signature. `reference` and `community` are policy labels, not cryptographic identities.

## Capability and activation boundary

The effective grant set is:

```text
required role requests ∩ bridge-supported capabilities ∩ Host allowedCapabilities
```

Denied requests are never granted. Optional requests are not granted in v0.1 because there is no interactive approval broker. If one required capability cannot be represented by a fixed Host binding, installation fails. Roles have no model-facing tool for installing roles, editing policies, starting role Sessions, or attaching themselves to Rooms.

Policy enforcement is implemented by DSH tool restrictions and guards in the same Host process. The receipt honestly records `process: shared`, `approvals: none`, and tool-policy—not OS-level—filesystem/network enforcement. It is not a container, VM, syscall sandbox, egress firewall, or secret broker. Keep sensitive credentials outside role prompts, files, and inherited environment.

Role-declared turn/output/time limits and model-class preferences are not enforced by this bridge version. Configure authoritative limits in the DSH Host/Session until a native mapping is implemented.

Role setup is scoped to a newly created continuable child Session. The bridge does not mutate the active parent conversation. Every registration is collected under one lifecycle disposer so failed setup rolls back instead of leaving partial prompt, skill, or tool state.

## Cold-resume boundary

Role provider ids are derived from the full bundle digest. On cold continuation, the bridge loads the exact persisted deployment and verifies the provider mapping, role/manifest/bundle digests, effective-policy digest, grants, and fixed Host bindings before publishing the child. Missing, stale, edited, or mismatched state fails closed. It never substitutes a newer same-name role automatically.

The bridge stores catalog snapshots, verified role trees, deployment/policy receipts, and prompt-free Session bindings. It must not store Session transcripts, Room message bodies, secrets, or initial user prompts as bridge audit metadata.

## Native Web boundary

The Web client is an additive DSH extension built with official typed slots and native primitives. It must not query or patch arbitrary DOM, replace the DSH root, inject global CSS, or maintain a second authorization path.

The `/rolehub-bridge/api/session/<id>` endpoint accepts only `GET` and `HEAD`, requires a live exact Session, applies same-site browser checks, disables caching, and returns an allowlisted projection. Hub URLs, archive URLs, local paths, stored receipts/bindings, prompts, transcripts, and private Room details remain Host-only. Every mutation goes through the current live Agent's `/rolehub` Host command, which repeats ownership and availability checks.

`Sec-Fetch-Site` and same-origin fetch behavior are browser hardening, not authentication. Before exposing DSH remotely, terminate authenticated TLS in front of it, restrict the origin, keep the Host patched, and do not rely on an unguessable Session id.

## Optional Room boundary

Agent Team Room is not required. Without it, a verified role remains an independent DSH child Session. With it, the bridge attaches the already created Session through Room's public Host API and supplies only descriptive RoleHub provenance. That provenance cannot grant capabilities or establish trust.

Session creation, Room membership, and receipt persistence are not one transaction. If finalization fails, the bridge attempts provider-owned member removal, interrupts the child, and writes an orphaned binding. Operators should inspect such failures; cleanup is compensating and can itself fail. Detaching or closing a Room never deletes the backing Session.

## Deployment checklist

- Pin the plugin, DSH, RoleHub core, and compatibility package versions.
- Keep `allowCommunityRoles: false` unless the risk has been reviewed.
- Minimize `allowedCapabilities`; do not grant filesystem write or network access by default merely because a role requests it.
- Review new publisher ids, Hub endpoints, catalog changes, and bundle digests before rollout.
- Protect DSH Web with authenticated TLS and network access controls.
- Back up and permission-check `storageDir`; never publish it in bug reports or artifacts.
- Run `npm ci`, `npm run check`, `npm pack --dry-run`, and `git diff --check` before release.
