# ADR 0011 — Startup bootstrap seed (no public signup)

- Status: Accepted
- Date: 2026-09-11
- Deciders: product owner (plan Phase 06 review)

## Context

Decision **D6** removes public self-registration. The product still needs a first organization,
built-in roles, and an administrator before Phase 07 authentication can be exercised. An earlier
draft used a CLI (`npm run bootstrap`) plus `BOOTSTRAP_*` environment variables.

## Decision

- The API process runs an **idempotent transactional seed** after Mongo connects and before
  `listen` (`runBootstrapSeed`).
- Default organization and admin identity are **named constants** in the identity module — not
  environment variables and not a CLI.
- The worker process does **not** seed.
- No unauthenticated HTTP route creates an organization.
- Seed logging: exactly one `info` success line every boot (`created` | `already_present`);
  per-step detail only at `debug`. Never log email, password, or `.env` values.
- Seed failure exits the process before listen (`BOOTSTRAP_FAILED`).

## Consequences

- First tenant appears automatically on API start when rows are missing.
- Changing default identity is a code change (or a later admin/platform API), not an env flip.
- Onboarding a second organization is out of scope for this ADR (later platform-admin path).
- Phase 07 extends the **startup seed** (not a CLI) if the first admin needs a password.

## Alternatives considered

- **CLI seed with `BOOTSTRAP_*` env** — rejected; operators already start the API, and identity
  defaults do not need to differ per environment for MVP.
- **Invite-only signup HTTP endpoint** — deferred; conflicts with D6 for unauthenticated create.
- **Platform-admin API for tenant creation** — deferred to a later phase for tenant two+.

## Escape hatch

Supersede if multi-tenant onboarding requires operator-supplied identity per install; introduce
validated env (or a platform-admin API) via a new ADR without reintroducing public signup.
