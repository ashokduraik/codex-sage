# codex-sage

Multi-tenant SaaS enterprise software intelligence platform: connect or upload project
source and documentation → build project knowledge → grounded chat answers with
inspectable evidence.

## Prerequisites

- **Node.js >= 26**
- **npm** (bundled with Node.js)
- **MongoDB 8 replica set** for local development — see [docs/mongodb-setup.md](./docs/mongodb-setup.md)

## Quick start

```bash
npm run setup   # check Node, bootstrap .env files, install deps
npm run dev     # backend API on :3000 + frontend Vite (proxies /api → :3000)
```

## Commands

All root commands operate on **both** `backend/` and `frontend/`.

| Command | What it does |
| --- | --- |
| `npm run setup` | Verify Node >= 26, copy `.env.example` → `.env` only if missing, then install |
| `npm run install` | `npm ci` per app when a lockfile exists; otherwise `npm install` |
| `npm run dev` | Dev servers: backend (`tsx watch`, **:3000**) and frontend (Vite; `/api` proxied to **:3000**) |
| `npm run build` | Production builds: backend (`tsup`) and frontend (`vite build`) |
| `npm run start` | Production run: backend (`node dist/index.js`) and frontend (`vite preview`); requires a prior build |
| `npm run test` | Vitest with coverage in both apps |
| `npm run lint` | ESLint + `tsc --noEmit` in both apps |
| `npm run clean` | Remove `node_modules`, `dist`, and `coverage` in both apps (prompts; use `npm run clean -- --yes` to skip) |

You can also run the scripts directly:

```bash
bash scripts/setup.sh
bash scripts/dev.sh
bash scripts/clean.sh --yes
```

## Layout

- `backend/` — Node.js API + workers (Fastify)
- `frontend/` — React app (Vite)
- `scripts/` — root setup / install / run helpers
- `docs/` — architecture, local MongoDB setup, and ADRs

See [AGENTS.md](./AGENTS.md) for repo conventions.
