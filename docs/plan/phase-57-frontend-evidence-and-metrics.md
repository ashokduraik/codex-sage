# Phase 57 — Frontend evidence, metrics, abstain & version notices

- **Layer:** FE
- **Depends on:** Phase 55 (streaming answer — message payload + SSE `evidence`/`done`), Phase 39
  (source preview API), Phase 49 (draft/verify/persist — evidence[] + usage on messages)
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
`evidence[]`, open **source preview** via Phase 39 file/slice APIs without leaving the conversation,
render **abstain / insufficient evidence** answers with distinct non-success styling (§64A),
display **response metrics** only when the message or `done` event includes them (§61, §98),
warn when **project knowledge version changed** after re-index while preserving old message
snapshots (§35, §108), and accept **“Ask about this”** context from Phase 40 by pre-filling or
attaching context to the Phase 55 composer — without fabricating counts or confidence scores.

You can see it working by expanding “Sources · N” on an answer, opening a file preview with line
range, returning to the same thread, and seeing a banner after knowledge publish that newer
questions use updated knowledge while older answers keep their cited version label.

## 2. Why this phase is here

Phases 49 and 39 define what the backend can prove; Phase 55 streams and persists messages.
Frontend §66–§70 and §97 require inspectable sources and honest abstain — that is mostly
presentation and preview wiring, not SSE protocol. Splitting it avoids overloading Phase 55 and
keeps preview API consumption testable against Phase 39 mocks.

It depends on 55 so message objects exist with `evidence`, `supportLevel`, `knowledgeVersionId`,
and optional `usage` / `contextMetrics`. Phase 40 should already expose navigation hooks; this
phase completes the chat-side receiver.

## 3. Scope

### In scope

- `EvidenceList` collapsible under assistant messages (§66): count label from array length only.
- `EvidenceItem` rows: title/path, type label from backend, line range when present; excluded-from-
  graph flag from Phase 39 rules — show callout, do not present as graph fact.
- `SourcePreviewDrawer` (or side panel): `GET …/files/slice?path=&startLine=&endLine=` from
  Phase 39 PROPOSED; loading/error; return focus to evidence row on close (§67).
- Abstain / partial support: when `supportLevel` or backend abstain flag indicates insufficient
  evidence, apply distinct typography/border (§64A, §97) — not the same as success grounded answer.
- Metrics row (§61): render subset of `{ durationMs, inputTokens, outputTokens, contextUsed,
  contextLimit }` **only if present** on message; format with locale helpers; omit missing fields —
  never placeholders like “— tokens”.
- Context warning (§37–§38): when message includes `contextMetrics.percentUsed` (Phase 44/49),
  show subtle banner on that thread — do not compute % client-side.
- Knowledge version notice (§35, §108): compare conversation’s last known `knowledgeVersionId` from
  project detail (Phase 19/28) vs message snapshot; after re-index success, show non-blocking
  banner that new questions use current knowledge; old messages show “Based on knowledge version …”
  when backend supplies id/label — do not invent version names.
- **Ask about this** (§68, §70): listen for router state / search param / shared event from Phase 40
  (`askAbout` payload with resolved ids from Phase 38); activate chat tab, focus composer with
  structured context chip or prefilled prompt **as Phase 38 defines** — do not invent resolution
  shape.
- Chat → Knowledge (§69): from evidence link, navigate to knowledge explorer route with return
  token so user can come back to same `conversationId`.
- Trust copy for conflicting/stale markers when evidence items include backend flags (§97).
- i18n, keyboard, reduced-motion for drawer; 375px preview scroll.

### Out of scope (owner phase)

- Knowledge explorer tree itself — **Phase 40**.
- Preview API implementation — **Phase 39**.
- Streaming deltas — **Phase 55**; clarification — **Phase 56**.
- Usage admin dashboards — **Phase 59**.
- Live DB query evidence — README §5 out of scope.
- Playwright — **Phase 63**.

## 4. Design

### 4.1 Evidence UI

```text
MessageItem (assistant, completed)
  └── Markdown body
  └── SupportLevelBanner (abstain | partial | grounded)
  └── MetricsLine (optional fields only)
  └── EvidenceList collapsed by default
        └── EvidenceItem → opens SourcePreviewDrawer
```

Progressive disclosure (§96): collapsed default keeps conversation readable (§66).

### 4.2 Preview flow

```text
tap evidence → drawer open → GET slice (Phase 39)
  → show path, lines, content excerpt
  → [Ask about this] prefills composer context from evidence id
  → Close → restore conversation scroll position
```

Byte/token caps are server-side (Phase 39); show truncated message if API returns `truncated:
true`.

### 4.3 Version change detection

```text
on project detail fetch:
  currentKnowledgeVersionId = project.currentKnowledgeVersionId
on message render:
  if message.knowledgeVersionId && !== current → show subtle stale/version label on that message
on first open after project knowledgeHealth returns ready from updating:
  show thread-level banner once (session flag) explaining new graph in use
```

Do not query historical graphs (architecture §6.2).

### 4.4 Ask-about-this integration

Phase 40 PROPOSED pattern (consume when approved):

```text
navigate to …/chat?conversation=:id&askAbout=:token
ChatWorkspace reads askAbout, resolves display label via cached search/knowledge payload
Composer shows non-editable context chip + user question field
Send includes askAbout reference in POST body only if Phase 50 defines field — else prepend
  human-readable context per §12
```

### 4.5 Anti-fabrication

- Source count = `evidence.length`.
- No confidence percentage unless backend sends a documented field (requirements forbid meaningless
  scores — §97).

## 5. Data model changes

**None.**

## 6. API contract — PROPOSED (needs approval before implementation)

### Phase 49 — message fields (via GET conversation / done event)

Illustrative persisted assistant message (PROPOSED):

```json
{
  "id": "6650…",
  "role": "assistant",
  "content": "…markdown…",
  "messageStatus": "completed",
  "supportLevel": "grounded",
  "knowledgeVersionId": "6650…",
  "evidence": [
    {
      "id": "ev1",
      "kind": "code",
      "path": "src/checkout/service.js",
      "startLine": 40,
      "endLine": 88,
      "label": "processPayment",
      "excludedFromGraph": false
    }
  ],
  "usage": {
    "durationMs": 2800,
    "inputTokens": 18400,
    "outputTokens": 4800
  },
  "contextMetrics": {
    "percentUsed": 82,
    "compactionApplied": true
  }
}
```

Exact names follow Phase 49 section 6.

### Phase 39 — preview (PROPOSED)

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/v1/projects/:projectId/sources/files/slice?path=&startLine=&endLine=` | `sources.preview` |

Response: `{ path, startLine, endLine, content, truncated?, excludedFromGraph? }`.

Optional full file metadata route from Phase 39 — use only if approved.

### Phase 50 — send with ask-about context (PROPOSED)

If Phase 38/50 define a structured field:

```json
{ "content": "…", "askAbout": { "kind": "symbol", "id": "…" } }
```

Otherwise UI-only prefill — confirm in §12.

This phase **does not add** backend routes.

## 7. Configuration & environment variables

**None new.** Preview max display lines optional constant in drawer component.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `frontend/src/features/chat/components/EvidenceList.jsx` | **New:** collapsible list |
| `frontend/src/features/chat/components/EvidenceItem.jsx` | **New:** row + open preview |
| `frontend/src/features/chat/components/SourcePreviewDrawer.jsx` | **New:** Phase 39 slice viewer |
| `frontend/src/features/chat/components/SupportLevelBanner.jsx` | **New:** abstain/partial |
| `frontend/src/features/chat/components/MetricsLine.jsx` | **New:** conditional metrics |
| `frontend/src/features/chat/components/KnowledgeVersionNotice.jsx` | **New:** thread banner |
| `frontend/src/features/chat/hooks/useSourcePreview.js` | **New:** React Query for slice |
| `frontend/src/features/chat/hooks/useAskAboutContext.js` | **New:** parse Phase 40 entry |
| `frontend/src/features/chat/utils/formatMessageMetrics.js` | **New:** omit missing fields |
| `frontend/src/features/chat/*.test.jsx` | Coverage for above |
| `frontend/src/features/chat/MessageItem.jsx` | Integrate evidence/metrics/abstain |
| `frontend/src/features/chat/ChatWorkspace.jsx` | Version notice + askAbout |
| `frontend/src/features/chat/Composer.jsx` | Context chip for ask-about |
| `frontend/src/features/knowledge/*` | **Touch only if needed:** emit askAbout navigation (Phase 40) |
| `frontend/src/shared/i18n/locales/en.json` | Evidence, abstain, stale, metrics keys |

## 9. Tests (≥ 80% line and branch)

### Unit

- `formatMessageMetrics` omits undefined tokens; never returns zero placeholders.
- Abstain `supportLevel` maps to abstain banner key, not error key.
- Version label shown when message version ≠ project current.

### Component

- Evidence collapsed by default; expand shows N items.
- Preview drawer: loading skeleton, error alert, truncated content message.
- Excluded-from-graph evidence shows warning callout (Phase 39 flag).
- MetricsLine: with full usage object shows formatted line; with `{}` renders nothing.
- Ask-about: arriving with query param focuses composer with chip.
- Abstain message does not use success-green styling.
- Preview `403` shows forbidden, not raw JSON.

### Unhappy paths (required)

- Preview network failure retry.
- Empty `evidence[]` on grounded message — hide list, no “Sources · 0” unless product wants zero
  (§12).
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

- None unless preview drawer pattern is reused outside chat — then note in `docs/architecture.md`
  §8 cross-link only.

## 12. Risks & open questions

1. **Ask-about POST shape:** Structured body field vs text prefill only?
2. **supportLevel enum:** Exact values from Phase 49 (`grounded` | `partial` | `abstain`)?
3. **Show “Sources · 0”** for abstain with empty evidence?
4. **Knowledge version display:** Human label from API or raw id substring?
5. **Conflict flags on evidence:** Does Phase 39/49 send doc-vs-code conflict on items yet?
6. **Cross-feature import:** May chat import a thin helper from `features/knowledge` or must
   shared hook live in `shared/`?
