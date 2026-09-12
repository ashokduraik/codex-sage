# Phase 18 follow-up — routes that must use `requireProjectPermission`

Every future **`:projectId`** route must declare:

- `config.routeAccess: 'authenticated'` (not org-only `requiredPermissions` for the
  project-scoped permission), and
- `preHandler: requireProjectPermission('<permission>')` (or `any` mode for members).

Do **not** rely on the global authorize hook alone for project visibility — that hook
only checks organization roles (ADR 0015 / ADR 0020).

## Already guarded (Phase 17 + 18)

| Route | Permission |
| --- | --- |
| `GET /projects/:projectId` | `projects.view` |
| `PATCH /projects/:projectId` | `projects.update` |
| `GET`/`PATCH /projects/:projectId/settings` | `settings.manage` |
| `POST .../archive`, `.../restore` | `projects.update` |
| `GET .../deletion-preview`, `DELETE /projects/:projectId` | `projects.delete` |
| `GET`/`POST`/`DELETE /projects/:projectId/members…` | `projects.update` **or** `users.manage` |

## Must guard when implemented

| Phase | Examples |
| --- | --- |
| 23+ | Upload / source validation under `/projects/:projectId/...` |
| 24 | Upload persistence |
| 30 | Repository probe |
| 37–38 | Knowledge / search project routes |
| 41 | Conversations / chat (`chat.ask`, conversation permissions) |
| 50 | Chat message path (calls `resolveProjectPermissions` every message) |

`POST /projects` and `GET /projects` stay organization-scoped (`projects.create` /
`projects.view`); the list applies the accessible-project filter from the same resolver.
