# Phase 23 — Upload validation & path-exclusion engine

- **Layer:** BE
- **Depends on:** Phase 12 (rate-limit class `upload`, `Idempotency-Key` on the later persist
  route), Phase 17 (project exists, `sources.upload` permission will be enforced on 24)
- **Unblocks:** Phase 24 (persistence calls this engine), Phase 25 S0/S2 (replay recorded
  rules)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §10, §14–§16; `backend/solution.md`
  §4.1–§4.2; `docs/architecture.md` §5; frontend §15–§19 (contract only)

## 1. Goal

After this phase the backend can decide, **without writing GridFS**, whether an upload is
acceptable: zip integrity, zip-slip, allowlisted kinds, and path exclusions (`node_modules`,
`.git`, `dist`, `build`, `coverage`, images, and the rest of the ignore set). Files over
1 MiB are accepted as source but marked `excludedFromGraph`. If nothing usable remains after
exclusions, the result is `user_action_required` (HTTP `400` once Phase 24 mounts the route).

You can see it working in unit tests: a zip with `src/a.js` and `node_modules/x.js` yields
one accepted path and one excluded path; a zip with only `node_modules` yields empty-after-
exclude; `../etc/passwd` is zip-slip and fails closed.

## 2. Why this phase is here

Architecture §5 and solution §4.2 require skipping junk **before** GridFS. If Phase 24
streams bytes and validates in the same change, the PR mixes crypto-sized IO with a pure
policy engine and is hard to test. Splitting the engine first means 24 can stream with a
tested `shouldAccept(path, size, kind)` and 25 S2 can apply the **same** rules recorded on
the version.

It follows Phase 12 because the upload route (24) needs a rate class from day one; this
phase itself adds no HTTP. It follows Phase 17 so the later route has a project to attach
to. It does not need Phase 20 — no job is created here.

## 3. Scope

### In scope

- Pure exclusion + validation library used by the API (24) and the worker (25).
- Zip integrity (central directory readable, not truncated) and zip-slip (`..`, absolute
  paths, backslash tricks, oversized entries).
- Ignore prefixes/suffixes: `node_modules/`, `.git/`, `dist/`, `build/`, `coverage/`, plus
  common junk (`.DS_Store`, `*.min.js` — only if listed in the constant set, not guessed).
- Images skipped entirely (solution §4.1; README §5).
- Allowlist of code/config/doc extensions from solution §4.1.
- Files `> 1 MiB`: accepted for storage, `excludedFromGraph: true`, reason `file_too_large`.
- Empty-after-exclude outcome: no accepted paths → fail closed with a stable code.
- Recording the **rule set version** so S2 replays what the upload used.

### Out of scope (owner phase)

- Reading the HTTP body, GridFS, `SourceVersion` / `SourceFile`, enqueue job — **Phase 24**.
- Worker S0/S1/S2 execution — **Phase 25**.
- Client-side pre-filter — nice-to-have in Phase 33; **server still enforces**.
- Repository tree exclusions — **Phase 32** reuses this engine on listed paths.

## 4. Design

### 4.1 Module layout

`backend/src/modules/sources/exclusions/` (or `platform/ingest/exclusions/` if sources
module does not exist yet). Public surface:

```text
evaluateUploadEntry({ path, uncompressedSize, contentTypeHint? })
  → { decision: 'accept' | 'accept_excluded_from_graph' | 'skip', reasonCode? }

inspectZip(streamOrBuffer)  // metadata only: paths + sizes; no file bytes kept
  → { entries: [...], integrity: 'ok' } | throws classified error

summarizeInspection(entries)
  → { accepted, skipped, excludedFromGraph, emptyAfterExclude }
```

`inspectZip` must **not** write GridFS. For large archives, prefer iterating the zip
central directory / entry headers without buffering the whole file in memory — if the
library cannot, cap `UPLOAD_MAX_ARCHIVE_BYTES` and fail `user_action_required`.

### 4.2 Zip-slip and integrity

Reject (permanent / `user_action_required`, code `SOURCE_ZIP_SLIP` or
`SOURCE_ZIP_INTEGRITY`):

- Paths containing `..` after normalization, absolute paths, Windows drive prefixes.
- Duplicate path entries that would collide after normalization.
- Encryption / unsupported compression if the chosen zip library cannot safely decode.
- Truncated archive, bad CRC when the library exposes it at list time.

Do not follow zip comments as paths. Normalize `\` to `/` before matching.

### 4.3 Skip vs exclude-from-graph

| Decision | GridFS in Phase 24? | Graph later? | Example |
|---|---|---|---|
| `skip` | **No** | No | `node_modules/`, `.git/`, images, `dist/` |
| `accept_excluded_from_graph` | Yes | No | `.ts` file > 1 MiB |
| `accept` | Yes | Yes (if language supported) | `src/app.js` |

Skipped paths are counted for the job event "Exclusions applied (N paths)" but their
bytes never land in GridFS (solution §4.2).

### 4.4 Empty after exclude

If `accepted + accept_excluded_from_graph === 0`, result code
`SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS`, retryability `user_action_required`. Phase 24
maps this to HTTP 400 and **does not** create `SourceVersion` or a job (solution §4.6 S0
row: often no version committed).

### 4.5 Rule set identity

Export `EXCLUSION_RULESET_ID` (string constant, e.g. `'exclusions.v1'`). Phase 24 stores it
on `SourceVersion`. Phase 25 S2 uses the **recorded** id, not "whatever is in code now",
when replaying — if the id is unknown, fail `permanent` rather than silently applying new
rules (see §12).

### 4.6 Error mapping

Use Phase 02 classes: `source` + `user_action_required` for slip, integrity, empty, too
large archive. Do not put archive bytes or full path lists in logs; log counts and codes
(backend §148).

## 5. Data model changes

**None.** This phase is a library. Phase 24 persists `exclusionRulesetId` and per-file
reasons.

## 6. API contract — PROPOSED (needs approval before implementation)

**No HTTP in this phase.** Internal result object (PROPOSED):

```json
{
  "rulesetId": "exclusions.v1",
  "accepted": [{ "path": "src/a.js", "size": 1200, "excludedFromGraph": false }],
  "skipped": [{ "path": "node_modules/x.js", "reasonCode": "ignored_directory" }],
  "emptyAfterExclude": false
}
```

Phase 24 is the HTTP owner. Rate class `upload` and `Idempotency-Key` apply there, not
here.

## 7. Configuration & environment variables

**None.**

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `EXCLUSION_RULESET_ID` | `'exclusions.v1'` | `exclusions/exclusions.constants.js` | Recorded on the version |
| `GRAPH_FILE_MAX_BYTES` | `1048576` | same | 1 MiB graph cap (solution §4.1) |
| `UPLOAD_MAX_ARCHIVE_BYTES` | `524288000` | same | 500 MiB archive ceiling (proposed) |
| `IGNORED_PATH_PREFIXES` | `['node_modules/', '.git/', 'dist/', 'build/', 'coverage/']` | same | Skip before GridFS |
| `IGNORED_IMAGE_EXTENSIONS` | `['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg']` | same | Skip images |
| `ACCEPTED_CODE_EXTENSIONS` | from solution §4.1 | same | `.js` `.ts` `.mjs` `.cjs` + documented CodeGraph set — **do not invent languages**; use the list already in solution.md, mark others skip |

If the CodeGraph language list is still "supported languages TBD" after Phase 05, this
phase ships the JS/TS set in §4.1 plus docs (`.md`, `.mdx`, `.txt`) and allowlisted
configs, and leaves additional languages to a follow-up constant change — not env.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/sources/exclusions/exclusions.constants.js` | **New** |
| `backend/src/modules/sources/exclusions/pathDecision.js` | **New:** per-entry decision |
| `backend/src/modules/sources/exclusions/zipInspect.js` | **New:** integrity + slip + list |
| `backend/src/modules/sources/exclusions/index.js` | **New:** public surface |
| colocated `*.test.js` | **New:** fixtures under `exclusions/fixtures/` |
| `backend/package.json` | Add a zip reader only after `dependency-versions.mdc` checks; if no maintained library passes, stop and ask (do not invent a parser) |

## 9. Tests (≥ 80% line and branch)

### Unit (fixtures, no Mongo)

- `src/a.js` accepted; `node_modules/pkg/index.js` skipped; `.git/HEAD` skipped.
- `photo.png` skipped (image).
- `huge.ts` at 1 MiB + 1 byte → `accept_excluded_from_graph` / `file_too_large`.
- Zip-slip `../secret` and `/abs/path` fail.
- Empty zip and zip of only ignored paths → `emptyAfterExclude`.
- Path normalization: `src\\a.ts` treated as `src/a.js`.
- Duplicate normalized paths fail closed.

### Unhappy paths

- Truncated zip → integrity error, no partial accept list treated as success.
- Oversize archive → `user_action_required`, no attempt to list millions of entries beyond
  a constant cap (`UPLOAD_MAX_ENTRY_COUNT` if needed — constant, not env).

## 10. Definition of Done

- [ ] No GridFS write and no HTTP route in this phase.
- [ ] Skip vs store-but-exclude-from-graph is tested.
- [ ] Zip-slip and integrity fail closed.
- [ ] Empty-after-exclude is a classified `user_action_required` code.
- [ ] `EXCLUSION_RULESET_ID` is exported for Phase 24 to persist.
- [ ] No new `.env` keys.
- [ ] Zip library (if any) passed pre-install checks or the user was asked.
- [ ] `npm run lint` and `npm test` pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- `docs/architecture.md` §5: confirm skip-before-GridFS matches the engine's decisions.
- No ADR unless the zip library choice is non-obvious (then one ADR for the library).

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Archive size cap (500 MiB).** Confirm or name another constant.
2. **Additional ignore paths** (`.svn/`, `.hg/`, `target/`, `__pycache__/`, `.next/`).
   Proposed: start with solution §4.2's list only; do not grow it silently.
3. **`.svg` as image.** Proposed: skip (images out of scope). Confirm — some repos use SVG
   as source assets for docs.
4. **S2 replay:** if `EXCLUSION_RULESET_ID` on the version is older than code, fail or
   apply current rules? Proposed: fail `permanent` until a migration/replay tool exists.
5. **Zip library.** Must pass `dependency-versions.mdc`. If the obvious candidate fails
   maintenance checks, **stop and ask** — do not vendor an abandoned parser.
