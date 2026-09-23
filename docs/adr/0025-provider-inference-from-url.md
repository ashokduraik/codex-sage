# ADR 0025 — Provider inference from repository URL

- Status: Accepted
- Date: 2026-09-23
- Deciders: product owner (Phase 30)

## Context

Frontend §10 forbids a provider picker. The UI sends a URL; the backend must decide
GitHub, GitLab.com, or self-hosted GitLab. Requirements name those three only.

## Decision

- `github.com` → provider `github`, `baseUrl` null.
- `gitlab.com` → provider `gitlab`, `baseUrl` null.
- Any other host → provider `gitlab` with `baseUrl` `https://<host>` (self-hosted).
- The first call to an unknown host is the GitLab project lookup. A host that does not
  answer as a GitLab JSON API returns `unreachable` / `provider_not_supported`.
- GitHub Enterprise Server and Bitbucket are unsupported in this slice.

## Consequences

- Probe and attach share one resolver. The frontend builds the self-hosted token-page
  link from `baseUrl` in every probe state.
- A self-hosted GitHub instance is reported as unsupported GitLab, not silently probed
  as GitHub.

## Alternatives considered

- **Client-side provider picker** — rejected; frontend §10 forbids it.
- **Provider field on the request** — rejected; duplicates inference and invites
  mismatch with the URL.

## Escape hatch

Add an explicit `hostKind` override later if GitHub Enterprise must be supported,
behind a new ADR.
