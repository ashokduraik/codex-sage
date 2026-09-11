# ADR 0006 — zod for env and request validation

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (plan README §2)

## Context

Plain JavaScript needs runtime checks at process boundaries: validated environment config
and HTTP params/query/body before business logic. The config loader must be the only place
that reads `process.env` for application settings.

## Decision

- **zod** validates environment configuration in the central config module (Phase 01).
- **zod** (or equivalent schemas at the route edge) validates request inputs before
  handlers run domain logic.
- Tunables that must not differ per environment remain **named constants**, not zod-env
  fields (D13).

**Timing:** Env schema is retrospective (Phase 01). Broad route-body validation rolls out
with domain APIs in later phases.

## Consequences

- Invalid config fails fast at boot instead of failing mid-request.
- Clients get consistent validation errors via the structured envelope (ADR 0010).
- No competing validation libraries without a superseding ADR.

## Alternatives considered

- **Joi / Yup** — rejected; zod is already in Phase 01 and matches solution packages.
- **Hand-rolled checks only** — rejected for complex nested bodies and shared schemas.
- **Putting every tunable in env “for flexibility”** — rejected under D13.

## Escape hatch

Supersede if another schema library is required for a documented interoperability reason;
migrate schemas in one deliberate change.
