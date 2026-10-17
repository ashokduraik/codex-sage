# Phase 57 — Frontend evidence, metrics, abstain & version notices

- **Layer:** FE
- **Depends on:** Phase 55 (streaming answer — message payload + SSE `evidence`/`done`), Phase 39
  (source preview API), Phase 49 (draft/verify/persist — evidence[] + usage on messages), Phase 40
  (ask-about navigation via `searchAttachment`)
- **Unblocks:** Phase 63 E2E (grounded answer inspection path); completes trust UX for chat
- **Size:** 1–2 days
- **Requirements covered:** `frontend/requirments.md` §61 (response metrics), §64A (abstain),
  §66–§70 (evidence, preview, ask-about-this, chat↔knowledge), §97 (trust/transparency), §108
  (stale knowledge presentation), §37–§38 (context warning/metrics when backend sends),
  §96 (progressive disclosure); `backend/requirments.md` §60–§64, §67, §83–§84; `backend/solution.md`
  §5.2 Node F, §11.3; `docs/architecture.md` §6.2 (evidence snapshots, re-index warning);
  Phase 40 (knowledge slice — “ask about this” entry points)

## 1. Goal

After this phase, completed assistant messages show **expandable evidence** grounded in backend
`evidence[]`, open **source preview** via Phase 39 `sourcePreview` APIs without leaving the
conversation, render **abstain / insufficient evidence** answers with distinct non-success styling
(§64A), display **response metrics** only when the message includes them (§61, §98), warn when
**project knowledge version changed** after re-index while preserving old message snapshots
(§35, §108), and accept **“Ask about this”** context from Phase 40 by attaching a composer chip
and prepending readable context into `content` — without fabricating counts or confidence scores.

You can see it working by expanding “Sources · N” on an answer, opening a file preview with line
range, returning to the same thread, and seeing a banner after knowledge publish that newer
questions use updated knowledge while older answers keep their cited version label.

## 2. Why this phase is here

Phases 49 and 39 define what the backend can prove; Phase 55 streams and persists messages.
Frontend §66–§70 and §97 require inspectable sources and honest abstain — that is mostly
presentation and preview wiring, not SSE protocol. Splitting it avoids overloading Phase 55 and
keeps preview API consumption testable against Phase 39 mocks.

It depends on 55 so message objects exist with `evidence`, `supportLevel`, `knowledgeVersionId`,
and optional `usage` / `contextMetrics` / `durationMs`. Phase 40 already emits `searchAttachment`
navigation state; this phase completes the chat-side receiver.

## 3. Scope

### In scope

- `EvidenceList` collapsible under assistant messages (§66): count label from array length only.
- `EvidenceItem` rows: path, kind, line range when present; `excludedFromGraph` callout — do not
  present as graph fact.
- Shared `SourcePreviewDrawer` (lifted from knowledge): `GET /knowledge/sourcePreview/readSlice/:projectId`
  (+ metadata); loading/error; return focus to evidence row on close (§67).
- Abstain / partial / conflict: when `supportLevel` or `messageStatus === 'abstained'` indicates
  insufficient evidence, apply distinct typography/border (§64A, §97) — not the same as success
  grounded answer.
- Metrics row (§61): render subset of top-level `durationMs` plus `usage.{inputTokens,outputTokens,totalTokens}`
  **only if present** on message; format with locale helpers; omit missing fields — never
  placeholders like “— tokens”.
- Context warning (§37–§38): when latest completed assistant message has
  `contextMetrics.contextPercentUsed >= 0.8` (fraction 0–1 from backend), show subtle composer
  banner — do not recompute % from raw token counts.
- Knowledge version notice (§35, §108): compare `project.currentKnowledgeVersionId` vs message
  snapshot; after re-index, show non-blocking thread banner once per session; old messages show
  “Based on knowledge version …” with shortened id — do not invent version names.
- **Ask about this** (§68, §70): consume Phase 40 `location.state.searchAttachment`
  (`{ id, knowledgeVersionId, title }`); focus composer with non-editable context chip; send
  remains `{ content }` with human-readable context prepended.
- Chat → Knowledge (§69): from evidence link, navigate to knowledge explorer with
  `state: { returnConversationId }` so user can come back to same conversation.
- Trust copy for message-level `supportLevel: 'conflict'` (§97) — no item-level conflict flags.
- i18n, keyboard, reduced-motion for drawer; 375px preview scroll.

### Out of scope (owner phase)

- Knowledge explorer tree itself — **Phase 40**.
- Preview API implementation — **Phase 39**.
- Streaming deltas — **Phase 55**; clarification — **Phase 56**.
- Expanding SSE `done` beyond `{ messageId }` — metrics come from persisted message DTO after
  invalidate/refetch.
- Usage admin dashboards — **Phase 59**.
- Live DB query evidence — README §5 out of scope.
- Playwright — **Phase 63**.

## 4. Design

### 4.1 Evidence UI

```text
MessageItem (assistant, completed)
  └── Markdown body
  └── SupportLevelBanner (insufficient | conflict | partial | evidence_backed)
  └── MetricsLine (optional fields only)
  └── EvidenceList collapsed by default
        └── EvidenceItem → opens shared SourcePreviewDrawer
        └── Open in knowledge → returnConversationId state
```

Progressive disclosure (§96): collapsed default keeps conversation readable (§66).

### 4.2 Preview flow

```text
tap evidence → drawer open → GET /knowledge/sourcePreview/readSlice/:projectId
  → show path, lines, content excerpt
  → Close → restore conversation scroll position
```

Byte/token caps are server-side (Phase 39); show truncated message if API returns `truncated: true`.

Shared placement: `frontend/src/shared/source-preview/` (drawer + hook + slice client). Knowledge
and chat both import from shared — no deep cross-feature imports.

### 4.3 Version change detection

```text
on project detail:
  currentKnowledgeVersionId = project.currentKnowledgeVersionId
on message render:
  if message.knowledgeVersionId && !== current → show subtle stale/version label
on first open after knowledge is ready and older messages cite a different version:
  show thread-level banner once (sessionStorage flag keyed by projectId)
```

Do not query historical graphs (architecture §6.2).

### 4.4 Ask-about-this integration

```text
Phase 40: navigate to …/chat with state.searchAttachment
ChatWorkspace: useAskAboutContext reads + clears state
Composer: non-editable chip + user question field
Send: prepend "Regarding «{title}»:" (or equivalent i18n) into content; body stays { content }
```

### 4.5 Anti-fabrication

- Source count = `evidence.length`; hide list when empty (no “Sources · 0”).
- No confidence percentage unless backend sends a documented field (requirements forbid meaningless
  scores — §97).

## 5. Data model changes

**None.**

## 6. API contract — as implemented (consume only)

This phase **does not add** backend routes.

### Message fields (GET conversation / persisted DTO)

| Field | Shape |
| --- | --- |
| `supportLevel` | `'evidence_backed' \| 'insufficient' \| 'conflict' \| 'partial'` (nullable) |
| `messageStatus` | includes `'abstained'` for abstain turns |
| `evidence[]` | `{ evidenceId, kind, path, startLine?, endLine?, heading?, excerpt, excludedFromGraph?, … }` |
| `usage` | `{ inputTokens, outputTokens, totalTokens }` (nullable fields) |
| `durationMs` | number \| null (sibling of `usage`, not nested) |
| `contextMetrics` | includes `contextPercentUsed` (0–1 fraction) when present |
| `knowledgeVersionId` | string when present |

SSE `done` remains `{ messageId }` only — FE refetches the message for metrics.

### Source preview (Phase 39)

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/knowledge/sourcePreview/readSlice/:projectId?path=&startLine=&endLine=` | `sources.preview` |
| `GET` | `/knowledge/sourcePreview/getMetadata/:projectId?path=` | `sources.preview` |

Response includes `{ path, startLine, endLine, content, truncated?, excludedFromGraph? }`.

## 7. Configuration & environment variables

**None new.** Preview display defaults stay named constants next to the shared hook.

## 8. Files to create or change

| Path | Purpose |
| --- | --- |
| `frontend/src/shared/source-preview/SourcePreviewDrawer.jsx` | Shared Phase 39 slice viewer (lifted from knowledge) |
| `frontend/src/shared/source-preview/useSourcePreview.js` | React Query for metadata + slice |
| `frontend/src/shared/source-preview/sourcePreviewApi.js` | Client wrappers for preview routes |
| `frontend/src/features/chat/EvidenceList.jsx` | Collapsible list |
| `frontend/src/features/chat/EvidenceItem.jsx` | Row + open preview / knowledge |
| `frontend/src/features/chat/SupportLevelBanner.jsx` | insufficient / conflict / partial / evidence_backed |
| `frontend/src/features/chat/MetricsLine.jsx` | Conditional metrics |
| `frontend/src/features/chat/KnowledgeVersionNotice.jsx` | Thread banner |
| `frontend/src/features/chat/hooks/useAskAboutContext.js` | Parse Phase 40 `searchAttachment` |
| `frontend/src/features/chat/utils/formatMessageMetrics.js` | Omit missing fields |
| `frontend/src/features/chat/MessageItem.jsx` | Integrate evidence/metrics/abstain/version |
| `frontend/src/features/chat/ChatWorkspace.jsx` | Version notice + askAbout + context warning |
| `frontend/src/features/chat/Composer.jsx` | Context chip for ask-about |
| `frontend/src/features/chat/api/conversationTypes.js` | Typed evidence / usage / supportLevel |
| `frontend/src/features/knowledge/*` | Import shared preview; back-to-chat when `returnConversationId` |
| `frontend/src/shared/i18n/locales/en.json` | Evidence, abstain, stale, metrics keys |
| `frontend/tests/features/chat/*` | Coverage for above |

## 9. Tests (≥ 80% line and branch)

### Unit

- `formatMessageMetrics` omits undefined tokens; never returns zero placeholders for missing fields.
- Abstain `supportLevel` / `messageStatus` maps to abstain banner key, not error key.
- Version label shown when message version ≠ project current.

### Component

- Evidence collapsed by default; expand shows N items.
- Preview drawer: loading skeleton, error alert, truncated content message.
- Excluded-from-graph evidence shows warning callout.
- MetricsLine: with full usage object shows formatted line; with `{}` / missing renders nothing.
- Ask-about: arriving with `searchAttachment` focuses composer with chip.
- Abstain message does not use success-green styling.
- Preview `403` shows forbidden, not raw JSON.
- Empty `evidence[]` — hide list.

### Unhappy paths (required)

- Preview network failure.
- Missing `knowledgeVersionId` — no version string invented.
- Unauthorized preview attempt.

## 10. Definition of Done

- [ ] Evidence opens Phase 39 preview; user can return to same conversation (§67).
- [ ] Abstain visually distinct from errors and grounded success (§64A, §97).
- [ ] Metrics only from backend fields (§61, §98).
- [ ] Knowledge re-index notice and per-message version labels per §35 and §108.
- [ ] Ask-about-this from Phase 40 reaches composer without new chat (§70).
- [ ] No fabricated token counts or confidence scores.
- [ ] ≥ 80% coverage; responsive + a11y checks on drawer.

## 11. Documentation & ADR updates

- Note shared preview placement in `docs/architecture.md` where preview UX is described (one-line
  cross-link only). No new ADR.

## 12. Locked decisions (closed)

1. **Ask-about POST shape:** UI-only — chip + prepend into `content`; no structured body field.
2. **supportLevel enum:** `evidence_backed` \| `insufficient` \| `conflict` \| `partial` (plus
   `messageStatus: 'abstained'`).
3. **Show “Sources · 0”:** No — hide EvidenceList when empty.
4. **Knowledge version display:** i18n + shortened id (first 8 chars); never invent names.
5. **Conflict flags on evidence items:** Message-level `supportLevel: 'conflict'` only.
6. **Cross-feature preview:** Shared module under `frontend/src/shared/source-preview/`.
7. **Metrics on SSE done:** Not expanded; use persisted message after refetch.
8. **Context warning threshold:** `contextPercentUsed >= 0.8` on latest completed assistant message.
9. **Chat → Knowledge return:** `state: { returnConversationId }` on knowledge route.
