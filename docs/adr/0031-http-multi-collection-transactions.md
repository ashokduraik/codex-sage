# ADR 0031 — HTTP APIs that write two domain collections use a transaction

- Status: Accepted
- Date: 2026-09-26
- Deciders: product owner
- Complements: [ADR 0001](./0001-mongodb-replica-set.md), [ADR 0016](./0016-audit-write-best-effort.md)

## Context

ADR 0001 allows multi-document transactions on the replica set. Several HTTP APIs
write two or more domain collections in one request (login updates `users` and
creates a `loginsessions` row; deactivate updates the user and revokes sessions;
role/member changes bump `organizations.aclVersion`). Without a transaction a crash
or mid-request write error can leave one collection committed and the other not.

Password change and user remove already wrap their paired writes. The rest of the
mutating HTTP surface did not.

## Decision

- Every HTTP API that writes **two or more domain collections** in one request MUST
  run those writes inside one `mongoose.startSession()` + `withTransaction()`.
- Repository helpers that participate in such a request accept optional `{ session }`
  and attach it when present.
- CPU-bound work (password hash, repository probe) stays **outside** the transaction
  so locks stay short.
- `recordAuditEvent` stays **outside** the business transaction (ADR 0016).
- `idempotencyRecords` stay outside the business transaction (cross-cutting overlay).
- GridFS byte writes stay **before** the transaction; document metadata joins the txn.
- One collection, many documents (`updateMany`, `insertMany`) does not require a txn.
- Worker / job stages are not one HTTP API; do not wrap a whole ingest or sync job
  in a single transaction.

## Consequences

- Login, deactivate, email change, ACL bumps, conversation create/delete, repository
  attach/revoke, manual sync enqueue, and upload persist (including project lifecycle)
  share the same transactional shape as password change.
- Tests that mock repositories must also mock `mongoose.startSession`.
- Replica-set topology remains required (ADR 0001 / 0009).

## Alternatives considered

- **Leave pairing to best-effort sequential writes** — rejected; crash windows leave
  live sessions after disable, or a user row without a login session.
- **Join audit / idempotency / GridFS into the business transaction** — rejected;
  ADR 0016 and the existing GridFS-before-txn upload pattern stay.

## Escape hatch

Supersede if a specific HTTP path must stay non-transactional (document the path and
why). Do not silently skip the rule.
