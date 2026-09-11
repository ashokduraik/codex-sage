# Architecture decision records

| ADR | Title | Status |
| --- | --- | --- |
| [0000](./0000-plain-javascript.md) | Plain JavaScript application code | Accepted |
| [0001](./0001-mongodb-replica-set.md) | MongoDB 8 replica set as the datastore | Accepted |
| [0002](./0002-fastify-api-v1.md) | Fastify 5 and `/api/v1` | Accepted |
| [0003](./0003-mongoose-and-gridfs.md) | Mongoose for documents, GridFS for accepted bytes | Accepted |
| [0004](./0004-mongo-jobs-no-redis.md) | Jobs in MongoDB, no Redis/BullMQ | Accepted |
| [0005](./0005-pino-logging.md) | Pino for structured logs | Accepted |
| [0006](./0006-zod-validation.md) | zod for env and request validation | Accepted |
| [0007](./0007-argon2id-jwt.md) | argon2id passwords and JWT access tokens | Accepted |
| [0008](./0008-httponly-refresh-cookie.md) | httpOnly refresh cookie and CSRF double-submit | Accepted |
| [0009](./0009-integration-tests-external-mongo.md) | Integration tests on the external replica set | Accepted |
| [0010](./0010-structured-error-envelope.md) | Structured error envelope and correlation IDs | Accepted |
| [0011](./0011-startup-bootstrap-seed.md) | Startup bootstrap seed (no public signup) | Accepted |
| [0012](./0012-refresh-token-rotation.md) | Refresh-token rotation with strict reuse detection | Accepted |
| [0013](./0013-admin-mediated-password-reset.md) | Admin-mediated password reset (no public token flow) | Accepted |
| [0014](./0014-cross-tenant-404.md) | Cross-tenant resource misses return 404 | Accepted |
| [0015](./0015-global-route-authorization.md) | Global route authorization via config declaration | Accepted |
| [0016](./0016-audit-write-best-effort.md) | Audit writes are always best-effort | Accepted |

One decision = one ADR. Accepted ADRs are immutable; supersede with a new number rather
than rewriting history.
