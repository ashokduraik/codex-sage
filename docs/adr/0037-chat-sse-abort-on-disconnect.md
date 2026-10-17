# ADR 0037 — Chat SSE abort on client disconnect

- Status: Accepted
- Date: 2026-10-17
- Deciders: product owner (Phase 55 Stop / cancel)

## Context

Phase 50 streamed chat answers over SSE and, on browser disconnect, only stopped writing
frames while the LangGraph run continued to persist (`completed` / `failed` /
`awaiting_clarification`). Frontend requirements forbid showing Stop unless cancellation is
actually supported. The graph already accepts `scope.abortSignal`, but the SSE transport never
wired it. Users needed a real Stop that marks the assistant `interrupted` and allows retry.

## Decision

- On client disconnect (`request.raw` `close`) for chat SSE runs
  (`streamMessage` / `editMessage` / `retryMessage` paths that invoke the graph), the API
  **aborts** an `AbortController` whose signal is passed as `scope.abortSignal` into
  `invokeChatGraph`.
- The assistant message is finalized with `messageStatus: 'interrupted'` (not `failed`),
  preserving partial answer content when available. Do not emit a successful `done` for a
  cancelled run.
- There is **no** separate cancel HTTP route; aborting the fetch (Stop) is the cancel signal.
- This **supersedes** Phase 50’s disconnect-continue behavior and the prior architecture §6.1
  note that the run always finishes after disconnect.

## Consequences

- Stop in the UI meets frontend cancellation requirements.
- Refresh or navigate away mid-run aborts generation; the user may Retry the latest
  `interrupted` (or `failed`) assistant via the existing retry endpoint.
- Clarification-answer SSE should follow the same abort wiring when that path shares the
  transport helper.
- ADR 0035 checkpointer durability still applies for clarification interrupts; abort cancels
  an in-flight run rather than letting it finish silently after disconnect.

## Alternatives considered

- Client-only abort (stop receiving SSE, server continues) — rejected; conflicts with “do not
  show Stop if cancellation is not supported.”
- Dedicated `POST …/cancel` route — deferred; AbortSignal on disconnect is sufficient for MVP.
- Mark disconnect as `failed` — rejected; `interrupted` is the reserved cancel/crash status
  and is already retryable.

## Escape hatch

Supersede if product requires cancel without closing the SSE connection (explicit cancel
route) or if long-running tools need a different cooperative cancel protocol.
