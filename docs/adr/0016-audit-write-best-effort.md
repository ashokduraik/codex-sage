# ADR 0016 — Audit writes are always best-effort

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (Phase 10)

## Context

Backend §150 requires auditable records for security-sensitive and administrative
operations. The Phase 10 plan (§4.4) proposed failing admin mutations when the audit
insert fails (same MongoDB transaction as the business write) so gaps cannot form
silently. That trades availability for completeness: a transient Mongo write error
would roll back a successful password change or admin action.

## Decision

- `recordAuditEvent` is **always best-effort**: it never throws to callers. Insert
  failures are logged at `error` with the correlation id; the HTTP response and
  business write are unchanged.
- Audit inserts run **outside** business transactions so a failed audit write cannot
  roll back a committed mutation.
- Denied authorization events on admin/security routes use the same best-effort path.

## Consequences

- Callers (password routes, authorize hook, later Phase 11+ admin APIs) always call
  one writer API.
- An incident review may find a missing audit row after a successful mutation; ops
  must correlate via application logs using `correlationId`.
- Phase 11 must not join audit inserts into the business transaction for fail-closed
  semantics.

## Alternatives considered

- **Fail-closed / same transaction** (phase plan §4.4) — rejected for this product
  posture; availability of admin and password flows wins over guaranteeing the row.
- **Dual APIs** (`recordAuditEvent` throws + `recordAuditEventBestEffort`) — rejected
  as unnecessary complexity once the policy is always best-effort.

## Escape hatch

If operations later require fail-closed audit for a subset of mutations, introduce an
explicit opt-in (named constant or ADR-backed flag) rather than changing the default
writer behavior silently.
