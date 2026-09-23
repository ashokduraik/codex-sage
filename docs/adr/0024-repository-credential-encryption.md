# ADR 0024 — Repository credential encryption

- Status: Accepted
- Date: 2026-09-23
- Deciders: product owner (Phase 30)

## Context

Repository PATs must be encrypted at rest and decrypted only in memory (backend §19,
§148). Phase 30 lands the helper before Phase 31 stores any secret. No KMS is in the
accepted stack.

## Decision

- Use Node `crypto` AES-256-GCM via `backend/src/platform/secretCrypto.js`.
- The key is `REPO_CREDENTIAL_ENCRYPTION_KEY` (32-byte base64). Startup fails if it is
  missing or the wrong length (tests may default a local key).
- A `keyId` (`REPO_CREDENTIAL_KEY_ID`, default `k1`) is stored with each ciphertext so
  rotation can find old values.
- No external KMS in this slice.

## Consequences

- Phase 31 persist/replace/revoke call only this helper.
- Key rotation is a later operational change: introduce a new key id, re-encrypt, then
  drop the old key.

## Alternatives considered

- **External KMS** — rejected for this slice; adds a vendor the stack ADRs do not name.
- **Application-level XOR / homemade cipher** — rejected; GCM is the Node built-in AEAD.

## Escape hatch

Introduce a KMS wrapper behind the same `encryptSecret` / `decryptSecret` surface if a
later ADR requires it. Old rows remain readable via `keyId`.
