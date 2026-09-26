# Phase 05 — CodeGraph and preview-cap evaluation

Recorded **2026-09-26T10:23:31.646Z** on this machine (darwin, Node 26). Command:

```bash
node docs/evaluation/run-phase-05-codegraph.mjs
```

D4: trees are this product’s own fixtures and `backend/src`. No customer code.

## Fixture (`backend/tests/fixtures/codegraph`)

Four files: `src/main.js`, `src/greet.js`, `lib/run.cjs`, `lib/greet.cjs`.

| Metric | Value |
|---|---|
| `indexAll` duration | 116 ms |
| SQLite size (`.codegraph/codegraph.db`) | 163 840 bytes (160 KiB) |
| Peak RSS during run | 293 797 888 bytes (~280 MiB) |
| Baseline RSS before index | 110 886 912 bytes |
| Files indexed | 4 |
| Files skipped | 0 |
| Files errored | 0 |
| Success | true |

`kindForSourcePath('lib/run.cjs')` is **`code`**. `ACCEPTED_CODE_EXTENSIONS` already includes
`.cjs` with `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`. The indexer accepted both `.cjs` files
(4/4, zero skips).

## Node + Mongo application tree (`backend/src` copy)

This backend is a Node + Mongoose application (Fastify, workers, Mongo models). Copied
without `node_modules` / `.codegraph`.

| Metric | Value |
|---|---|
| `indexAll` duration | 262 ms |
| SQLite size | 6 553 600 bytes (6.25 MiB) |
| Peak RSS during run | 353 910 784 bytes (~338 MiB) |
| Baseline RSS before this index | 293 732 352 bytes |
| Files indexed | 87 |
| Files skipped | 0 |
| Files errored | 0 |
| Success | true |

A ~100-file Node + Mongo tree indexes in well under a second and stays under ~350 MiB RSS
in this process (including Node and the library). A 2M-LOC soak is still later.

## Preview caps

`SOURCE_PREVIEW_MAX_BYTES = 65_536` and `SOURCE_PREVIEW_MAX_LINES = 400` stay. A 64 KiB
slice is enough to inspect a function or section; this tree’s production modules are
capped at 1000 code lines and are routinely larger than one slice, which is the point of
the preview API. No evidence from this run that the cap should rise or fall.

## Recommendations

- Keep `.cjs` in `ACCEPTED_CODE_EXTENSIONS`.
- Keep `SOURCE_PREVIEW_MAX_BYTES` at 65 536 and `SOURCE_PREVIEW_MAX_LINES` at 400.
- Do not invent RAM or duration env tunables from this sample.
- Tokenizer / 2M-LOC numbers remain pending the LLM persist path.
