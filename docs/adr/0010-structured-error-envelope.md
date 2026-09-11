# ADR 0010 — Structured error envelope and correlation IDs

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (plan README §2)

## Context

Phase 01 shipped a minimal `{ error: { code, message, details? } }` body. Cross-cutting
requirements need a stable machine-readable taxonomy (class + retryability), a support
reference on every failure, and the same identifier in logs and response headers. Without a
single catalog, later domain modules invent incompatible codes.

## Decision

- Every JSON error uses:

```json
{
  "error": {
    "code": "KNOWLEDGE_UNAVAILABLE",
    "class": "knowledge",
    "retryability": "temporary",
    "message": "Project knowledge is being updated.",
    "reference": "REQ-…",
    "details": {}
  }
}
```

- `class` and `retryability` are public. `details` appears only when the catalog allowlists
  the code (`VALIDATION_ERROR`, `RATE_LIMITED`); values never include secrets, paths, or hosts.
- Codes live only in `backend/src/platform/errorCatalog.js`.
- Correlation id **is** Fastify `request.id`, format `REQ-` + 32 hex from `randomUUID()`
  (dashes stripped). Inbound `X-Correlation-Id` is ignored. The same value is set on every
  response via `X-Correlation-Id` and as `error.reference`.
- Catalog English messages are defaults; Phase 13 maps codes to i18n keys.

## Consequences

- Clients can branch on `code` and optionally on `retryability` without scraping messages.
- Support can match a UI reference to log `reqId` without a mapping table.
- Unknown codes are defects: serve `INTERNAL_ERROR` and log at `error`.

## Alternatives considered

- Code/message only (keep class/retryability internal) — rejected; public fields avoid
  frontend hardcoding retry policy per code.
- Honour inbound correlation ids — rejected; attacker-controlled references poison support
  lookups and inject content into logs.
- ULID package — rejected for this phase; UUID hex needs no dependency.

## Escape hatch

Supersede with a new ADR if a trusted gateway must propagate correlation ids, or if support
tooling requires sortable ULIDs.
