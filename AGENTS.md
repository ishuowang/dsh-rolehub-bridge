# Repository workflow

- Create development branches with the `feature/` prefix and open a pull request for every feature.
- Keep `main` releasable. Run `npm run check`, `npm pack --dry-run`, and `git diff --check` before publishing.
- Never commit credentials, DSH profiles, Session transcripts, Room message bodies, private ids, or real user screenshots.
- Treat downloaded roles as untrusted input. Require HTTPS, bounded downloads, safe extraction, exact manifest and bundle digests, and a Host-owned capability allowlist.
- Scope trusted publisher ids to one configured Hub and constrain redirect hosts explicitly; catalog self-claims never establish publisher identity.
- Claim only a private, marker-owned storage leaf. Refuse dangerous/shared roots and never chmod an arbitrary pre-existing directory.
- A role never grants itself tools, network, secrets, shell access, or Room authority. Compute effective access as the intersection of role requests, bridge support, Host policy, and the user's explicit role-selection action.
- Do not hot-mutate an active conversation into another role. Create a continuable, role-scoped child Session so setup is reproducible on cold resume.
- Keep Agent Team Room optional and role-neutral. The bridge may attach an already verified role Session through Room's public Host API; do not copy role prompts or skills into Room.
- Extend DSH Web only through official typed slots, native primitives, same-origin APIs, and Host commands. Never patch arbitrary DOM, inject global CSS, or replace native surfaces.
- Keep native API responses allowlisted. Mutations must pass through an Agent-scoped Host command and repeat ownership checks.
- Keep English and Chinese READMEs aligned. Any UI screenshots must come from the real bundled client using synthetic data.
- Never automate stars, watches, follows, telemetry, or unrelated outbound actions.
