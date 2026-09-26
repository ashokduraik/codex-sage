# Permission catalog

Single source of truth for organization-scoped permissions. Implemented in
`backend/src/modules/access/permissions.js`. The UI renders `label` and
`description` only; `key` is an opaque value used when editing roles.

## Groups

| Group | Key | Label |
|---|---|---|
| Organization | `org.view` | View organization |
| Organization | `org.manage` | Manage organization |
| Users and roles | `users.manage` | Manage users |
| Users and roles | `roles.manage` | Manage roles |
| Projects | `projects.create` | Create projects |
| Projects | `projects.view` | View projects |
| Projects | `projects.update` | Update projects |
| Projects | `projects.delete` | Delete projects |
| Sources | `sources.upload` | Upload sources |
| Sources | `repos.connect` | Connect repositories |
| Sources | `sources.preview` | Preview sources |
| Knowledge | `knowledge.trigger` | Trigger knowledge updates |
| Knowledge | `knowledge.view` | View knowledge |
| Knowledge | `knowledge.browse` | Browse knowledge |
| Chat | `chat.ask` | Ask questions |
| Chat | `conversations.view` | View conversations |
| Chat | `conversations.archive` | Archive conversations |
| Chat | `conversations.search` | Search conversations |
| Search | `search.run` | Run search |
| Administration | `settings.manage` | Manage settings |
| Administration | `audit.view` | View audit log |
| Administration | `usage.view` | View usage |
| Notifications | `notifications.view` | View notifications |

## Roles

Every role stores `permissions[]` on the document, validated against this catalog
at startup and on create/update. Seed creates one role with `code: "ADMIN"` and
every catalog key. Additional roles are created by admins (ADR 0032).

## Cache staleness

Role id → permission arrays are cached in-process for **30 seconds**
(`RBAC_ROLE_CACHE_TTL_SECONDS`). `invalidateRole` / `invalidateOrganization` clear the
local process immediately after a role write. Other API processes converge within the
TTL. User status and membership are **not** cached (Phase 07 principal resolution).

## API

- `GET /api/v1/permissions` — full catalog; requires `roles.manage`
- `GET /api/v1/auth/me` — includes the caller's effective `permissions[]`
