# ADR 0003 — Mongoose for documents, GridFS for accepted bytes

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (plan README §2)

## Context

Domain entities need schemas, validation, indexes, and soft-delete conventions on MongoDB.
Accepted upload and source bytes need blob storage without introducing a second object
store (solution.md §6; architecture §3). LocalStack S3 was considered and rejected for MVP.

## Decision

- **Mongoose** is the only ODM for domain and platform documents (CRUD, schemas,
  middleware, indexes declared on schemas).
- **GridFS** stores accepted source/documentation bytes (after path/type filtering).
- No second ORM, query builder, or general-purpose object store in this slice.

**Timing:** Mongoose connection is retrospective (Phase 01). GridFS write/read paths are
intent for **Phase 24** (upload persistence) and later ingest stages.

## Consequences

- Repositories and models share one access style and base-schema conventions (Phase 03).
- Large binaries stay out of ordinary documents; metadata references GridFS ids.
- Switching blob storage later is a deliberate superseding ADR, not a quiet dependency.

## Alternatives considered

- **Native MongoDB driver only** — rejected; Mongoose schemas and middleware match the
  planned domain model and soft-delete helpers.
- **S3 / LocalStack for blobs** — rejected for MVP; GridFS keeps one operational system.
- **Prisma or another ORM** — rejected; one ODM only.

## Escape hatch

Supersede if GridFS cannot meet retention/purge or throughput needs, or if a second store
is required for a documented product reason.
