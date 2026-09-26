# ADR 0029 — Repository credential lives on the connection

- Status: Accepted
- Date: 2026-09-26
- Deciders: product owner

## Context

Phase 31 stored the encrypted PAT in a separate `repositoryCredentials`
collection and pointed `repositoryConnections.credentialId` at the active row.
Replace soft-deleted the prior credential and inserted a new one. One project
already has one active connection, and that connection has at most one active
secret.

A second collection added a two-write attach/replace path and a fixture every
repository test had to seed, without a public credential list API.

## Decision

- Store the encrypted PAT as optional nested `credential` on the
  `repositoryConnections` document: `{ ciphertext, iv, authTag, keyId,
  credentialKind, lastValidatedAt, revokedAt }`.
- `credential` is null when attach stored no token (public repo).
- Replace overwrites the nested object in place. No historical ciphertext.
- Revoke soft-deletes the connection (`status: 'D'`) and leaves `credential`
  as-is on the tombstone.
- Delete the `repositoryCredentials` collection and `RepositoryCredential`
  model. No data copy. Local Mongo is wipe/re-seed only.
- Public connection JSON is unchanged (still no ciphertext fields).
- At-rest encryption stays AES-256-GCM (ADR 0024).

## Consequences

- Attach with a token is one connection insert. Replace is one connection
  update of `credential`.
- Decrypt reads `connection.credential` in memory; list/GET DTOs still omit it.
- Soft-deleting a connection hides the secret with the row. There is no
  independent credential tombstone or rotation history.

## Alternatives considered

- **Keep a credential collection for rotation history** — rejected; replace
  overwrites and retention does not require prior ciphertext.
- **Copy existing `repositoryCredentials` rows onto connections** — rejected;
  pre-production local data is wipe/re-seed.

## Escape hatch

Reintroduce a credential collection (or a history array on the connection) if
product later needs retained ciphertext after replace.
