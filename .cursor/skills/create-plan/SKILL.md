---
name: create-plan
description: >-
  Creates implementation and phase plans for codex-sage. Use whenever planning
  code changes, rewriting docs/plan/phase-*.md, or calling CreatePlan — before
  writing the plan. Requires product-language schema tables when Mongo is involved.
---

# Create plan (codex-sage)

## When to use

Read and follow this skill **before** any of:

- Calling CreatePlan / writing a Cursor plan
- Rewriting or filling a `docs/plan/phase-*.md` for implementation
- Planning a multi-file feature that may touch models, modules, or ADRs

## Steps

1. **Inspect reality** — current folder layout under `backend/src/modules/` (only
   `access`, `masters`, `knowledge`, `conversation`), relevant rules, and existing
   public exports. Do not invent a fifth domain module (e.g. `modules/chat/`).
2. **Lock decisions** — every open product choice gets one concrete choice in the
   plan. No Option A/B, TBD, or “prefer X if Y” left for the implementer.
3. **Schema (hard)** — if any new/changed Mongo collection, field, or index is
   needed, include a **Schema changes** section (template below). Do not bury
   fields in prose. State that **model code waits for explicit user approval** of
   that exact list (`schema-change-approval.mdc`). Approving “the plan” or
   “go implement” is not schema approval.
4. **Paths** — place backend work in the correct conversation/access/masters/knowledge
   resource file; overflow only via `*.helper.js` / `*.util.js` after 1000 code lines.
5. **Docs** — list every doc/ADR/phase-doc path that must change with the code.
6. **Tests** — name the public surfaces and unhappy paths to cover (≥80% line/branch).

## Schema changes section (required when Mongo is involved)

Use product language. Explain **why the collection exists**, then every field.

```markdown
## Schema changes (needs explicit user approval before model code)

**Collection purpose:** one or two sentences — what product problem this storage solves.
Not jargon (“LangGraph saver”) without the user-facing why.

**Collection / model:** `collectionName` / `ModelName`

| Field       | Type | Required | Purpose (why it exists) |
| ----------- | ---- | -------- | ----------------------- |
| `fieldName` | type | yes/no   | Concrete product reason |

**Indexes:** list each index and why (resume lookup, uniqueness, tenant list, …).

**Out of scope for this collection:** what this store is _not_ (so readers do not
confuse it with sibling collections).

**Approval gate:** do not write `backend/src/models/*.model.js` or edit schema
fields until the user says yes to this exact list in the current conversation.
```

## Plan quality bar

- Prefer bullets over long preamble.
- Cite real file paths that exist or will exist under the four modules.
- Call out dependency installs with `dependency-versions.mdc` (no version pins in phase docs).
- Never propose storing secrets, tokens, or private model reasoning / chain-of-thought.
- Align with `file-colocation.mdc`, `function-design.mdc`, `comments-required.mdc`,
  `no-assumptions.mdc`, and `schema-change-approval.mdc`.

## Anti-patterns

- Opaque names (`chatCheckpoints`) with no “what / why / field purposes”
- `thinkingMode: 'disabled' | 'bounded'`-style APIs without plain-language meaning
- Deep `graph/nodes/*.js` trees or a new `modules/chat/` package
- Leaving resume/threadId/collection choices open for “implement time”
