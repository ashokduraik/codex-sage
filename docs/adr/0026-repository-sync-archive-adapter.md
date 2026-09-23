# ADR 0026 — Repository sync uses the provider archive API

- Status: Accepted
- Date: 2026-09-23
- Deciders: product owner (Phase 32)

## Context

Solution §4.8B allows either `git fetch`/`clone` or a provider API archive for
`repo_sync`. A git clone needs a binary on PATH, a temp workspace, and disk
cleanup. The upload path already accepts zip bytes into GridFS.

## Decision

MVP `repo_sync` downloads a zip via the GitHub zipball / GitLab `archive.zip`
APIs after a lightweight commit SHA lookup. Same SHA skips the download.
Git clone is not wired.

GitHub zipball may redirect to `codeload.github.com`; that host is allowlisted
for the download hop only, and Authorization headers are not forwarded.

## Consequences

- Reuses Phase 23/24 zip inspection, exclusions, and GridFS writes.
- No `WORKSPACE_ROOT` clone directory and no git binary dependency.
- LFS objects and gitlinks that are not in the archive are not imported.

## Alternatives considered

- **Local git fetch/clone** — more complete trees; rejected for MVP operational
  cost (binary, disk, cleanup).
- **Both adapters with a runtime switch** — extra surface before product needs it.

## Escape hatch

Add a `gitSyncAdapter` behind a new ADR if archive contents prove insufficient.
