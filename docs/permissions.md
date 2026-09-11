# Permission catalog

Single source of truth for organization-scoped permissions. Implemented in
`backend/src/modules/authorization/permissionCatalog.js` (solution §8.2). The UI renders
`label` and `description` only; `key` is an opaque value used when editing roles.

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

## Built-in role maps (code-resolved)

Built-in roles store empty `permissions[]` in Mongo. Effective permissions come from
`backend/src/modules/authorization/builtInRolePermissions.js`:

| Role | Permissions |
|---|---|
| `org_admin` | Every catalog key |
| `viewer` | View + search + `chat.ask` (see Phase 09 decision) |
| `member` | Viewer set + `conversations.archive` + `sources.upload` |
| `project_admin` | Member set + project create/update/delete, `repos.connect`, `knowledge.trigger` |

Custom roles persist their own `permissions[]`, validated against this catalog at
startup and when Phase 11 writes roles.

## Cache staleness

Role id → permission arrays are cached in-process for **30 seconds**
(`RBAC_ROLE_CACHE_TTL_SECONDS`). `invalidateRole` / `invalidateOrganization` clear the
local process immediately after a role write. Other API processes converge within the
TTL. User status and membership are **not** cached (Phase 07 principal resolution).

## API

- `GET /api/v1/permissions` — full catalog; requires `roles.manage`
- `GET /api/v1/auth/me` — includes the caller's effective `permissions[]`
