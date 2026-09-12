# Phase 44 — Summarization, pinned facts & context metrics

- **Layer:** BE
- **Depends on:** Phase 43 (context budgeter & tokenizer parity)
- **Unblocks:** Phase 47 (LangGraph workflow loads summary/facts/metrics shape)
- **Size:** 1–2 days
- **Requirements covered:** `backend/requirments.md` §42 (conversation context), §43–§44
  (management + limit exposure), §58–§59 (related execution metrics — context portion only);
  `frontend/requirments.md` §36–§38 (context capacity, warnings, metrics display);
  `backend/solution.md` §1.2 step 2 (persisted summary), §5.1 step 2 (load from Mongo)

## 1. Goal

After this phase each conversation can carry a **persisted rolling summary** and **pinned facts**
(clarifications and user corrections), and assistant messages can store **context accounting
metrics** that were actually measured by Phase 43 — never guessed. A loader assembles
`summary + pinned + recent turns` for downstream graph nodes, and HTTP GET message responses expose
metrics fields only when present (frontend §38: omit unavailable values).

You can see it working by updating a summary after a compaction event in tests, pinning a fact,
loading context for a fake run, and confirming GET messages include `contextMetrics` only when the
budgeter returned numbers.

## 2. Why this phase is here

Phase 43 compacts prompts but does not own long-lived summary text or user-visible metrics.
Requirements §43 require replacing older turns with a summary **before** the hard limit, and §44
require recording validated limits and measured input for each model call. Phase 47/50 need a
single loader (`buildConversationContext`) that Phase 50 calls before LangGraph starts
(architecture §6.1 step 7).

Summarization **writer** choice (LLM vs extractive) depends on Phase 45 — this phase defines
storage, update triggers, and metric shapes, and lists the writer decision in §12.

## 3. Scope

### In scope

- **`ConversationContext` subdocument** (or sibling collection — PROPOSED on conversation):
  `summaryText`, `summaryUpdatedAt`, `summaryCoversThroughMessageId`, `pinnedFacts[]`.
- **`pinnedFacts` entry:** `{ id, text, source: 'clarification' | 'user_correction', messageId?, createdAt }`.
- **`Message.contextMetrics` subdocument** (assistant messages primarily):

```text
validatedInputLimit, measuredInputTokens, reservedOutputTokens,
contextPercentUsed, compactionActions[], providerUsage?: { inputTokens, outputTokens }
```

  Populated only when Phase 43 accounting succeeded for that call; otherwise field absent/null.

- Service **`buildConversationContext(orgId, projectId, conversationId, budgetHint)`** returning
  segments for `prepareModelInput` (Phase 43).
- Service **`updateConversationSummary(...)`** invoked when compaction replaces turns (Phase 43
  action `replace_with_summary`) or on a schedule before hard limit — writer implementation per §4.3.
- Service **`pinFact(...)`** / **`unpinFact(...)`** — internal APIs; HTTP for pin may wait for
  clarification UX (Phase 52) unless a minimal PATCH is PROPOSED below.
- Enforce: conversation content never writes to project knowledge collections (§142–§143).

### Out of scope (owner phase)

- LLM `generateText` for summaries — **Phase 45**, unless user chooses extractive-only (§12).
- LangGraph checkpointing — **Phase 47**.
- SSE streaming of metrics — **Phase 50** forwards persisted fields on `done`.
- Token usage rollups for org billing — **Phase 59**.
- Tool-round / wall-time run budgets — **Phase 48**.

## 4. Design

### 4.1 When summary updates run

Trigger points (all call `updateConversationSummary`):

1. **Compaction hook:** Phase 43 returns `replace_with_summary` → append covered turn ids, refresh
   summary text before the next model call.
2. **Proactive threshold:** when `measuredInputTokens / maximumInputBudget` exceeds a **named
   constant** `SUMMARY_REFRESH_THRESHOLD_RATIO` — value from Phase 05 evaluation, **not invented**
   here; until Phase 05, hook exists but does not run proactively (or runs only in tests with injected
   ratio).

Summary must exist **before** older turns drop out of the prompt (backend §43).

### 4.2 Summary writer (blocked on product + Phase 45)

| Mode | Needs Phase 45 | Notes |
|---|---|---|
| **LLM summary** | Yes | Budgeted `generateText` with `purpose: 'summarize'` via Phase 43 |
| **Extractive summary** | No | Concatenate user questions + abstain markers + clarification texts; honest but low quality |

**Open question (§12):** which mode is MVP until Phase 45 ships? Do not silently pick LLM.

Extractive mode must not imply semantic understanding in audit/logs.

### 4.3 Pinned facts

Pinned facts are always included in protected segments (Phase 43). Sources:

- Clarification answers (Phase 52) call `pinFact` with `source: 'clarification'`.
- Optional user "remember this" — **no HTTP in MVP unless asked**; field exists for future.

Max pins: constant `PINNED_FACTS_MAX_COUNT` (e.g. 20) — confirm in §12.

### 4.4 Context metrics honesty

Rules (README §4 grounding):

- `contextPercentUsed = measuredInputTokens / maximumInputBudget` only when both measured.
- Never store provider usage unless the SDK/Ollama returned it (Phase 45).
- If Phase 43 failed, **do not start** the model call (§44) — no partial metrics row.
- UI-facing GET omits keys when null (frontend §38).

`compactionActions` persisted on the **assistant message** that followed the compaction (or on the
user message that triggered the run — pick one in §12 and stay consistent for Phase 57).

### 4.5 Loader flow

```text
buildConversationContext(...):
  load conversation + summary + pins (status A)
  load recent messages newest-first until budgetHint or cap constant
  build segments[] for prepareModelInput
  return { segments, summarySegment, pinnedSegments, recentMessageIds }
```

Does not call CodeGraph or load repository files (architecture §6.1).

## 5. Data model changes

### Additive on `conversations`

| Field | Type | Notes |
|---|---|---|
| `context.summaryText` | string | default `''` |
| `context.summaryUpdatedAt` | Date \| null | |
| `context.summaryCoversThroughMessageId` | ObjectId \| null | |
| `context.pinnedFacts` | array | see §4.3 |

### Additive on `messages`

| Field | Type | Notes |
|---|---|---|
| `contextMetrics` | object \| null | see §4.4 |
| `providerUsage` | object \| null | optional nested inside metrics or top-level — pick one |

Indexes: none required beyond Phase 41 unless query by `summaryUpdatedAt` for retention analytics
(defer).

## 6. API contract — PROPOSED (needs approval before implementation)

### Extended `GET .../messages` item shape (Phase 41 route)

When metrics exist:

```json
{
  "id": "6650f1a2c3d4e5f6010203bb",
  "role": "assistant",
  "content": "...",
  "messageStatus": "completed",
  "contextMetrics": {
    "validatedInputLimit": 0,
    "measuredInputTokens": 0,
    "reservedOutputTokens": 0,
    "contextPercentUsed": 0.82,
    "compactionActions": [
      { "action": "replace_with_summary", "segmentId": "turn1", "beforeTokens": 400, "afterTokens": 120 }
    ]
  },
  "providerUsage": { "inputTokens": 0, "outputTokens": 0 },
  "createdAt": "2026-09-12T12:00:00.000Z"
}
```

Omit `contextMetrics` / `providerUsage` when unavailable.

### `GET /projects/:projectId/conversations/:conversationId/context` — `chat.ask`

Read-only view for UI context warnings (frontend §37). **No fabricated percentages.**

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

`lastRunMetrics` copied from the latest assistant message that has metrics, or omitted entirely.

### Internal

```text
buildConversationContext(orgId, projectId, conversationId, options) → { segments, ... }
updateConversationSummary(orgId, projectId, conversationId, { throughMessageId, mode }) → void
pinFact(...) / unpinFact(...)
persistMessageContextMetrics(messageId, metricsFromBudgeter) → void
```

## 7. Configuration & environment variables

**None.**

### Constants (not env)

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `PINNED_FACTS_MAX_COUNT` | `20` | `conversationContext.service.js` | Cap pins |
| `RECENT_TURNS_MAX_COUNT` | `50` | `conversationContext.loader.js` | Loader safety cap before budgeter |
| `SUMMARY_REFRESH_THRESHOLD_RATIO` | TBD Phase 05 | `conversationContext.summary.js` | Proactive refresh |

Do not set `SUMMARY_REFRESH_THRESHOLD_RATIO` in production until Phase 05.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/conversations/conversationContext.loader.js` | `buildConversationContext` |
| `backend/src/modules/conversations/conversationContext.summary.js` | Summary update + writer modes |
| `backend/src/modules/conversations/conversationContext.pins.js` | Pin/unpin |
| `backend/src/modules/conversations/conversationContext.metrics.js` | Persist metrics on messages |
| `backend/src/modules/conversations/conversationContext.*.test.js` | Tests |
| `backend/src/modules/conversations/conversations.model.js` | `context` subdocument |
| `backend/src/modules/conversations/messages.model.js` | `contextMetrics` |
| `backend/src/modules/conversations/conversations.routes.js` | Optional GET `.../context` |
| `backend/src/modules/conversations/index.js` | Export loader for Phase 50 |

## 9. Tests (≥ 80% line and branch)

### Unit

- Loader builds segments with summary + pins + recent turns ordering.
- Summary update after compaction action includes `summaryCoversThroughMessageId`.
- Extractive writer (if approved) produces deterministic text from fixture turns.
- Metrics persistence: only writes when budgeter output includes counts; omits on accounting failure.
- `contextPercentUsed` not written when denominator missing.
- Pin max enforced; duplicate pin id rejected.

### Integration

- GET messages returns metrics on assistant row after test hook persists them; user rows omit.
- GET `.../context` omits `lastRunMetrics` when no assistant metrics exist.
- Summary + messages remain when project knowledge updates (no writes to knowledge collections).

### Unhappy paths

- Load context for soft-deleted conversation → `404`.
- Cross-tenant conversation id → `404`.

## 10. Definition of Done

- [ ] Summary and pinned facts stored on conversation; metrics on messages when measured.
- [ ] `buildConversationContext` exported for Phase 50/47.
- [ ] No LLM calls unless user approves LLM summary mode **and** Phase 45 is merged.
- [ ] No fabricated token counts or percentages in API responses.
- [ ] GET shapes omit unavailable metric fields (frontend §38).
- [ ] Coverage ≥ 80% line and branch on new/changed files.

## 11. Documentation & ADR updates

- `docs/architecture.md` §6.1 step 7: reference `buildConversationContext`.
- `docs/data-model.md`: conversation `context` and message `contextMetrics` when present.

## 12. Risks & open questions

1. **Summary writer:** LLM (requires Phase 45) vs extractive-only until Phase 45 — which is MVP?
2. **Where to attach `compactionActions`:** user message vs assistant message for UI (Phase 57)?
3. **HTTP pin/unpin:** needed in MVP or only internal from Phase 52?
4. **`GET .../context` endpoint:** required for FE §37 warnings before Phase 50, or defer to stream
   `done` payload only?
5. **Summary storage size limit:** max chars constant before truncation/error?
6. **Proactive summary threshold:** block on Phase 05 ratio or use extractive refresh without LLM?
