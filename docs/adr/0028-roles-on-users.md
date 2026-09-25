# ADR 0028 — Org roles and project access mode live on users

- Status: Accepted
- Date: 2026-09-26
- Deciders: product owner

## Context

Phase 06 stored org `roleIds` and (later) `projectAccessMode` on a separate
`memberships` collection, one row per `(orgId, userId)`. In this product a user
document is already tenant-scoped (`orgId` on the base schema, unique
`{ orgId, email }`). Membership was 1:1 with the user. HTTP never exposed a
memberships API — create/patch user already carried `roleIds`.

Keeping a second collection added a two-write transaction on user create/remove,
an extra lookup on login and project ACL, and a fixture every integration test
had to seed.

## Decision

- Store `roleIds` (ObjectId array, min 1) and `projectAccessMode`
  (`all` | `selected` | `none`, default `selected`) on the `users` document.
- Delete the `memberships` collection and `Membership` model.
- Bootstrap writes the default admin with `roleIds: [org_admin]` and
  `projectAccessMode: 'all'` on the same user insert.
- Admin-created users still default to `projectAccessMode: 'selected'`.
- Public user/auth JSON is unchanged (no `projectAccessMode` on DTOs).
- No data copy job. Local Mongo is wipe/re-seed only.

## Consequences

- Create/remove user is a single user write (plus session revoke on remove).
- Login, `/auth/me`, last-admin, role-in-use, and project ACL read `user.roleIds`
  / `user.projectAccessMode`.
- Soft-deleting a user hides their roles; there is no independent membership
  tombstone.
- A later “one person, many orgs” model would need a new join (or global users).

## Alternatives considered

- **Keep memberships for `projectAccessMode` only** — rejected; that field is
  also 1:1 with the user today and has no public HTTP setter.
- **Copy existing memberships onto users** — rejected; pre-production local
  data is wipe/re-seed.
