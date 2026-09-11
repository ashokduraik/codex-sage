# ADR 0005 — Pino for structured logs

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (plan README §2)

## Context

API and worker processes need leveled, structured logs for support and ops, with secrets
kept out of log lines. Fastify integrates cleanly with Pino; Phase 01 already ships a
logger module.

## Decision

- **Pino** is the structured logging library for Node processes.
- Logs are **JSON** with levels (`debug` / `info` / `warn` / `error`); development may be
  more verbose than production via config (`LOG_LEVEL` and related env).
- Sensitive fields (tokens, cookies, authorization, passwords) are **redacted**; Phase 02
  tightened request serializers.

**Timing:** Retrospective — logger already in the Phase 01 scaffold; redaction refined in
Phase 02.

## Consequences

- Correlation and request context attach to log bindings rather than ad-hoc `console.log`.
- Production posture minimizes noise; debug stays available when configured.
- A second logging stack is not introduced casually.

## Alternatives considered

- **`console` / util.debuglog only** — rejected; no consistent structure or levels.
- **Winston** — rejected; Pino is already installed and Fastify-native.
- **Unstructured free-form strings** — rejected; support needs queryable fields.

## Escape hatch

Supersede if a required sink or format cannot be met with Pino transports; migrate
deliberately rather than dual-logging forever.
