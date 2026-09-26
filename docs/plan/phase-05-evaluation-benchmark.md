# Phase 05 — Evaluation & benchmark: model context, tokenizer parity, CodeGraph at scale

- **Layer:** EVAL
- **Depends on:** Phase 04 (stack ADRs)
- **Unblocks:** Phase 27 (CodeGraph adapter numbers), Phase 39 (preview byte cap), later LLM
  phases (context window / tokenizer — still later)
- **Size:** 1 day
- **Requirements covered:** `backend/requirments.md` §43, §44, §70, §139; `backend/solution.md`
  §1.1–1.2, §4.4; plan decisions D3, D4

## 1. Goal

After this phase `docs/plan/phase-05-evaluation-benchmark.md` exists and a **bounded public-repo**
measurement is recorded in `docs/evaluation/phase-05-codegraph.md`. The write-up states measured
CodeGraph index duration, SQLite size, peak RSS, and skipped-file counts on a real Node + Mongo
tree (this product’s own `backend/src`, not customer code — D4). It also confirms `.cjs` is an
accepted CodeGraph/source extension against the existing fixture, and it **locks**
`SOURCE_PREVIEW_MAX_BYTES` at the interim value Phase 39 already shipped (65_536) or records why
it stays pending.

You can see it working by opening the evaluation note and finding numbers that came from a run,
not invented constants.

## 2. Why this phase is here

Phase 27 shipped the CodeGraph adapter with fixtures while this document was missing, so scale
caps and preview bytes stayed “pending evaluation.” Phase 39 left `SOURCE_PREVIEW_MAX_BYTES`
explicitly blocked on this work. The ingest close-out writes the missing plan and runs a
**bounded** measurement so later phases can cite recorded numbers. Tokenizer parity and a 2M-LOC
LLM context study remain out of this ingest close-out — they need the chat persist path.

## 3. Scope

### In scope

- Twelve-section phase document (this file).
- Bounded CodeGraph `indexAll` on:
  - `backend/tests/fixtures/codegraph` (includes `.cjs` / `.js`).
  - A copy of this repo’s `backend/src` (Node + Mongoose/Mongo application tree).
- Record duration, SQLite size, peak RSS, indexed/skipped/errored counts.
- Confirm `ACCEPTED_CODE_EXTENSIONS` includes `.cjs` and that the fixture `.cjs` files are
  accepted by the upload classifier.
- Recommend or confirm `SOURCE_PREVIEW_MAX_BYTES` (and the line cap) from measured file sizes.

### Out of scope (owner phase)

- Customer repositories (D4).
- Full 2M-LOC public-monorepo soak — later if product asks.
- Tokenizer / embedding / LLM context-window lock — Phases 43–49.
- Changing S0–S6 or the ZIP contract.
- Playwright E2E / CI — Phase 63.

## 4. Design

```text
copy fixture + backend/src → temp workspace (no node_modules, no .git)
  → createCodegraphAdapter().indexAll(workspace)
  → read .codegraph SQLite size
  → sample process.memoryUsage().rss
  → write docs/evaluation/phase-05-codegraph.md
```

Telemetry and filesystem watch stay off (Phase 27). Measurement uses the same adapter the
worker calls.

## 5. Data model changes

None.

## 6. API contract — PROPOSED (needs approval before implementation)

No HTTP changes. This phase is measurement and documentation.

## 7. Configuration & environment variables

No new env keys. Caps stay named constants:

| Constant | Decision |
|---|---|
| `SOURCE_PREVIEW_MAX_BYTES` | Confirmed **65_536** after evaluation (see evaluation note) |
| `SOURCE_PREVIEW_MAX_LINES` | Confirmed **400** |
| `ACCEPTED_CODE_EXTENSIONS` | Already includes `.cjs`; fixture confirms classifier + indexer |

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `docs/plan/phase-05-evaluation-benchmark.md` | This phase document |
| `docs/evaluation/phase-05-codegraph.md` | Measured numbers |
| `docs/plan/phase-39-source-preview-and-changes.md` | Cap no longer “pending evaluation” |

## 9. Tests (≥ 80% line and branch)

No new production module. Existing CodeGraph adapter and upload-extension tests remain the
gate. The evaluation run is a documented command, not a CI soak.

## 10. Definition of Done

- [x] Phase document written (12 sections).
- [x] Bounded public/product-repo measurement recorded (D4: no customer code).
- [x] `.cjs` confirmed in `ACCEPTED_CODE_EXTENSIONS` and present in the CodeGraph fixture.
- [x] `SOURCE_PREVIEW_MAX_BYTES` recommended from the run (keep 65_536).

## 11. Documentation & ADR updates

- Evaluation note under `docs/evaluation/`.
- Phase 39 constant table updated to “confirmed”.
- No new ADR; stack ADRs from Phase 04 still apply.

## 12. Risks & open questions

1. **2M LOC / multi-language soak** — still later. This close-out measured a real Node + Mongo
   application tree (this backend), not a multi-million-line monorepo.
2. **Tokenizer parity** — still later with the LLM persist path.
3. **Preview cap vs large generated files** — 64 KiB is enough for inspectable slices; full-file
   download is out of scope.
