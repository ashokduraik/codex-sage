# ADR 0039 — Conversational and general replies in grounded chat

- Status: Accepted
- Date: 2026-10-18
- Deciders: product owner

## Context

The LangGraph chat workflow (ADR 0035) only routed UNDERSTAND to `retrieve` or
`abstain_early`. Greetings ("hi"), identity questions ("who are you"), and clearly
unrelated general questions ("what is the capital of France?") had no project
evidence, so the tool loop abstained. That felt broken for normal conversation while
the product still must not invent project facts.

Industry RAG agents use an intent-router pattern: classify first, then either a
lightweight chat node or the retrieval path
([LangGraph agentic RAG](https://docs.langchain.com/oss/python/langgraph/agentic-rag)).

## Decision

- Extend UNDERSTAND `route` with `converse`, `general_knowledge`, and
  `project_overview` (graph state only — no Mongo schema change).
- **Tie-break:** if a question could be about this project's code, docs, libraries,
  or domain, use `retrieve`. Mixed messages ("hi, where is login?") also use
  `retrieve`.
- **`converse` / `general_knowledge`:** skip tools and VERIFY; stream a short reply
  via `streamText` (`purpose: 'direct_reply'`, thinking off). Persist
  `messageStatus: 'completed'`, `supportLevel: null`, `evidence: null`.
- **Persona:** no assistant product name — "the project assistant for \<project name\>".
- **`general_knowledge`:** prepend a deterministic Markdown note saved in content:
  `_General answer, not based on this project's sources._`
- **`project_overview`:** retrieve first; if no evidence, fall back to a direct reply
  from the saved project description (with
  `_Based on the project's saved description, not indexed sources._`). Empty
  description → fixed suggestion copy, no LLM.
- Stage `composing_reply` ("Writing a reply…") for the direct-reply path.

## Consequences

- Greetings and off-topic questions no longer abstain.
- Direct replies stay visually distinct from grounded answers (null supportLevel,
  no Sources; general answers carry an in-content note).
- Project-specific questions remain evidence-backed or abstain as before.
- Eval cases use `expect: 'direct_reply'` plus guard cases that must still `answer`.

## Alternatives considered

- Regex greeting fast path — rejected; fragile across languages and mixed messages.
- Separate intent-classifier LLM call — rejected; UNDERSTAND already classifies.
- New `supportLevel: 'conversational'` enum — deferred; null supportLevel already
  renders as a plain completed reply without a schema change.
- Answering overview questions from description only — rejected; retrieve first.

## Escape hatch

Remove the new UNDERSTAND routes and graph nodes; greetings return to abstain.
