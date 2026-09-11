# ADR 0009 — Integration tests on the external replica set

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (plan README §2)

## Context

Integration tests must exercise real MongoDB behavior (including replica-set transactions)
without writing into the development database. Plan decision **D16** rejects
`mongodb-memory-server` so tests match the production topology operators actually run.

## Decision

- Integration tests use the **same external MongoDB 8 replica set** as development.
- Tests use a **separate database name**: `codex_sage_test`.
- **`mongodb-memory-server` is not used.**

**Timing:** Intent aligned with the **Phase 03** harness (and any later integration
suites that follow the same rule).

## Consequences

- Developers and CI need a reachable replica set (URI via env); tests fail closed if it
  is missing rather than spinning up an in-memory substitute.
- Test cleanup must not touch the development database named in normal `MONGODB_URI`.
- Indicative package lists must not recommend `mongodb-memory-server`.

## Alternatives considered

- **`mongodb-memory-server`** — rejected under D16; topology and transaction behavior diverge.
- **Shared development database for tests** — rejected; risk of wiping or polluting local data.
- **Mocking the driver entirely for “integration” tests** — rejected for data-layer confidence.

## Escape hatch

Supersede only if an ephemeral replica-set fixture becomes mandatory for CI and is
documented as equivalent to the external topology; do not silently reintroduce memory
servers for convenience.
