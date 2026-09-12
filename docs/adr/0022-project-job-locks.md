# ADR 0022 — Per-project job serialization via lease-based lock collection

- Status: Accepted
- Date: 2026-09-12
- Deciders: product owner (Phase 21)

## Context

Backend requirements §93 and §94 require that only one knowledge or sync writer runs
per project at a time, so ingest / reingest / `repo_sync` do not race on the same
workspace. Jobs live in MongoDB (ADR 0004); there is no Redis lock service. A single
`findOneAndUpdate` on a job document cannot serialize *across* jobs.

## Decision

- Introduce a dedicated **`project_job_locks`** collection with one live row per
  `(orgId, projectId, lockScope)` while `status: 'A'`.
- Handlers with `exclusiveScope: 'project'` acquire the lock after claim and before
  run. Failure to acquire is **not** a job failure: the job returns to `pending` with
  a short `scheduledAt` delay and a `job.project_busy_requeued` event.
- Lock `expiresAt` is refreshed on the same heartbeat as the job lease (Mongo `$$NOW`),
  so a crashed holder cannot block a project forever.
- MVP uses a single scope `project_writer` for all exclusive writers. A second scope
  may be added later (e.g. document-only work) without changing the acquire API.
- This job-level gate is **separate** from the CodeGraph filesystem writer lock
  (Phase 27), which wraps the actual index calls inside the handler.

## Consequences

- Cross-host clock skew is mitigated by writing and comparing lease/lock expiry with
  Mongo server time (`$$NOW`).
- TTL must stay well above the heartbeat interval (asserted in worker constants).
- Busy projects produce deterministic queueing via `scheduledAt`, not spinning retries.

## Alternatives considered

- **Single-worker deployment only** — rejected; production may run multiple worker
  processes.
- **Flag on the project document** — rejected; unique partial index + expiry takeover
  is clearer and avoids racing project updates with lifecycle fields.
- **Redis / distributed lock product** — rejected for MVP (ADR 0004).

## Escape hatch

If lock contention or TTL tuning becomes operationally painful, supersede with an ADR
that introduces a shared lock service or moves exclusivity into a broker with
per-project concurrency limits.
