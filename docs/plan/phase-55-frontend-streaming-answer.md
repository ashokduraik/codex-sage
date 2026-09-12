# Phase 55 — Frontend streaming answer slice

- **Layer:** FE
- **Depends on:** Phase 54 (frontend conversations slice), Phase 50 (chat SSE endpoint & stream
  lifecycle), Phase 51 (queued questions — consumed for `202` handling)
- **Unblocks:** Phase 56 (clarification UI), Phase 57 (evidence & metrics on completed messages)
- **Size:** 1–2 days
- **Requirements covered:** `frontend/requirments.md` §45 (composer), §55–§57 (markdown, code,
  tables), §58 (streaming, interruption recovery), §59–§60 (observable stages only, no fake
  thinking), §62 (stop), §63 (retry), §64 (error taxonomy — stream vs HTTP), §90, §94, §98;
  `backend/requirments.md` §65, §96, §119–§120, §2089; `backend/solution.md` §5.1–§5.2;
  `docs/architecture.md` §6.1–§6.2, §9 (SSE events)

## 1. Goal

After this phase a user can type a question in the embedded composer, open an SSE stream from
`POST /api/v1/conversations/:id/messages`, see **observable** stage labels and incremental
Markdown (including code blocks and tables), stop an in-flight generation when the backend supports
abort, recover cleanly when the stream ends with `error` or disconnects, and retry a failed
assistant message when the API allows — without fabricating tokens, context percentages, or
chain-of-thought.

Clarification interaction (one-at-a-time + batch POST) is **Phase 56**. Evidence panels,
abstain-specific chrome, context metrics line, and knowledge-version warnings are **Phase 57**
(though this phase must **pass through** SSE `evidence` / `done` payloads into message state for
57 to render).

You can see it working by asking a question on a knowledge-ready project: status moves through
real stage names, text grows token-by-token, Stop cancels, and refreshing mid-run reloads the
final persisted message from Mongo per architecture §6.1.

## 2. Why this phase is here

Phase 54 supplies conversation ids and history; Phase 50 supplies the SSE contract. The product’s
core loop (frontend §102) requires streaming Markdown answers — mock `askQuestion` in
`ChatWorkspace.jsx` must go. Clarification and evidence are separable UI layers on the same
stream client; building them together would violate D9.

It must follow 54 so sends target real threads. It must precede 56 because clarification events
ride the same SSE connection.

## 3. Scope

### In scope

- SSE client module: `fetch` + `ReadableStream` or Phase 13 streaming helper; parse `event:` /
  `data:` frames; handle `status`, `delta`, `clarification`, `evidence`, `done`, `error` per
  **architecture §9** — do not add event types.
- Map `status` payloads to i18n keys for allowed stages only, e.g. `understanding_question`,
  `searching_code`, `reviewing_sources`, `generating_answer`, `verifying_answer`, `accepted` —
  **exact enum follows Phase 50 PROPOSED**; unknown stage → neutral “working” key, not invented
  CoT text (frontend §59–§60).
- Composer wired to send: `Idempotency-Key` header (Phase 12), `Accept: text/event-stream`,
  disable while in-flight, `aria-busy` on message region.
- Incremental Markdown renderer safe for partial input (§58): paragraphs, lists, tables, fenced
  code; horizontal scroll on mobile (§56–§57).
- Stop: abort `AbortController` + backend cancel if Phase 50 documents it; show “Generation
  stopped” (§62).
- HTTP failures before stream: envelope error UI (§64, §90).
- Stream `error` event: terminal failure UI + correlation id when present.
- Truncated stream (connection drop, no `done`/`error`): mark message **interrupted**, not
  complete (§58, §105.33); offer reload via Phase 54 detail refetch.
- `202` queued response (Phase 51): no SSE; show queued user message state (§35, §64).
- `KNOWLEDGE_UNAVAILABLE` and related codes: localized copy, no raw provider errors.
- Assistant **retry** button when `messageStatus` / API indicates retryable failure (§63) — calls
  Phase 53 PROPOSED `POST …/retry` if available; otherwise disable retry until 53 ships (§12).
- Store streaming draft in component state; on `done`, invalidate conversation detail to merge
  server message id.
- Remove mock `askQuestion`, fake keyword clarification (`needsClarification` in
  `ChatWorkspace.jsx`), and client-side “generating” simulation.

### Out of scope (owner phase)

- Clarification one-at-a-time UI and `POST …/clarifications/…/answers` — **Phase 56**.
- Evidence list UI, source preview drawer, abstain banner styling, metrics row, version-change
  notice — **Phase 57** (data may be cached on message object here).
- User message edit + downstream replace — **Phase 53**.
- Context limit warning banner (§37) and context `%` (§38) — **Phase 57** / Phase 44 metrics on
  BE.
- Database-query execution states (§59 “later slice”).
- Playwright — **Phase 63**.

## 4. Design

### 4.1 Module layout

```text
frontend/src/features/chat/
  api/chatStreamApi.js          POST message + parse SSE
  api/chatStreamEvents.js       event name constants + type guards
  hooks/useSendMessage.js       mutation + stream reducer
  hooks/useMessageStreamState.js  draft text, stage, terminal status
  components/StreamingMarkdown.jsx  incremental MD (remark/rehype per existing stack)
  components/ExecutionStatus.jsx    single-line stage label from status events
  Composer.jsx                  send + stop wired
  ChatWorkspace.jsx             orchestration, scroll-to-bottom
  MessageItem.jsx               streaming vs completed modes
```

### 4.2 SSE state machine (client)

```text
idle → posting → streaming → completed | failed | cancelled | interrupted | queued
```

| Terminal | UI |
|---|---|
| `completed` | Final markdown from server refetch or `done` |
| `failed` | Error alert + Retry if retryable |
| `cancelled` | Stopped copy |
| `interrupted` | Partial text + “interrupted” + reload/retry |
| `queued` | User bubble + queued badge (202) |

On `clarification` event: stash payload on active run, **do not** render full UI (56); optionally
pause delta append and show “needs clarification” stub.

On `evidence` event: attach to in-memory assistant draft for 57; no preview drawer yet.

### 4.3 Markdown streaming

- Buffer deltas; re-parse incrementally with a library already in the frontend stack (do not add
  deps without `dependency-versions.mdc`).
- Incomplete fenced blocks: render as plain pre until closing fence — avoid broken layout (§58).
- Code blocks: copy button when complete; language label when backend sends `language` on evidence
  paths only — do not guess language from fence info unless reliable.

### 4.4 Scroll and focus

- Auto-scroll when user near bottom; respect manual scroll-up (do not fight reader).
- After send, focus stays in composer; `aria-live="polite"` region for stage changes.

### 4.5 Idempotency and double-send

- Generate `Idempotency-Key` per user send attempt; reuse on explicit retry of **same** question
  only when product confirms (§12).

### 4.6 No fabrication rule

- Never show token counts, context %, or timing until `done` / message payload includes them
  (Phase 57 displays).
- Never emit fake “Searching…” without a preceding `status` event.

## 5. Data model changes

**None.**

## 6. API contract — PROPOSED (needs approval before implementation)

Consumed from **Phase 50** (primary), **Phase 51** (queued), **Phase 53** (retry). This phase
proposes **no new backend routes**.

### Phase 50 — send message SSE (PROPOSED)

```http
POST /api/v1/conversations/:conversationId/messages
Accept: text/event-stream
Content-Type: application/json
Idempotency-Key: <uuid>

{ "content": "How does checkout work?" }
```

Permissions: `chat.ask` + project ACL + knowledge gate.

**SSE events** (architecture §9; data shapes follow Phase 50 section 6 when approved):

| Event | Purpose |
|---|---|
| `status` | `{ stage: string, knowledgeHealth?: string }` |
| `delta` | `{ text: string }` append to draft |
| `clarification` | Full question set — UI deferred to 56 |
| `evidence` | `{ items: [...] }` — render deferred to 57 |
| `done` | `{ messageId: string, usage?: object, contextMetrics?: object }` |
| `error` | Same five-field envelope as ADR 0010 in-stream |

Pre-stream failures: `403`, `404`, `409`, `KNOWLEDGE_UNAVAILABLE`, etc. — JSON envelope, no SSE.

### Phase 51 — queued (PROPOSED)

When knowledge updating: `202 { messageId, jobId }` — no SSE body; UI marks user message `queued`.

### Phase 53 — assistant retry (PROPOSED)

```http
POST /api/v1/conversations/:conversationId/messages/:messageId/retry
```

Optional in this phase if 53 not merged — hide Retry control until contract exists.

## 7. Configuration & environment variables

**None new.** SSE URL uses Phase 13 base URL + relative path. Reconnect/backoff constants live in
`chatStreamApi.js` if needed (not env).

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `frontend/src/features/chat/api/chatStreamApi.js` | **New:** SSE POST + frame parser |
| `frontend/src/features/chat/api/chatStreamApi.test.js` | **New:** parser, truncated stream, error event |
| `frontend/src/features/chat/api/chatStreamEvents.js` | **New:** event constants |
| `frontend/src/features/chat/hooks/useSendMessage.js` | **New:** send + stream lifecycle |
| `frontend/src/features/chat/hooks/useSendMessage.test.js` | **New:** happy path, abort, 202, HTTP error |
| `frontend/src/features/chat/hooks/useMessageStreamState.js` | **New:** reducer for draft + stage |
| `frontend/src/features/chat/components/StreamingMarkdown.jsx` | **New:** partial MD render |
| `frontend/src/features/chat/components/StreamingMarkdown.test.jsx` | **New:** partial code fence, table |
| `frontend/src/features/chat/components/ExecutionStatus.jsx` | **New:** stage label from status |
| `frontend/src/features/chat/Composer.jsx` | Stop button, disabled states |
| `frontend/src/features/chat/Composer.test.jsx` | Send, stop, disabled when queued |
| `frontend/src/features/chat/ChatWorkspace.jsx` | Remove mocks; wire stream hook |
| `frontend/src/features/chat/ChatWorkspace.test.jsx` | Stream, interrupt, unauthorized |
| `frontend/src/features/chat/MessageItem.jsx` | Streaming assistant bubble |
| `frontend/src/features/chat/MessageItem.test.jsx` | Completed vs interrupted |
| `frontend/src/shared/i18n/locales/en.json` | Stages, stop, retry, queue, stream errors |

## 9. Tests (≥ 80% line and branch)

### Unit

- SSE parser handles multiple frames, split chunks, unknown event types ignored safely.
- Reducer: delta append, status change, terminal `error`, `done` clears busy.
- Stage map: known stages → i18n keys; unknown → fallback key.

### Component

- Send shows `aria-busy`; completed run clears busy.
- Partial markdown updates on each delta.
- `error` event shows alert with message + reference id.
- Truncated stream (abort mid-chunk) → interrupted state, not success checkmark.
- `202` → queued UI, no spinner on assistant placeholder.
- `403` before stream → forbidden alert, question preserved.
- Stop invokes abort; shows stopped copy.
- Retry button calls retry API when message failed + retryable (mock).

### Unhappy paths (required)

- Empty composer cannot send.
- Unauthorized (`401`) — session gate.
- Rate limit message when backend includes retry hint (§105.38).
- Knowledge unavailable copy distinct from generic 500.

## 10. Definition of Done

- [ ] Mock `askQuestion` and fake clarification detector removed from chat feature.
- [ ] SSE events limited to architecture §9 set; no invented events.
- [ ] No fabricated tokens, context %, or CoT strings.
- [ ] Stop, retry (when API exists), queue, and interrupt states match §58 and §64.
- [ ] Markdown/code/table rendering covered at 375px width.
- [ ] ≥ 80% coverage on new/changed chat stream files; lint clean.

## 11. Documentation & ADR updates

- None unless streaming client becomes a shared pattern for Phase 58 notifications SSE — if so,
  note in Phase 58 doc, not a new ADR here.

## 12. Risks & open questions

1. **Cancel semantics:** Does Phase 50 use DELETE on a run id, `AbortSignal` only, or a dedicated
   cancel route? Stop button depends on this.
2. **Retry API timing:** Implement retry in 55 or wait for Phase 53 merge?
3. **Markdown library:** Confirm existing remark/rehype stack vs new dependency for streaming.
4. **`usage` on `done`:** Display in 55 or strictly defer every metric to 57?
5. **Concurrent sends:** Block send while streaming, or queue second question client-side?
6. **Partial health:** Confirm `status` includes `knowledgeHealth: partial` for banner copy in 57.
