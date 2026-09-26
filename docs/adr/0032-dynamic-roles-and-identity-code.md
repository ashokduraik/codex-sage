# ADR 0032 — Dynamic org roles and identity `code`

- Status: Accepted
- Date: 2026-09-26
- Deciders: product owner

## Context

Phase 11 locked four built-in roles (`org_admin`, `project_admin`, `member`, `viewer`)
with code-resolved permissions and `409 BUILT_IN_ROLE_IMMUTABLE` on name, permissions,
or delete. The product now needs an open list of roles: seed only an administrator
role, and let admins create any number of roles from the permission catalog.

Bootstrap still needs a stable handle after `builtInKey` is removed.

## Decision

- Remove `isBuiltIn` and `builtInKey` from `roles`. Every role stores `permissions[]`.
- Add immutable unique `code` (`[A-Z0-9_-]{2,64}`, uppercase, set on create only) to
  `organizations`, `users`, and `roles`.
- Seed one role with `code: "ADMIN"` and every catalog permission. Do not seed Viewer,
  Member, or Project Admin. If `ADMIN` is later soft-deleted, startup does not recreate it.
- Seeded org `code` is `DEFAULT_ORG`. Seeded admin user `code` is `ADMIN`.
- Duplicate active `code` returns `409 IDENTITY_DUPLICATE_*_CODE`.
- No leftover-document backfill. Local/dev Mongo is recreated by seed.

## Consequences

- Role columns in the admin matrix are whatever roles exist in the org.
- Tests and E2E must create extra roles in the UI or fixtures; they are not seeded.
- `LAST_ADMIN_REQUIRED` still applies to users who hold `users.manage`, not to role type.

## Alternatives considered

- Keep `isBuiltIn` as a bootstrap pointer — rejected; product asked to drop the fields.
- Look up the admin role by name — rejected; name is editable.

## Escape hatch

Supersede if a later tenant-onboarding path needs a different seed sentinel or
`code` on additional master collections.
