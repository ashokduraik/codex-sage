# Phase 49 — LangGraph workflow: draft, verify & persist

- **Layer:** BE
- **Depends on:** Phase 48 (tool loop, populated `toolResults`, run budgets)
- **Unblocks:** Phase 50, 57
- **Size:** 1–2 days
- **Requirements covered:** backend §60–§64, §67, §113, §146; backend/solution.md §5.2 nodes D–F,
  §5.9; docs/architecture.md §6.2 (DRAFT, VERIFY, PERSIST)

## 1. Goal

After this phase the chat graph completes FLOW B: **DRAFT_ANSWER** streams grounded Markdown via phase 45
`streamText` (bounded thinking — policy aligned with phase 05), **VERIFY_ANSWER** runs **deterministic
checks first** (citations, paths, scope, knowledge version) and calls the LLM only for unresolved
checks, then **PERSIST + DONE** writes the assistant `Message` with required `evidence[]`, usage,
duration, `knowledgeVersionId`, and trace fields for enterprise debugging (backend §146). Insufficient
evidence → **prefer abstain** over invention (backend §113, §60). Private chain-of-thought never
appears in stored content or hook payloads (backend §67). Phase 50 attaches SSE `delta`, `evidence`,
and `done` to hooks/stream callbacks defined here. You can see it working in integration tests: fixture
tool evidence → draft text citing `evidenceId`s → VERIFY pass → Mongo message row `completed` with
matching evidence array.

## 2. Why this phase is here

Phases 47–48 produce routing and evidence; without draft/verify/persist, the graph ends with state in
memory only — violating backend §119 recoverable chat state and §62 evidence traceability. VERIFY must
exist before the SSE endpoint (50) streams user-visible answers users trust. Frontend evidence UI (57)
depends on the persisted `evidence[]` shape stabilized here. This phase stays **in-process** on the API
path (architecture §6.1) and does not add HTTP routes.

## 3. Scope

### In scope

- **DRAFT_ANSWER** node: prompt = rewritten question + short history + **only** `toolResults` blocks
  (with ids); rules: cite evidence ids; Markdown; no fabricated project facts (solution §5.2 node D).
- Stream tokens through a **draft stream adapter** callback (`onDelta(text)`) — phase 50 maps to SSE
  `delta`; this phase does not call `reply.raw`.
- Hook `generating_answer` before streaming; record full draft on state when stream completes.
- **VERIFY_ANSWER** node (solution §5.2 node E, backend §113):
  1. Programmatic: every non-trivial claim maps to an evidence id in `toolResults`; cited paths/lines
     exist (re-use phase 46 slice reader for spot-check when cheap); same `knowledgeVersionId`.
  2. Empty evidence → **must abstain**, not invent.
  3. LLM verify **only** if programmatic checks leave ambiguous claims and run budget allows.
- Verify outcomes: `pass` → PERSIST; `fail` with budget → one retrieve/revise cycle back to AGENT_TOOLS
  **or** abstain — max revise count as named constant (value open if evaluation-dependent); `fail`
  exhausted → abstain/partial with warning.
- Hook `verifying_answer` — status only, no reasoning text.
- **PERSIST + DONE** node: insert assistant `Message` (`messageStatus`: `completed`, `failed`, or
  `abstained` — align phase 41 enums); persist `evidence[]`, support level, token usage (when
  reported), wall duration, model id, context metrics from phase 44, `knowledgeVersionId`.
- Update conversation summary via phase 44 writer when budget requires (same transaction policy as 41).
- **ABSTAIN** paths (early from 47, verify fail, empty evidence): persist assistant message with
  explicit insufficient-info copy; `evidence[]` empty or minimal per policy.
- **Response traceability** record (backend §146): link user message id, knowledge version, evidence
  ids, processing stages — shape PROPOSED in §6 (may extend audit or message subdocument).
- Callbacks: `onEvidence(evidence[])`, `onDone({ messageId, usage?, metrics? })` for SSE wiring in 50.

### Out of scope (owner phase)

- `POST .../messages` SSE route, knowledge gate, idempotency, disconnect handling — **phase 50**.
- Queued message 202 flow — **phase 51**.
- Clarification HTTP — **phase 52**.
- Usage rollup admin APIs — **phase 59**.
- FE rendering — **phases 55, 57**.

## 4. Design

### 4.1 Graph completion

```text
AGENT_TOOLS → (finish) → DRAFT_ANSWER → VERIFY_ANSWER
                              ↑              │
                              │         fail + budget
                              └──────── revise (→ 48) optional once

VERIFY pass → PERSIST_DONE → END
VERIFY fail exhausted / abstain → PERSIST_ABSTAIN → END
```

Early **ABSTAIN_EARLY** (47) merges into `PERSIST_ABSTAIN` node or shared persist helper.

### 4.2 DRAFT_ANSWER

- Phase 43 budget preflight on messages.
- Phase 45 `streamText` with **`ai` package** (solution §2.1) — install at implementation, no version
  pin in this doc.
- **Bounded thinking** for draft: enabled/disabled per phase 05 / product — thinking content **never**
  forwarded to `onDelta` or stored (backend §67).
- Accumulate `cumulativeOutputTokens` from provider usage when present.

### 4.3 VERIFY_ANSWER (deterministic first)

```text
verifyAnswer(state):
  1. parseDraftClaims(state.draftAnswer)     ← headings, bullet claims, code refs
  2. for each claim requiring evidence:
       assert evidenceId ∈ state.toolResults
       assert path exists under scope
       optional: read_file_slice spot check for quoted lines
  3. if all pass → { result: 'pass' }
  4. if empty toolResults and draft asserts project facts → { result: 'abstain' }
  5. if failures remain && reviseCount < MAX_VERIFY_REVISE → { result: 'revise' }
  6. if failures remain && budget low → { result: 'abstain' | 'partial' }
  7. else if ambiguous → budgeted generateText verify JSON (thinking bounded/disabled)
```

Support level on message (backend §60): `evidence_backed`, `insufficient`, `conflict` — map from
verify result.

### 4.4 PERSIST + DONE

Repository calls (phase 41):

- Create assistant message linked to `userMessageId`, `conversationId`, org/project scope.
- Store markdown body, `evidence[]` (full records or snapshots per retention — PROPOSED),
  `knowledgeVersionId`, tokens, `durationMs`, `modelId`, context metrics blob.
- Set user message / run linkage so 50 can reload on disconnect (backend §96, §119).
- Invoke `onEvidence` then `onDone` — order fixed for SSE clients.

Failed persist → terminal error state; graph must not report `done` to hooks if Mongo write failed.

### 4.5 Evidence requirements

Final assistant messages that **assert project behaviour** must include non-empty `evidence[]` **or**
use abstain template with empty evidence (backend §113, solution §5.9 guarantee 3). Partial answers
with warning when verify returns `partial`.

## 5. Data model changes

**Additive on `Message`** (if not already in phase 41) — PROPOSED, approve before code:

| Field | Purpose |
|-------|---------|
| `supportLevel` | evidence_backed / insufficient / conflict / partial |
| `evidence[]` | persisted EvidenceRecord snapshots |
| `knowledgeVersionId` | version at answer time |
| `usage` | `{ inputTokens?, outputTokens?, totalTokens? }` — null if unknown |
| `durationMs` | wall time for run |
| `modelId` | configured artifact id |
| `contextMetrics` | phase 44 metrics object |
| `trace` | optional §146 metadata (stages, correlationId) |

Indexes unchanged unless listing by `messageStatus` for recovery — defer to 50.

Optional **`responseTraces`** collection for §146 — **open question** vs embedding on message.

## 6. API contract — PROPOSED (needs approval before implementation)

**No HTTP.** Stream/persist callbacks for phase 50:

```json
{
  "registerDraftStreamHandlers": {
    "onStage": "(stage) => void",
    "onDelta": "(text: string) => void",
    "onEvidence": "(evidence: EvidenceRecord[]) => void",
    "onDone": "({ messageId, usage?, contextMetrics?, supportLevel }) => void",
    "onError": "(ApiError | stream error shape from phase 02) => void"
  },
  "persistedMessage": {
    "id": "ObjectId",
    "role": "assistant",
    "contentMarkdown": "string",
    "evidence": "EvidenceRecord[]",
    "supportLevel": "string",
    "knowledgeVersionId": "ObjectId",
    "messageStatus": "completed | failed | abstained",
    "usage": "object | null",
    "durationMs": "number"
  },
  "verifyResult": {
    "result": "pass | revise | abstain | partial",
    "failures": [{ "claim", "reason" }]
  }
}
```

SSE events (emitted by 50, shapes agreed here):

- `status`: `{ stage: 'generating_answer' | 'verifying_answer' }`
- `delta`: `{ text: string }`
- `evidence`: `{ items: EvidenceRecord[] }`
- `done`: `{ messageId: string, supportLevel?: string }`

No event type exposes chain-of-thought.

## 7. Configuration & environment variables

**None.** `MAX_VERIFY_REVISE` (if used) is a named constant — value from evaluation if it affects
quality SLOs (open). Model id from phase 45 env.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `backend/src/modules/conversation/chatGraph.js` (+ tests) | Wire DRAFT / VERIFY / PERSIST nodes into phase 47–48 graph |
| `backend/src/modules/conversation/chatGraph.helper.js` | Overflow if draft/verify/persist runners exceed file cap |
| `backend/src/modules/conversation/conversation.js` / helper | Message create/update for persist |
| `backend/src/modules/conversation/index.js` | Export any new public persist helpers |

Do **not** add `backend/src/modules/chat/` or a deep `graph/nodes/` tree.

## 9. Tests (≥ 80% line and branch)

### Unit

- VERIFY rejects draft citing unknown `evidenceId`.
- VERIFY abstains when `toolResults` empty and draft contains project-specific claims.
- Deterministic path passes without LLM when all ids valid.
- LLM verify mock called **only** when deterministic leaves `ambiguous` flag.
- `onDelta` receives streamed chunks; thinking tokens filtered if provider sends them.
- PERSIST writes evidence array matching tool results; failed insert → onError, no onDone.

### Integration

- End-to-end graph with mocked LLM draft + real Mongo: message row queryable by id.
- Revise loop returns to AGENT_TOOLS at most `MAX_VERIFY_REVISE` times.
- Abstain path: messageStatus reflects abstain; no fake evidence rows.

### Unhappy paths

- streamText abort → message `failed` or `interrupted` per §119 enum (confirm with 50).
- Cross-version evidence in toolResults → verify fail.
- Provider omits usage → usage fields null, not zero fabrication.

## 10. Definition of Done

- [ ] DRAFT, VERIFY, PERSIST nodes integrated; full graph runnable from 47 entry through DONE.
- [ ] VERIFY runs deterministic checks before any LLM verify call.
- [ ] Prefer abstain over inventing project facts when evidence insufficient.
- [ ] Assistant messages persist with `evidence[]` and `knowledgeVersionId`.
- [ ] No private chain-of-thought in DB or stream callbacks.
- [ ] Hooks/callbacks defined for 50 SSE mapping; no Fastify reply in graph nodes.
- [ ] §146 trace fields persisted or explicitly deferred in §12 with user approval.
- [ ] `npm run lint`, `npm test` pass; coverage ≥ 80% line and branch.

## 11. Documentation & ADR updates

- Update `docs/data-model.md` / message schema doc when `Message` fields added.
- `backend/solution.md` §5.2 nodes D–F: sync if evidence or verify flow differs.
- `docs/architecture.md` §6.2 VERIFY bullet list.

## 12. Risks & open questions

1. **Draft thinking:** bounded thinking on/off for Qwen artifact — phase 05; must never leak to SSE.
2. **MAX_VERIFY_REVISE** count and whether revise re-enters 48 or only re-drafts.
3. **Evidence snapshot vs live path:** store full excerpt or id + pointer for retention (60).
4. **Separate `responseTraces` collection** vs `Message.trace` for §146.
5. **Auto title** after first successful answer — phase 42 vs hook here?
6. **Partial knowledge wording** when health is `partially_available` — include in message metadata?
