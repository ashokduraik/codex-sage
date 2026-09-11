# Backend (Node API + workers)

## First run

1. Ensure a MongoDB 8 replica set is reachable (`MONGODB_URI` in `.env`).
2. Start the API (`npm run dev` or `npm start` from `backend/`).
3. After connect, the process syncs indexes (non-production) and runs the idempotent
   bootstrap seed. Watch for `bootstrap seed succeeded` at `info`.
4. Set `LOG_LEVEL=debug` in `.env` for per-step seed logs. Defaults are in
   `src/modules/identity/bootstrapDefaults.js` — not env vars (ADR 0011).

There is no CLI bootstrap command. Login arrives in Phase 07; the seeded admin starts as
`invited` without a password hash.
