# Phase 04 — Architecture decision records for the chosen stack

- **Layer:** DOC
- **Depends on:** —
- **Unblocks:** Phase 05 (evaluation numbers sit on a locked stack), later phases that
  currently cite "ADR 0002 / 0004" which do not exist yet
- **Size:** 1 day
- **Requirements covered:** `backend/solution.md` §1–§3, §6–§8.3, §13; `docs/architecture.md`
  §2, §9; `.cursor/rules/docs-and-adr.mdc` (if present); plan decisions D3, D5, D13, D14, D16

## 1. Goal

After this phase `docs/adr/` exists and records the stack the codebase already uses or is
about to use: MongoDB 8 replica set, Fastify 5 with `/api/v1`, Mongoose + GridFS, Mongo-backed
jobs (no Redis), Pino, zod, argon2id + JWT, and httpOnly refresh cookies (**D14**). These are
**record-after-the-fact** ADRs for choices Phase 01 already installs (mongoose, zod, Fastify,
Pino) plus the auth/job choices later phases will implement.

You can see it working by opening `docs/adr/README.md` and finding a numbered index; each ADR
has Status, Context, Decision, Consequences, Alternatives, and Escape hatch.

## 2. Why this phase is here

Decision D3: tech choices in `solution.md` are **not** treated as pre-locked until they are
ADRs. Phase 01 already installed part of the stack so the runtime could boot; this phase
writes the paper trail so later phases do not re-litigate Mongo vs something else, or Redis
vs Mongo jobs, in a pull request. It is documentation-only and can run in parallel with
Phases 02 and 03. Phase 05's benchmark then locks *numbers* (context window, tokenizer
parity, CodeGraph at ~2M LOC), not the process topology.

## 3. Scope

### In scope

- `docs/adr/` layout and an index README.
- One ADR per decision below, numbered `0001`… with status **Accepted**.
- Explicit "already installed in Phase 01" vs "will be installed in Phase NN" notes so the
  record is honest.
- Pointers from `docs/architecture.md` and `backend/solution.md` to the ADR numbers.

### Out of scope (owner phase)

- Changing any package version or adding packages — this phase writes markdown only.
- LLM provider, CodeGraph feasibility, tokenizer parity — **Phase 05**.
- Auth implementation — **Phase 07** (this phase records the *intent*; 07 may add a
  follow-up ADR for rotation/reuse if needed).
- Rate-limit numeric values as product policy — **Phase 12** constants; this ADR only
  records `@fastify/rate-limit` as the library.
- Deployment, containers, cloud vendor — README D11, out of the plan.

## 4. Design

### 4.1 ADR shape

Every file is `docs/adr/NNNN-short-kebab-title.md`:

```text
# ADR NNNN — Title
- Status: Accepted
- Date: (date of this phase)
- Deciders: product owner (plan README §2)

## Context
## Decision
## Consequences
## Alternatives considered
## Escape hatch
```

ADRs are immutable once Accepted. A later change **supersedes** with a new number; it does
not edit history. Phase 07's refresh-transport ADR may *reference* 0008 rather than duplicate
D14 if 0008 already records the cookie.

### 4.2 ADR set (this phase)

| # | Title | What it locks | Already in code? |
|---|---|---|---|
| 0001 | MongoDB 8 replica set as the datastore | D5; URI in `.env`; transactions allowed; no Atlas requirement | Connection in Phase 01 |
| 0002 | Fastify 5 and `/api/v1` | HTTP framework; versioned prefix constant, not env | Phase 01 prefix; Fastify already in scaffold |
| 0003 | Mongoose for documents, GridFS for accepted bytes | solution §6; no second ORM | mongoose in Phase 01; GridFS in Phase 24 |
| 0004 | Jobs in MongoDB, no Redis/BullMQ | solution §7; claim via `findOneAndUpdate` | Phase 20–22 |
| 0005 | Pino for structured logs | leveled JSON logs; secrets redacted in Phase 02 | logger already in scaffold |
| 0006 | zod for env and request validation | config schema in Phase 01; route bodies later | zod in Phase 01 |
| 0007 | argon2id passwords and JWT access tokens | solution §8.3 | Phase 07 |
| 0008 | httpOnly refresh cookie + CSRF double-submit | **D14**; `@fastify/cookie`, `@fastify/csrf-protection`; access token in memory | Phase 07 / 13 / 14 |
| 0009 | Integration tests on the external replica set | **D16**; database name `codex_sage_test`; no `mongodb-memory-server` | Phase 03 harness |

Do not add ADRs for page sizes, pool sizes, or TTLs (D13 — those are constants). Do not ADR
the LLM model here.

### 4.3 Honesty about timing

Each ADR states:

- **Accepted as the plan's stack**, even if the implementing phase has not merged.
- If Phase 01 already installed the library, the ADR is retrospective, not a new choice.
- If evaluation (Phase 05) later rejects a *number* (e.g. context window), that does not
  reopen 0001–0009 unless the failure is "this datastore cannot do the job".

## 5. Data model changes

**None.**

## 6. API contract — PROPOSED (needs approval before implementation)

**None.** This phase does not add or change HTTP.

## 7. Configuration & environment variables

**None.** ADRs must not introduce env knobs. They may *name* existing ones (`MONGODB_URI`,
`JWT_ACCESS_TOKEN_SECRET`) as the approved place for secrets.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `docs/adr/README.md` | **New:** index table of ADR numbers, titles, status |
| `docs/adr/0001-mongodb-replica-set.md` | **New** |
| `docs/adr/0002-fastify-api-v1.md` | **New** |
| `docs/adr/0003-mongoose-and-gridfs.md` | **New** |
| `docs/adr/0004-mongo-jobs-no-redis.md` | **New** |
| `docs/adr/0005-pino-logging.md` | **New** |
| `docs/adr/0006-zod-validation.md` | **New** |
| `docs/adr/0007-argon2id-jwt.md` | **New** |
| `docs/adr/0008-httponly-refresh-cookie.md` | **New:** D14 |
| `docs/adr/0009-integration-tests-external-mongo.md` | **New:** D16 |
| `docs/architecture.md` | **Change:** link the ADR index from §2 / §9 |
| `backend/solution.md` | **Change:** replace dangling "ADR 0002 / 0004" mentions with real numbers |
| `docs/plan/README.md` | **No edit** from this phase except if a reviewer requires a pointer (prefer architecture) |

## 9. Tests (≥ 80% line and branch)

No application code. Verification is inspection:

- Every ADR file has the six headings in §4.1.
- Index README lists 0001–0009 as Accepted.
- `solution.md` no longer references ADR numbers that do not exist.
- No ADR invents an env var for a tunable (D13).

There is no coverage gate for markdown.

## 10. Definition of Done

- [ ] `docs/adr/` exists with README + 0001–0009.
- [ ] Each ADR includes Status, Context, Decision, Consequences, Alternatives, Escape hatch.
- [ ] D14 and D16 are written down (0008, 0009), not only in the plan README.
- [ ] Retrospective vs future-install is stated per ADR.
- [ ] `backend/solution.md` citations resolve.
- [ ] No packages installed, no runtime behaviour changed.

## 11. Documentation & ADR updates

This phase *is* the documentation update. Do not duplicate ADR bodies into `solution.md`;
one-line pointers are enough.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **ADR numbering vs historical "0002 / 0004".** Proposed: start at 0001 with the table
   above and update `solution.md` references. Confirm we should not leave gaps to match
   the old dangling numbers.
2. **LLM / CodeGraph ADRs.** Leave entirely to Phase 05, or add a "Deferred" stub now?
   Proposed: leave to 05.
3. **Should 0008 wait for Phase 07?** Proposed: no. D14 is already a plan decision; 07
   implements it and may add a *rotation/reuse* ADR, not a second transport ADR.
