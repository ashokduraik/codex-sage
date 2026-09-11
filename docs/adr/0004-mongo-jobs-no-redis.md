# ADR 0004 — Jobs in MongoDB, no Redis/BullMQ

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (plan README §2)

## Context

Ingest, sync, and other heavy work must not block HTTP handlers. The platform needs a
durable job queue the API can enqueue into and a worker can claim, with crash recovery via
heartbeats (solution.md §7; architecture §2). Adding Redis would be a second stateful
dependency for MVP.

## Decision

- Background work uses a **MongoDB `jobs` collection** (plus related job events).
- Workers **claim** work with an atomic update such as `findOneAndUpdate` (lease + status).
- **No Redis, BullMQ, or other broker** in this slice.
- The API and worker share MongoDB only; they do not call each other over HTTP for jobs.

**Timing:** Intent for **Phases 20–22** (job models, worker process, job control). Stack
choice is Accepted now so later PRs do not re-litigate Redis vs Mongo.

## Consequences

- Operational surface stays Mongo-centric (same replica set as domain data).
- Job semantics (states, sweeper, per-project serialization) live in application code, not
  a broker product.
- Throughput and polling intervals are named constants when implemented, not env knobs
  for tunables (D13).

## Alternatives considered

- **Redis + BullMQ** — rejected for MVP complexity and an extra dependency.
- **In-process only (no durable queue)** — rejected; crash recovery and multi-process
  deploy require durable jobs.
- **Cloud task queues** — out of plan scope (deployment/vendor); not assumed.

## Escape hatch

If Mongo-backed jobs cannot meet latency or scale, supersede with an ADR that introduces
a broker and a migration for in-flight jobs.
