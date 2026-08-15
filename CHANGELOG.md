# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-15

### Added

- RoleHub catalog v1alpha2 discovery across Host-configured HTTPS Hubs, with v1alpha1 role manifests and profile provenance kept as separate contracts.
- Bounded catalog/archive downloads, safe extraction, digest-locked deployments, validated cache fallback, and private atomic persistence.
- Host-owned effective capability policies with fixed DSH tool bindings; optional capabilities remain ungranted.
- Continuable, role-scoped child Sessions with digest-derived providers and cold-resume revalidation.
- Agent-scoped `/rolehub` discovery, inspection, refresh, start, and Session-binding commands.
- Optional Agent Team Room attachment with non-authorizing RoleHub provenance and compensation on partial failure.
- Additive native DSH header, sidebar, and Room-provider entries using typed slots and a shared native modal.
- Same-origin, read-only, live-Session-scoped browser snapshot with an explicit response allowlist.
- English and Simplified Chinese documentation plus synthetic-data UI concept previews.

### Security

- Roles cannot self-grant capabilities or invoke the role installation path through model-facing tools.
- Bundle, manifest, deployment, policy, and fixed bindings are rechecked before activation and cold continuation.
- Publisher trust is Hub-scoped; redirect hosts, cache age, and dedicated marker-owned storage roots fail closed.
- Catalog URLs, archive URLs, local paths, policy receipts, provider bindings, prompts, transcripts, and Room messages are excluded from the browser projection.

### Known limitations

- DSH integration is pinned to the `0.1.0-rc.6` developer preview.
- Integrity uses exact digests; publisher signatures, transparency logs, revocation, and interactive approvals are not implemented.
- Enforcement is shared-process DSH tool policy, not an OS sandbox.
- Room attachment uses best-effort compensation rather than a cross-plugin transaction.

[Unreleased]: https://github.com/ishuowang/dsh-rolehub-bridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ishuowang/dsh-rolehub-bridge/releases/tag/v0.1.0
