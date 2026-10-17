# Phase 49 — LangGraph workflow: draft, verify & persist

- **Layer:** BE
- **Depends on:** Phase 48 (tool loop, populated `toolResults`, run budgets)
- **Unblocks:** Phase 50, 57
- **Size:** 1–2 days
- **Requirements covered:** backend §60–§64, §67, §113, §146; backend/solution.md §5.2 nodes D–F,
  §5.9; docs/architecture.md §6.2 (DRAFT, VERIFY, PERSIST)

## 1. Goal

After this phase the chat graph completes FLOW B: **DRAFT_ANSWER** streams grounded Markdown via
existing `streamText` (bounded thinking on; answer tokens only via `onDelta`), **VERIFY_ANSWER**
runs **deterministic checks first** and calls the LLM only for unresolved ambiguous claims, then
**PERSIST** updates the pending assistant `Message` with `evidence[]`, usage, duration, model id,
`knowledgeVersionId`, `supportLevel`, and `trace` (§146). Insufficient evidence → **prefer abstain**.
Private chain-of-thought never appears in stored content or hooks. Phase 50 maps hooks to SSE.

## 2. Locked decisions

1. **DRAFT thinking:** `enableThinking: true` on `streamText`; only `textStream` chunks → `onDelta`.
2. **`MAX_VERIFY_REVISE = 1`:** fail + budget → back to **AGENT_TOOLS** once; then abstain or grounded
   `partial`.
3. **Evidence:** full EvidenceRecord snapshots into existing Mixed `evidence`.
4. **§146:** embed `Message.trace` (Mixed) — no `responseTraces` collection.
5. **Persist:** **update** the pending assistant row identified by
   `threadId` → `assistantMessageId` (phase 50 / tests create the stub). Never insert a second turn.
6. **Auto-title:** best-effort `scheduleConversationAutoTitle` from PERSIST (never blocks `onDone`).
7. **Partial knowledge:** append warning text when `scope.knowledgeHealth === 'partially_available'`.
8. **`messageStatus`:** `completed` | `abstained` | `failed` (this phase);
   `interrupted` / clarify statuses stay phase 50.
9. **No new env vars.** `streamText` / `ai` package already present from phase 45.

## 3. Graph shape

```text
AGENT_TOOLS → (finish + evidence) → DRAFT_ANSWER → VERIFY_ANSWER
                              ↑                         │
                              │                    revise once
                              └─────────────────────────┘
VERIFY pass|partial → PERSIST_DONE → END
VERIFY abstain / empty evidence → PERSIST_ABSTAIN → END
ABSTAIN_EARLY → PERSIST_ABSTAIN → END
```

## 4. Implementation (done)

| Path | Role |
| --- | --- |
| `backend/src/modules/conversation/chatGraph.js` | Compile/route; state fields; hook wiring |
| `backend/src/modules/conversation/chatGraph.helper.js` | DRAFT / VERIFY / PERSIST runners + `runDeterministicVerify` |
| `backend/src/modules/conversation/conversation.helper.js` | `finalizeAssistantMessage` |
| `backend/src/modules/conversation/conversation.js` | DTO fields + finalize export |
| `backend/src/models/messages.model.js` | `supportLevel`, `durationMs`, `modelId`, `trace`, status enum |

Hooks for phase 50: `onStage`, `onDelta`, `onEvidence`, `onDone`, `onError` (no Fastify `res`).

## 5. Definition of Done

- [x] DRAFT, VERIFY, PERSIST nodes integrated; full graph runnable through DONE/abstain.
- [x] VERIFY runs deterministic checks before any LLM verify call.
- [x] Prefer abstain over inventing project facts when evidence insufficient.
- [x] Assistant messages persist with `evidence[]` and `knowledgeVersionId`.
- [x] No private chain-of-thought in DB or stream callbacks.
- [x] Hooks defined for 50 SSE mapping; no Fastify reply in graph nodes.
- [x] §146 `Message.trace` persisted.
- [x] Unit + integration tests for verify, revise-once, abstain, persist failure.
