# ADR 0023 — Retry reuses the same Job document; reingest creates a new one

- Status: Accepted
- Date: 2026-09-12
- Deciders: product owner (Phase 22)

## Context

Backend requirements §37 and solution §4.7 distinguish **retry** (same source bytes, recover
from a failed or cancelled run) from **reingest** (same bytes, new job when index rules change)
and **re-upload** (new `sourceVersion`). Processing history (backend §35, frontend §28) should
read as one thread per source version when the user retries. Creating a new Job per retry would
split that history and complicate the Phase 35 processing center.

## Decision

- `POST /api/v1/jobs/:jobId/retry` reuses the **same** `Job` document and `sourceVersionId`.
- Retry mode is resolved server-side (`resume`, `full`, or `not_retryable`) from the stored
  failure class, failed stage, and checkpoint — never from client input.
- `resume` keeps the checkpoint and continues from the failed stage onward.
- `full` clears the checkpoint and re-runs from `validate_upload` against the stored GridFS
  bytes (still the same Job).
- `POST /sources/:sourceVersionId/reingest` (Phase 29) remains the verb that creates a **new**
  Job on the same bytes.

## Consequences

- Failure events stay on the Job; retries append new events so history is inspectable.
- Duplicate clicks are handled by Idempotency-Key replay, an active-job check, and the
  per-project writer lock (ADR 0022).
- Stage labels and event codes defined in Phase 22 are the i18n keys Phase 35 should use.

## Alternatives considered

- **New Job per retry with a parent link** — rejected; splits processing history and forces
  the UI to stitch parent/child chains for a single user action.
- **Always full re-run** — rejected; violates §37 (retry only the failed portion when safe).

## Escape hatch

If a future retention or compliance rule requires immutable failed runs as separate documents,
introduce an explicit archive snapshot collection rather than changing retry to create jobs.
