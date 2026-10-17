# ADR 0035 — LangGraph in-process with Mongo chat checkpoints

- Status: Accepted
- Date: 2026-10-17
- Deciders: product owner

## Context

FLOW B runs a multi-step chat workflow (UNDERSTAND → clarify or tools → draft → verify →
persist). The workflow must pause for clarification, survive client disconnect, and resume
the same answer run. Architecture places LangGraph in the API process (not the worker).
Snapshots need durable storage scoped by organization.

## Decision

- Use **`@langchain/langgraph`** in-process in the API, owned by
  `backend/src/modules/conversation/chatGraph.js` (not a fifth `modules/chat/` package).
- Persist graph snapshots in Mongo collection **`chatCheckpoints`** via a thin custom saver
  that respects tenant `orgId` and row `status` `A`|`D`.
- **`threadId`** = `{orgId}:{conversationId}:{assistantMessageId}` so one pending assistant
  message maps to one resumable run (phase 50 idempotency).
- After clarification answers, resume at **UNDERSTAND** with answers bound.
- Checkpoints must **not** store private model reasoning / chain-of-thought.
- Canonical clarification Q&A documents remain a later phase (52); checkpoints only hold
  graph interrupt state until then.

## Consequences

- Schema for `chatCheckpoints` requires explicit user approval before the Mongoose model
  is added (`schema-change-approval.mdc`).
- Phase 48–49 extend the same `chatGraph.js` rather than a second compiler.
- Official LangGraph Mongo checkpointer packages may wrap the same collection only if they
  meet `dependency-versions.mdc` and can honor tenant + soft-delete conventions.

## Alternatives considered

- Worker-hosted LangGraph — rejected; architecture and SSE ownership stay on the API.
- In-memory only checkpoints — rejected; clarification and disconnect recovery need durability.
- Fifth domain module `modules/chat/` — rejected; conversation owns chat domain resources.

## Escape hatch

Supersede if a maintained LangGraph official Mongo saver becomes the sole implementation
while still enforcing org scoping and soft-delete, or if thread identity moves to an
explicit `runId` with a documented migration.
