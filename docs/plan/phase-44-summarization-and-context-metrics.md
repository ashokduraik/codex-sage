# Phase 44 — Summarization, pinned facts & context metrics

- **Layer:** BE
- **Depends on:** Phase 43 (context budgeter & tokenizer parity)
- **Unblocks:** Phase 47 (LangGraph `loadContextNode` binds this loader)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §42 (conversation context), §43–§44
  (management + limit exposure), §58–§59 (follow-up uses this context; context portion only),
  §140–§143 (conversation isolation); `frontend/requirments.md` §36–§38 (capacity, warnings,
  omit unavailable metrics); `backend/solution.md` §1.2 step 2 (persisted summary), §5.1 step 2
  (load from Mongo); `docs/architecture.md` §6.1 step 7

## 1. Goal

After this phase each conversation can carry a **persisted rolling summary** and **pinned facts**
(clarifications and user corrections), and assistant messages can store **context accounting
metrics** that Phase 43 actually measured — never guessed. A loader assembles
`summary + pinned + recent turns` as segments for `prepareModelInput`. GET messages already
forwards `contextMetrics` when present; this phase adds `GET .../context` for UI warnings
(frontend §37–§38: omit unavailable values).

You can see it working by running an extractive summary after a `replace_with_summary` compaction
in tests, pinning a fact, loading context for a fake run, and confirming GET messages and GET
`.../context` include metrics only when the budgeter returned numbers.

## 2. Why this phase is here

Phase 43 compacts prompts but does not persist summary text, pins, or user-visible metrics.
Requirements §43 require replacing older turns with a summary **before** the hard limit, and §44
require recording validated limits and measured input for each model call.

Architecture §6.1 step 7 is the API loading Mongo context (recent turns, summary, pinned facts)
before LangGraph starts. Phase 47’s load node (or Phase 50 building `runContext`) **imports**
`buildConversationContext` from the conversation barrel — this phase does not invent a fifth
`modules/chat/` tree. Phase 50 does not own the loader.

The writer is **extractive** until Phase 45 can offer `generateText({ purpose: 'summarize' })`.
Do not call the LLM from this phase.

## 3. Scope

### In scope

- **`context` subdocument on `conversations`** (PROPOSED — approve fields before editing the
  model): `summaryText`, `summaryUpdatedAt`, `summaryCoversThroughMessageId`, `pinnedFacts[]`.
- **`pinnedFacts` entry:** `{ id, text, source: 'clarification' | 'user_correction', messageId?, createdAt }`.
- **Write `Message.contextMetrics`** (field already exists as Mixed/null). Persist only when
  Phase 43 accounting succeeded. Shape matches `prepareModelInput` output plus one derived ratio:

```text
validatedContextCapacity, measuredInputTokens, maximumInputBudget,
reservedOutputTokens, contextPercentUsed, compactionActions[]
```

- Service **`buildConversationContext(orgId, projectId, conversationId, options)`** returning
  segments for `prepareModelInput`.
- Service **`updateConversationSummary(...)`** — **extractive** writer. Invoked when Phase 43
  returns `replace_with_summary`, before the next model call.
- Internal **`pinFact(...)`** / **`unpinFact(...)`**. No HTTP pin in MVP. Phase 52 calls the
  barrel later with `source: 'clarification'`.
- **`GET /projects/:projectId/conversations/:conversationId/context`** — `chat.ask`. Read-only
  view for frontend §37 warnings.
- Enforce: conversation content never writes to project knowledge collections (§142–§143).

### Out of scope (owner phase)

- LLM `generateText` for summaries — **Phase 45**.
- LangGraph checkpointing and `loadContextNode` — **Phase 47** (imports this barrel).
- SSE `done` payload — **Phase 50 / 55**. This phase persists fields; it does not stream them.
- Provider-reported token usage — **Phase 45** writes existing `Message.usage`. Do not add
  `providerUsage`.
- Token usage rollups for org billing — **Phase 59**.
- Tool-round / wall-time run budgets — **Phase 48**.
- HTTP pin/unpin — **not in MVP** (Phase 52 uses the internal API).
- Proactive summary refresh by ratio — **not in this phase** (Phase 05 never locked a number).

## 4. Design

### 4.1 Placement

`backend/src/platform/` is infra only (`.cursor/rules/platform-layer.mdc`). Summary, pins, and
metrics are conversation domain. One production file — do not split loader / summary / pins /
metrics into separate files (`file-colocation.mdc`).

```text
backend/src/modules/conversation/conversationContext.js
backend/src/modules/conversation/index.js
backend/tests/modules/conversation/conversationContext.test.js
backend/src/models/conversations.model.js
backend/src/models/messages.model.js
```

[`conversation.js`](../../backend/src/modules/conversation/conversation.js) is already near the
1000-line cap. Do not grow it with loader/summary/pin logic. Register the GET `.../context`
route from `conversationContext.js` (handler owns `reply`) and mount that plugin from
`conversationRoutes` or the barrel — one extra registration only.

Overflow is `conversationContext.helper.js` only after 1000 code lines.

### 4.2 When summary updates run

One production trigger: **compaction hook**. When `prepareModelInput` returns an action
`replace_with_summary`, call `updateConversationSummary` with the covered turn ids and refresh
extractive text **before** the next model call.

Summary must exist **before** older turns drop out of the prompt (backend §43). Phase 43
already inserts the caller-supplied `summarySegment` on that action; this phase is the
persisted source of that text.

**No proactive threshold.** `docs/evaluation/` has no `SUMMARY_REFRESH_THRESHOLD_RATIO`. Phase 05
deferred tokenizer/context lock to Phase 43 and never defined a refresh ratio. Do not invent one.

### 4.3 Extractive writer (locked)

Concatenate, in turn order: user questions, abstain markers, and clarification texts covered
through `throughMessageId`. Truncate to `SUMMARY_TEXT_MAX_CHARS` rather than fail the run.

Logs and audit must **not** imply semantic understanding (no “the model summarized…”).

LLM mode waits for Phase 45. This phase does not call `generateText`.

### 4.4 Pinned facts

Pinned facts are always protected segments (`kind: 'pinned_fact'`) for Phase 43. Sources:

- Phase 52 later calls `pinFact` with `source: 'clarification'`.
- `source: 'user_correction'` exists for a future “remember this”; **no HTTP in MVP**.

Max pins: `PINNED_FACTS_MAX_COUNT` (`20`). Reject a duplicate `id`. Soft-deleted conversations
are not writable.

### 4.5 Context metrics honesty

Rules (plan README §4 grounding + backend §44):

- Persist Phase 43 names: `validatedContextCapacity`, `measuredInputTokens`,
  `maximumInputBudget`, `reservedOutputTokens`, `compactionActions[]`.
- `contextPercentUsed = measuredInputTokens / maximumInputBudget` (0–1) only when both
  numbers exist. Omit the key when the denominator is missing.
- Persist on the **assistant message that followed the compaction**. The budgeter runs before
  that row exists; Phase 49/50 attach the object when the assistant row is written. Unit tests
  may call `persistMessageContextMetrics` directly.
- If Phase 43 failed, **do not start** the model call (§44) — do not write a partial metrics
  object.
- UI-facing GET omits keys when null (frontend §38). `mapMessageToDto` already does this.
- Do not write `Message.usage` here. Phase 45 fills it from the provider. Do not add
  `providerUsage`.

Phase 57 currently sketches `contextMetrics.percentUsed` as an integer `82` plus
`compactionApplied`. That mapping is a **Phase 57 follow-up** — this phase does not invent a
second vocabulary. 57 should read `contextPercentUsed` (0–1) from this object.

### 4.6 Loader flow

```text
buildConversationContext(orgId, projectId, conversationId, options):
  load conversation + context.summary* + context.pinnedFacts (status A)
  load recent messages via existing listRecentMessages
    newest-first until options.budgetHint or RECENT_TURNS_MAX_COUNT
  build segments[] for prepareModelInput
    (summary → kind: 'summary'; pins → kind: 'pinned_fact', protected;
     turns → kind: 'turn')
  return { segments, summarySegment, pinnedSegments, recentMessageIds }
```

Does not call CodeGraph or load repository files (architecture §6.1). Soft-deleted or
cross-tenant conversation → `404` (`NOT_FOUND`), same as other conversation reads.

## 5. Data model changes

Schema fields are **PROPOSED**. Do not edit models until the user approves this exact list in
the implementation conversation (`schema-change-approval.mdc`). A phase doc is not approval.

### Additive on `conversations` (`backend/src/models/conversations.model.js`)

| Field | Type | Notes |
|---|---|---|
| `context.summaryText` | string | default `''` |
| `context.summaryUpdatedAt` | Date \| null | |
| `context.summaryCoversThroughMessageId` | ObjectId → Message \| null | |
| `context.pinnedFacts` | array | see §4.4 |

Pinned fact subdocument: `{ id, text, source: 'clarification' \| 'user_correction', messageId?, createdAt }`.

No new indexes. Do not query by `summaryUpdatedAt` in this phase.

### `messages` (`backend/src/models/messages.model.js`) — no new field

`contextMetrics` already exists (Mixed, default `null`). This phase **writes** the Phase 43
shape when accounting succeeded and **fixes the field comment** (it is shown to Alice — FE §38 /
Phase 57). Keep Mixed unless a typed subdocument is approved in the implementation conversation.

`usage` already exists. Phase 45 writes it. Do not add `providerUsage`.

Update `docs/data-model.md` in the **same** implementation change as the schema edit.

## 6. API contract — PROPOSED (needs approval before implementation)

### Extended `GET .../messages` item (existing Phase 41 route)

`mapMessageToDto` already forwards `contextMetrics` and `usage` when non-null. After this phase
an assistant row that was measured looks like:

```json
{
  "id": "6650f1a2c3d4e5f6010203bb",
  "role": "assistant",
  "content": "...",
  "messageStatus": "completed",
  "contextMetrics": {
    "validatedContextCapacity": 131072,
    "measuredInputTokens": 0,
    "maximumInputBudget": 0,
    "reservedOutputTokens": 457,
    "contextPercentUsed": 0.82,
    "compactionActions": [
      { "action": "replace_with_summary", "segmentId": "turn1", "beforeTokens": 400, "afterTokens": 120 }
    ]
  },
  "createdAt": "2026-09-12T12:00:00.000Z"
}
```

Omit `contextMetrics` / `usage` when unavailable. Do not emit `providerUsage`.

### `GET /projects/:projectId/conversations/:conversationId/context` — `chat.ask`

Read-only view for UI context warnings (frontend §37). **No fabricated percentages.**

| | |
|---|---|
| Method | `GET` |
| Path | `/api/v1/projects/:projectId/conversations/:conversationId/context` |
| Permission | `chat.ask` + project membership (same pre-handler as GET messages) |
| Errors | `404 NOT_FOUND` (missing, soft-deleted, or cross-tenant); `403` when permission missing |

```json
{
  "summaryPresent": true,
  "summaryUpdatedAt": "2026-09-12T11:30:00.000Z",
  "pinnedFactCount": 2,
  "lastRunMetrics": {
    "contextPercentUsed": 0.82,
    "measuredInputTokens": 0,
    "maximumInputBudget": 0
  }
}
```

`lastRunMetrics` is copied from the latest assistant message that has `contextMetrics`, or
**omitted entirely**. Omit `contextPercentUsed` inside it when the denominator was missing.
Omit `summaryUpdatedAt` when no summary has been written.

### Internal (exported from `conversation/index.js`)

```text
buildConversationContext(orgId, projectId, conversationId, options)
  → { segments, summarySegment, pinnedSegments, recentMessageIds }

updateConversationSummary(orgId, projectId, conversationId, { throughMessageId })
  → void   // extractive

pinFact(orgId, projectId, conversationId, fact) → void
unpinFact(orgId, projectId, conversationId, factId) → void
persistMessageContextMetrics(messageId, prepareModelInputOutput) → void
```

Phase 47 imports `buildConversationContext` from the conversation barrel. Phase 52 imports
`pinFact`. No deep imports into `conversationContext.js`.

## 7. Configuration & environment variables

**None.**

### Constants (not env)

Named constants on `conversationContext.js`. Create each only when the code reads it.

| Constant | Value | Purpose |
|---|---|---|
| `PINNED_FACTS_MAX_COUNT` | `20` | Cap pins |
| `RECENT_TURNS_MAX_COUNT` | `50` | Loader safety cap before the budgeter |
| `SUMMARY_TEXT_MAX_CHARS` | `4000` | Truncate extractive output; do not fail the run |

Do **not** add `SUMMARY_REFRESH_THRESHOLD_RATIO`.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/conversation/conversationContext.js` | Loader, extractive summary, pin/unpin, persist metrics, GET context (handler owns `reply`) |
| `backend/src/modules/conversation/index.js` | Export the four functions (+ mount GET if not registered from `conversation.js`) |
| `backend/src/modules/conversation/conversation.js` | One extra route registration only, if that stays under the 1000-line cap |
| `backend/src/models/conversations.model.js` | `context` subdocument **after field-list approval** |
| `backend/src/models/messages.model.js` | Comment + documented `contextMetrics` shape; no new field |
| `backend/tests/modules/conversation/conversationContext.test.js` | Unit + HTTP GET context / message metrics |
| `docs/data-model.md` | Conversation `context` + message metrics shape (same change as the schema) |
| `docs/architecture.md` | §6.1 step 7 names `buildConversationContext` |

Do not create `conversationContext.loader.js`, `.summary.js`, `.pins.js`, or `.metrics.js`.
Do not put models under `modules/`. Do not put tests next to `src/`.

## 9. Tests (≥ 80% line and branch)

### Unit

- Loader builds segments with summary + pins + recent turns ordering; pins are `protected`.
- Extractive writer is deterministic from fixture turns; output truncated at
  `SUMMARY_TEXT_MAX_CHARS`.
- Compaction hook: `replace_with_summary` updates `summaryCoversThroughMessageId` before the
  next `prepareModelInput`.
- Metrics persistence: writes only when budgeter output includes counts; omits the object on
  accounting failure.
- `contextPercentUsed` not written when `maximumInputBudget` is missing.
- Pin max enforced; duplicate pin id rejected.

### Integration

- GET messages returns metrics on an assistant row after the test hook persists them; user
  rows omit the key.
- GET `.../context` omits `lastRunMetrics` when no assistant metrics exist; omits
  `contextPercentUsed` when the denominator is missing.
- Summary + messages remain when project knowledge updates (no writes to knowledge collections).

### Unhappy paths

- Load context / GET `.../context` for a soft-deleted conversation → `404`.
- Cross-tenant conversation id → `404`.

## 10. Definition of Done

- [ ] `context` stored on the conversation (after schema approval); pins capped; extractive
      summary refreshed on `replace_with_summary`.
- [ ] `contextMetrics` written on the following assistant message only when Phase 43 measured.
- [ ] `buildConversationContext` exported from `conversation/index.js` for Phase 47.
- [ ] Extractive-only — no LLM calls from this phase.
- [ ] No `providerUsage` field; no fabricated token counts or percentages.
- [ ] GET messages and GET `.../context` omit unavailable metric fields (frontend §38).
- [ ] Coverage ≥ 80% line and branch on new/changed files.

## 11. Documentation & ADR updates

- `docs/architecture.md` §6.1 step 7: name `buildConversationContext` (conversation barrel).
- `docs/data-model.md`: conversation `context` and the `contextMetrics` object shape, in the
  same change as the schema.
- Phase 57 follow-up (not this PR): map UI `percentUsed` from `contextPercentUsed` (0–1). Do
  not ship a second metrics vocabulary here.

No new ADR unless implementation invents a second collection instead of the `context`
subdocument.

## 12. Risks & open questions

Locked in this rewrite (do not re-open without a product change):

1. **Writer** — extractive until Phase 45.
2. **`compactionActions`** — assistant message that followed compaction.
3. **HTTP pin/unpin** — internal only; Phase 52 calls `pinFact`.
4. **`GET .../context`** — in this phase, `chat.ask`.
5. **Proactive threshold** — not in this phase; no invented ratio.
6. **Summary size** — truncate at `SUMMARY_TEXT_MAX_CHARS`.
7. **Metric names** — Phase 43 names + derived `contextPercentUsed` (0–1). Phase 57 maps the
   banner; do not add `percentUsed` / `compactionApplied` here.

Still ask at implementation time:

1. **Schema approval** — exact `context` field list in §5. A phase doc is not approval.
2. **Typed `contextMetrics` vs Mixed** — keep Mixed unless the user approves a subdocument.
3. **`SUMMARY_TEXT_MAX_CHARS = 4000`** — confirm or pick another named constant before coding.
