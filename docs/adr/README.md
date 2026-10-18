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
| [0012](./0012-refresh-token-rotation.md) | Refresh-token rotation with strict reuse detection | Superseded by 0030 |
| [0013](./0013-admin-mediated-password-reset.md) | Admin-mediated password reset (no public token flow) | Accepted |
| [0014](./0014-cross-tenant-404.md) | Cross-tenant resource misses return 404 | Accepted |
| [0015](./0015-global-route-authorization.md) | Global route authorization via config declaration | Accepted |
| [0016](./0016-audit-write-best-effort.md) | Audit writes are always best-effort | Accepted |
| [0017](./0017-frontend-server-state-http-transport.md) | Frontend server-state and HTTP transport | Accepted |
| [0018](./0018-spa-served-from-fastify-static.md) | SPA served from Fastify static (same process) | Accepted |
| [0019](./0019-frontend-session-boot-and-lifetime.md) | Frontend session boot and lifetime | Accepted |
| [0020](./0020-inaccessible-project-404.md) | Inaccessible same-org projects return 404 | Accepted |
| [0021](./0021-project-acl-version-cache.md) | Project ACL cache invalidated via organization.aclVersion | Accepted |
| [0022](./0022-project-job-locks.md) | Per-project job serialization via lease-based lock collection | Accepted |
| [0023](./0023-job-retry-same-document.md) | Retry reuses the same Job document; reingest creates a new one | Accepted |
| [0024](./0024-repository-credential-encryption.md) | Repository credential encryption (AES-256-GCM) | Accepted |
| [0025](./0025-provider-inference-from-url.md) | Provider inference from repository URL | Accepted |
| [0026](./0026-repository-sync-archive-adapter.md) | Repository sync uses the provider archive API | Accepted |
| [0027](./0027-conversation-owner-privacy.md) | Conversations are private to the owner until explicit share | Accepted |
| [0028](./0028-roles-on-users.md) | Org roles and project access mode live on users | Accepted |
| [0029](./0029-embed-repository-credential.md) | Repository credential lives on the connection | Accepted |
| [0030](./0030-login-session-embedded-tokens.md) | Login session with embedded refresh-token hashes | Accepted |
| [0031](./0031-http-multi-collection-transactions.md) | HTTP APIs that write two domain collections use a transaction | Accepted |
| [0032](./0032-dynamic-roles-and-identity-code.md) | Dynamic org roles and identity `code` | Accepted |
| [0033](./0033-qwen-artifact-and-context-budget.md) | Ollama env, live digest, and context-budget numbers | Superseded by 0034 |
| [0034](./0034-openai-compatible-llm.md) | OpenAI-compatible LLM env, probe, and artifact id | Accepted (tokenizer clause → 0038) |
| [0035](./0035-langgraph-mongo-checkpointer.md) | LangGraph in-process with Mongo chat checkpoints | Accepted |
| [0036](./0036-module-file-action-api-paths.md) | Module / file / action API paths | Accepted |
| [0037](./0037-chat-sse-abort-on-disconnect.md) | Chat SSE abort on client disconnect | Accepted |
| [0038](./0038-qwen3-tokenizer-parity.md) | Qwen3 Node tokenizer for context budget | Accepted |
| [0039](./0039-conversational-and-general-replies.md) | Conversational and general replies in grounded chat | Accepted |

One decision = one ADR. Accepted ADRs are immutable; supersede with a new number rather
than rewriting history.
