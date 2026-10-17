# Phase 55 — Frontend streaming answer slice

- **Layer:** FE (+ small BE abort wiring — ADR 0037)
- **Depends on:** Phase 54 (frontend conversations), Phase 50 (chat SSE), Phase 51 (202 queue),
  Phase 53 (retry endpoint)
- **Unblocks:** Phase 56 (clarification UI), Phase 57 (evidence & metrics on completed messages)
- **Size:** 1–2 days
- **Requirements covered:** `frontend/requirments.md` §45 (composer), §55–§57 (markdown, code,
  tables), §58 (streaming, interruption recovery), §59–§60 (observable stages only, no fake
  thinking), §62 (stop), §63 (retry), §64 (error taxonomy — stream vs HTTP), §90, §94, §98;
  `backend/requirments.md` §65, §96, §119–§120, §2089; `backend/solution.md` §5.1–§5.2;
  `docs/architecture.md` §6.1–§6.2, §9 (SSE events); ADR 0037

## 1. Goal

After this phase a user can type a question in the embedded composer, open an SSE stream from
`POST /api/v1/conversation/chatStream/streamMessage/:projectId/:conversationId`, see **observable**
stage labels and incremental Markdown (including code blocks and tables), **Stop** (abort) an
in-flight generation, recover cleanly when the stream ends with `error` or disconnects, and retry
a failed or interrupted assistant via
`POST /api/v1/conversation/chatStream/retryMessage/:projectId/:conversationId/:messageId` —
without fabricating tokens, context percentages, or chain-of-thought.

Clarification interaction (one-at-a-time + batch POST) is **Phase 56**. Evidence panels,
abstain-specific chrome, context metrics line, and knowledge-version warnings are **Phase 57**
(though this phase **passes through** SSE `evidence` / `done` payloads into message state for
57 to render).

You can see it working by asking a question on a knowledge-ready project: status moves through
real stage names, text grows token-by-token, Stop cancels and marks `interrupted`, and refreshing
mid-run reloads the interrupted (or completed) message from Mongo.

## 2. Why this phase is here

Phase 54 supplies conversation ids and history; Phase 50 supplies the SSE contract. The product’s
core loop (frontend §102) requires streaming Markdown answers. Clarification and evidence are
separable UI layers on the same stream client; building them together would violate D9.

It must follow 54 so sends target real threads. It must precede 56 because clarification events
ride the same SSE connection.

## 3. Scope

### In scope

- SSE client: `fetch` + `ReadableStream`; parse `event:` / `data:` frames; handle `status`,
  `delta`, `clarification`, `evidence`, `done`, `error` per architecture §9 — do not add event
  types.
- Map `status` stages to i18n: `accepted`, `understanding_question`, `searching_code`,
  `reviewing_sources`, `generating_answer`, `verifying_answer`, `awaiting_clarification`,
  `abstain_early`, legacy `generating`; unknown → neutral “working” (frontend §59–§60).
- Composer wired to send: `Idempotency-Key` (new UUID per send/retry), `Accept: text/event-stream`,
  disable while in-flight, `aria-busy` on message region.
- Incremental Markdown safe for partial input (§58); horizontal scroll on mobile.
- Stop: `AbortController` abort closes the request; backend aborts the graph (ADR 0037); UI shows
  “Generation stopped” (§62).
- HTTP failures before stream: envelope error UI (§64, §90).
- Stream `error` event: terminal failure UI + correlation id when present.
- Truncated stream (connection drop, no `done`/`error`, not user Stop): mark **interrupted**;
  refetch via Phase 54 detail/messages.
- `202` queued (Phase 51): no SSE; show queued user message state.
- `KNOWLEDGE_UNAVAILABLE` and related codes: localized copy, no raw provider errors.
- Assistant **retry** when latest active assistant is `failed` or `interrupted` (§63).
- Store streaming draft in component state; on `done`, invalidate conversation messages to merge
  server ids.
- Remove Phase 55 composer gates / disabled placeholders.
- **BE:** wire `AbortController` on chat SSE disconnect → `interrupted` (ADR 0037).
- **Answer-quality eval:** gold questions + citation/abstain scorer under `docs/evaluation/`.

### Out of scope (owner phase)

- Clarification one-at-a-time UI and `POST …/clarifications/…/answers` — **Phase 56**.
- Evidence list UI, source preview drawer, abstain banner styling, metrics row, version-change
  notice — **Phase 57** (data may be cached on message object here).
- User message edit UI — later FE slice (BE edit is Phase 53).
- Context limit warning banner and context `%` — **Phase 57**.
- Playwright — **Phase 63**.
- Live LLM answer-quality run in CI — operator script only this phase.

## 4. Design

### 4.1 Module layout

```text
frontend/src/features/chat/
  api/chatStreamApi.js          POST stream/retry + parse SSE
  hooks/useSendMessage.js       mutation + stream reducer + AbortController
  StreamingMarkdown.jsx         incremental MD (react-markdown + remark-gfm)
  ExecutionStatus.jsx           single-line stage label from status events
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
| `cancelled` | Stopped copy (user Stop) |
| `interrupted` | Partial text + interrupted + reload/retry |
| `queued` | User bubble + queued badge (202) |

On `clarification` event: stash payload on active run; optional “needs clarification” stub (56).

On `evidence` event: attach to in-memory assistant draft for 57; no preview drawer yet.

### 4.3 Markdown streaming

- Reuse existing `react-markdown` + `remark-gfm` (no new deps).
- Incomplete fenced blocks: render as plain `pre` until closing fence.
- Code blocks: copy button when complete (shared renderer behavior).

### 4.4 Scroll and focus

- Auto-scroll when user near bottom; respect manual scroll-up.
- After send, focus stays in composer; `aria-live="polite"` for stage changes.

### 4.5 Idempotency

- New `Idempotency-Key` (`crypto.randomUUID()`) per send attempt and per retry click.

### 4.6 No fabrication

- Never show token counts, context %, or timing until Phase 57.
- Never emit fake “Searching…” without a preceding `status` event.

### 4.7 Stop / abort (ADR 0037)

- Client aborts the fetch → request close → backend aborts graph → assistant `interrupted`.
- No dedicated cancel route.

## 5. Data model changes

**None.**

## 6. API contract — CONSUMED (implemented)

No new backend routes. Paths under `API_BASE_PATH` (`/api/v1`).

### Send message SSE

```http
POST /api/v1/conversation/chatStream/streamMessage/:projectId/:conversationId
Accept: text/event-stream
Content-Type: application/json
Idempotency-Key: <uuid>

{ "content": "How does checkout work?" }
```

Permissions: `chat.ask` + project ACL + knowledge gate.

| Event | Payload |
|---|---|
| `status` | `{ stage, knowledgeHealth?, removedMessageIds?, editGeneration? }` |
| `delta` | `{ text }` |
| `clarification` | Full set — UI deferred to 56 |
| `evidence` | `{ items: [...] }` — render deferred to 57 |
| `done` | `{ messageId }` |
| `error` | ADR 0010 five-field envelope in-stream |

Pre-stream failures: JSON envelope (`403`, `404`, `409`, `KNOWLEDGE_UNAVAILABLE`, …).

### Queued (Phase 51)

`202` JSON: `{ messageId, jobId, messageStatus, queuedAt, expiresAt }` — no SSE body.

### Retry (Phase 53)

```http
POST /api/v1/conversation/chatStream/retryMessage/:projectId/:conversationId/:messageId
Accept: text/event-stream
Idempotency-Key: <required>
```

Same SSE / 202 rules. Target: latest active assistant with `messageStatus` `failed` or
`interrupted`.

## 7. Configuration & environment variables

**None new.** Reconnect/backoff constants live next to the stream client (not env).

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/conversation/chatStream.js` | AbortController on disconnect → `interrupted` |
| `backend/tests/modules/conversation/chatStream*.test.js` | Disconnect abort tests |
| `docs/adr/0037-chat-sse-abort-on-disconnect.md` | ADR |
| `docs/architecture.md` | §6.1 disconnect semantics |
| `frontend/src/features/chat/api/chatStreamApi.js` | **New:** SSE POST + frame parser |
| `frontend/tests/features/chat/api/chatStreamApi.test.js` | Parser, truncated, error |
| `frontend/src/features/chat/hooks/useSendMessage.js` | **New:** send + stream lifecycle |
| `frontend/tests/features/chat/hooks/useSendMessage.test.jsx` | Happy path, abort, 202, HTTP error |
| `frontend/src/features/chat/StreamingMarkdown.jsx` | **New:** partial MD render |
| `frontend/tests/features/chat/StreamingMarkdown.test.jsx` | Partial fence, table |
| `frontend/src/features/chat/ExecutionStatus.jsx` | **New:** stage label |
| `frontend/src/features/chat/Composer.jsx` | Stop, disabled states |
| `frontend/src/features/chat/ChatWorkspace.jsx` | Wire stream hook |
| `frontend/src/features/chat/MessageItem.jsx` | Streaming assistant bubble |
| `frontend/src/shared/i18n/locales/en.json` | Stages, stop, retry, queue, stream errors |
| `docs/evaluation/answer-quality/cases.json` | Gold Q&A + citations |
| `docs/evaluation/run-answer-quality.mjs` | Operator runner |
| `docs/evaluation/answerQualityScore.js` | Pure scorer (importable) |
| `backend/tests/evaluation/answerQualityScore.test.js` | Scorer unit tests |

## 9. Tests (≥ 80% line and branch)

### Unit

- SSE parser: multiple frames, split chunks, unknown events ignored.
- Reducer: delta append, status change, terminal `error`, `done` clears busy.
- Stage map: known → i18n; unknown → fallback.
- Answer-quality scorer: overlap, precision/recall, abstain pass/fail.

### Component

- Send shows `aria-busy`; completed clears busy.
- Partial markdown updates on each delta.
- `error` event shows alert + reference id.
- Truncated stream → interrupted, not success.
- `202` → queued UI.
- `403` before stream → forbidden alert, question preserved.
- Stop aborts; shows stopped copy.
- Retry calls retry API when failed/interrupted.

### Unhappy paths

- Empty composer cannot send.
- Unauthorized (`401`).
- Rate limit message when backend includes retry hint.
- Knowledge unavailable copy distinct from generic 500.

### Backend

- Disconnect aborts graph; assistant `interrupted`; writes stop; retry allowed.

## 10. Definition of Done

- [ ] Phase 55 composer gates removed; real SSE send/retry wired.
- [ ] SSE events limited to architecture §9 set; no invented events.
- [ ] No fabricated tokens, context %, or CoT strings.
- [ ] Stop aborts graph (ADR 0037); “Generation stopped”; `interrupted` persisted.
- [ ] Retry for latest `failed` / `interrupted` assistant.
- [ ] Queue, interrupt, HTTP vs stream errors match §58 / §64.
- [ ] Markdown/code/table rendering covered at 375px width.
- [ ] Answer-quality gold set + runner + scorer tests; evaluation README updated.
- [ ] ≥ 80% coverage on new/changed stream/scorer files; lint clean.
- [ ] Architecture + ADR + this phase doc match code.

## 11. Documentation & ADR updates

- ADR 0037 (abort on disconnect).
- Architecture §6.1.
- Phase 50 disconnect section marked superseded.
- Evaluation README indexes answer-quality runner.

## 12. Risks & open questions

**None open** — locked in the Phase 55 implementation plan:

1. Cancel = AbortSignal on disconnect (ADR 0037); no cancel route.
2. Retry included (Phase 53 endpoint).
3. Markdown = existing `react-markdown` + `remark-gfm`.
4. Metrics deferred to Phase 57 (`done` is `{ messageId }` only).
5. Concurrent sends blocked while streaming.
6. `knowledgeHealth` on first `accepted` status only — banner UI in Phase 57.

## 13. Answer-quality evaluation

Operator script under `docs/evaluation/` (not Vitest CI). Gold cases in
`docs/evaluation/answer-quality/cases.json` with expected path + line citations and abstain
cases. Scorer: citation recall ≥ 1.0 for pass; abstain cases must abstain without inventing
citations. Suite floor: citation-pass rate and abstain-pass rate ≥ 0.8. See
`docs/evaluation/README.md`.
