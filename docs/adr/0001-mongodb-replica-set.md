# ADR 0001 — MongoDB 8 replica set as the datastore

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (plan README §2)

## Context

The platform needs a single primary datastore for domain documents, jobs, audit, and
conversation state, with multi-document transactions available for admin mutations that
must stay consistent. Plan decision **D5** requires an external MongoDB 8 replica set
supplied by connection string; Atlas is not required. Phase 01 already connects via
`MONGODB_URI`.

## Decision

- **MongoDB 8+** (latest 8.x) is the datastore for the API and worker.
- Operators supply a **replica-set** URI through `MONGODB_URI` (env only).
- Multi-document **transactions are allowed** where consistency requires them.
- **MongoDB Atlas is not required**; local or self-hosted replica sets are fine.
- Driver pool sizes and related tunables are named constants, not env vars (D13).

**Timing:** Retrospective for the Phase 01 connection; domain collections follow later
phases.

## Consequences

- One operational dependency for persistence and the job queue (see ADR 0004).
- Tests share the same replica-set topology with a separate database name (ADR 0009).
- Atlas-specific features must not be assumed in application code.

## Alternatives considered

- **Standalone MongoDB (no replica set)** — rejected; transactions and the planned claim
  pattern need a replica set.
- **PostgreSQL / another RDBMS** — rejected for this slice; solution.md and architecture
  already center on Mongo documents + GridFS.
- **Atlas-only** — rejected; D5 explicitly allows non-Atlas deployments.

## Escape hatch

If the datastore cannot meet scale or operational needs, supersede with a new ADR that
names the replacement engine and migration path. Changing a tunable (pool size) does not
require a new ADR.
