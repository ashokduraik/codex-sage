# Phase 14 — Frontend auth slice; remove self-registration

- **Layer:** FE
- **Depends on:** Phase 13 (API client, session holder, refresh coordinator)
- **Unblocks:** Phase 15, 16, 19 and every later frontend slice that renders protected content
- **Size:** 1–2 days
- **Requirements covered:** `frontend/requirments.md` §7A (authentication and session), §64 and
  §90 (error states), §88 (empty states), §105.31 (session expiry must gate protected content);
  `backend/requirments.md` §5 (user management), §105 (error correlation);
  `backend/solution.md` §8.3 (auth); decision **D6** (invite/seed only, no self-registration)

## 1. Goal

After this phase the frontend signs in against the **real backend**. `AuthContext` no longer
fabricates a user from an email address: it calls the login endpoint, reads the signed-in user
from the current-user endpoint through React Query, and clears everything when the session ends.
`ProtectedRoute` gates on that real state, a mid-session expiry returns the user to sign-in
without flashing protected content, and `authReturnTo` brings them back to where they were.

Self-registration is gone. `RegisterPage.tsx`, its test, its route and its i18n keys are
deleted, and the sign-in screen explains that accounts are created by an administrator.
Password reset stays: `ForgotPasswordPage` and `ResetPasswordPage` call the real endpoints.

You can see it working by signing in with a seeded account, reloading the page (still signed
in), letting the session expire (returned to sign-in, then back to the original page after
re-authentication), and visiting `/register` (a 404, not a form).

## 2. Why this phase is here

Every protected screen in Phases 15 onward needs a real identity and a real 401 story; wiring
them against a mock session would mean rewriting each one later. It sits directly after
Phase 13 because the session holder and the refresh coordinator live in the API client — this
phase is the layer that supplies and clears the token and reacts when the client gives up.

D6 is applied here rather than later because `RegisterPage` is the largest mock-auth surface
(308 lines plus a 115-line test) and leaving it alive means maintaining an OTP flow no backend
endpoint supports.

## 3. Scope

### In scope

- Rewrite `features/auth/AuthContext.tsx` onto the real endpoints: login, current user, refresh
  (delegated to Phase 13's coordinator), logout.
- Token storage strategy, recorded as a decision with its trade-offs (§4.2).
- React Query hooks under `features/auth/api/` for every auth call.
- `ProtectedRoute`: gate on the real loading / authenticated state; no protected render before
  the session is resolved.
- Session-expiry handling: the API client clears the session, the context stops treating the
  user as signed in, the router returns to `/login?returnTo=…`.
- `LoginPage`, `ForgotPasswordPage`, `ResetPasswordPage` on the real endpoints with inline
  loader, disabled controls, `aria-busy`, and `role="alert"` errors from `error.message`.
- Delete `RegisterPage.tsx`, `RegisterPage.test.tsx`, the `/register` route, the register-only
  i18n keys, and the mock Google sign-in path (`loginWithGoogle`, `GoogleIcon.tsx`).
- Remove all mock auth state and update the shared test helpers.

### Out of scope (owner phase)

- Admin-initiated password reset and the admin user list — **Phase 15**.
- Any admin/audit screen — **Phases 15, 16**.
- Password change for the signed-in user (frontend §7A) — not covered by an approved endpoint;
  raised in section 12 rather than invented.
- Deleting `shared/mock-data/` itself — D7: it goes when nothing imports it (a later phase).
- SSO, OAuth or any provider the backend does not support (frontend §7A is explicit).

## 4. Design

### 4.1 Context shape

The current `AuthContextValue` exposes eleven members, six of which exist only for the mock
(`register`, `verifyOtp`, `resendOtp`, `loginWithGoogle`, `pendingEmail`, plus the local
`AuthUser` builder). The new surface is:

```text
user             : AuthUser | null      from the current-user query
isAuthenticated  : boolean              derived: a user is loaded
isLoadingAuth    : boolean              the current-user query has not settled
authChecked      : boolean              the first resolution has happened
login(email, password)                  mutation
logout(shouldRedirect?)                 mutation, then hard cache reset
requestPasswordReset(email)             mutation
completePasswordReset(token, password)  mutation
```

`isLoadingAuth` and `authChecked` become real values instead of the current constants
(`useState(false)` / `useState(true)`), which is what makes §105.31 enforceable.

`AuthUser` changes from the mock shape (`full_name`, `role: 'admin' | 'user'`) to whatever the
Phase 07 current-user response returns. The fields the UI needs are id, display name, email,
and the caller's permissions — the permission list is what Phase 15 uses to decide which admin
controls to render. Whether it arrives on the user object or on a separate endpoint is open
(section 12).

### 4.2 Token storage — decision required

| Option | Pros | Cons |
|---|---|---|
| **A. In-memory access token + httpOnly refresh cookie** | Access token is unreachable from XSS; refresh survives reload without touching storage; matches `solution.md` §8.3 wording | Needs CORS credentials settled; a reload always costs one refresh round-trip before the app renders |
| **B. Access + refresh token in `localStorage`** | Simplest; survives reload with no extra call | Both tokens readable by any script on the origin; a single XSS is a full account takeover |
| **C. Access token in memory, refresh token in `localStorage`** | Slightly narrower blast radius than B | Still stores the long-lived credential in script-readable storage |

**Proposed: option A.** It is the only option where the long-lived credential is not readable
by JavaScript, and `solution.md` §8.3 already names "httpOnly cookie or rotating store". Under
A, boot does: call the refresh endpoint once → on success store the access token in memory and
run the current-user query → on failure render the signed-out state. `authChecked` flips only
after that sequence settles. **This is Phase 07's decision to confirm; do not implement until it
is.** If Phase 07 leaves it open, stop and ask (section 12, item 1).

Whatever is chosen, the mock `localStorage` key `codex-sage-auth` and the exported
`AUTH_STORAGE_KEY` are removed — no user object is ever persisted client-side.

### 4.3 Session expiry

Phase 13's client already clears the session and notifies subscribers when a refresh fails.
This phase subscribes once, at the provider, and on notification:

```text
1. Remove the current-user query data and cancel in-flight queries.
2. Clear the whole React Query cache so no protected data survives the transition
   (frontend §105.31: do not show project data while signed out).
3. Navigate to `/login?returnTo=<current path+search>`.
4. Show a localized "your session ended" message on the sign-in screen.
```

Step 3 reuses the existing `safeReturnTo()` helper in `features/auth/authReturnTo.ts`, which
already strips token-bearing query parameters and rejects protocol-relative paths. It is kept
as-is; only its call sites change. `ProtectedRoute` renders the fallback spinner while
`isLoadingAuth || !authChecked`, so protected children never mount on an unresolved session.

### 4.4 The three auth screens

Each screen keeps its layout and moves its submit path onto a mutation hook:

- **`LoginPage`** — `useLogin()`. Errors render in the existing `role="alert"` block, sourced
  from `ApiError.message` with `t('errors.unexpected')` as the fallback, plus the correlation ID
  when present (§90). The Google button, the `or` divider and the "Don't have an account?
  Create one" footer are removed; the footer becomes a localized line stating that accounts are
  created by an administrator and pointing at the password-reset link.
- **`ForgotPasswordPage`** — `useRequestPasswordReset()`. Keeps the current
  enumeration-safe behaviour: the success panel shows regardless of outcome. A transport
  failure still needs feedback, so a network/`5xx` failure shows the inline error instead of a
  false success; a `404`-style "no such user" answer must not be distinguishable.
- **`ResetPasswordPage`** — `useCompletePasswordReset()`. Keeps the missing-token branch and
  the local mismatch check, and surfaces backend failures (expired token, already used, weak
  password) from `error.message`.

All three already set `disabled` and `aria-busy` on their submit buttons and disable their
inputs while in flight; that behaviour is preserved and re-asserted in tests.

### 4.5 Removals (decision D6 and D7)

Deleted files: `RegisterPage.tsx`, `RegisterPage.test.tsx`, `GoogleIcon.tsx`. Deleted route:
`/register` in `app/routes.tsx`. Deleted exports from `features/auth/index.ts`: `RegisterPage`,
`GoogleIcon`, `AUTH_STORAGE_KEY`.

i18n keys removed from `shared/i18n/locales/en.json` (verified as used only by the deleted
register and Google paths): `auth.createAccount`, `auth.registerSubtitle`, `auth.verifyEmail`,
`auth.verifySubtitle`, `auth.otpCode`, `auth.signUp`, `auth.alreadyHaveAccount`,
`auth.dontHaveAccount`, `auth.createOne`, `auth.creatingAccount`, `auth.createAccountAction`,
`auth.verify`, `auth.verifying`, `auth.registrationFailed`, `auth.resend`, `auth.resendCode`,
`auth.resendFailed`, `auth.codeResent`, `auth.codeSentTitle`, `auth.codeSentDescription`,
`auth.didntReceiveCode`, `auth.otpInvalid`, `auth.continueWithGoogle`, `auth.or`, and the
unused `auth.oauth*` group. `auth.fullName` is **kept** — `features/admin/AdminUsers.tsx` uses
it. New keys: an accounts-are-administrator-created line, a session-expired line, and a
signed-out confirmation.

**Mock exports that stop being used by this phase:** `uid` from `@/shared/mock-data/mockData`
(the only mock import in `features/auth/`). Nothing else in `features/auth/` touches the mock
module after this change, so the feature folder is mock-free. `AppDataProvider` stays in
`app/providers.tsx` for the features that still need it.

## 5. Data model changes

**None.** Frontend-only phase; no collection, field or index changes.

## 6. API contract — PROPOSED (needs approval before implementation)

Endpoints **consumed**, not defined here. Phase 07 (`/auth/*`) and Phase 08 (password
lifecycle) own the authoritative shapes; the table records what this slice needs from them.

| Method & path | Used by | Needs from the response |
|---|---|---|
| `POST /api/v1/auth/login` | `useLogin` | access token; user identity (or a follow-up current-user call) |
| `GET /api/v1/auth/me` | `useCurrentUser` | id, display name, email, and the caller's permissions |
| `POST /api/v1/auth/refresh` | Phase 13 coordinator + boot | a fresh access token, or `401` |
| `POST /api/v1/auth/logout` | `useLogout` | `204`; invalidates the refresh credential server-side |
| `POST /api/v1/auth/password-reset/request` | `ForgotPasswordPage` | same response whether or not the email exists |
| `POST /api/v1/auth/password-reset/confirm` | `ResetPasswordPage` | success, or an error code for expired / used / weak |

Frontend-visible contract details this phase depends on:

- Errors use the standard envelope `{ error: { code, message, details? } }`; the UI renders
  `message` and never composes its own text (`ui-action-feedback.mdc`).
- Error codes this slice must be able to distinguish, by code rather than by copy:
  invalid credentials, account disabled, rate limited (`429`, with `Retry-After` when sent),
  reset token expired, reset token already used, password policy rejected.
- A `401` on any protected request means "session gone" after Phase 13's single retry. A `403`
  means "signed in, not permitted" and must never sign the user out.
- The correlation ID (Phase 13 §4.3) is displayed alongside sign-in and reset failures when the
  backend provides one (frontend §90, §105.38).

## 7. Configuration & environment variables

**No new variables.** `VITE_API_BASE_URL` from Phase 13 is the only one this slice reads, and
it is read through `shared/api`, never directly. If option A in §4.2 is confirmed and the API is
served cross-origin, a credentialed-request setting may be needed — that is a Phase 13 change,
not a new frontend variable. Mirror any `.env.example` edit into `.env` as usual.

## 8. Files to create or change

| Path | Purpose |
|---|---|
| `frontend/src/features/auth/AuthContext.tsx` | **Rewrite:** real endpoints, React Query, session-loss subscription |
| `frontend/src/features/auth/AuthContext.test.tsx` | **Rewrite:** login, boot, expiry, logout |
| `frontend/src/features/auth/api/authApi.ts` | **New:** typed calls over `shared/api` |
| `frontend/src/features/auth/api/authApi.test.ts` | **New:** request shapes and error mapping |
| `frontend/src/features/auth/api/useLogin.ts` | **New:** login mutation |
| `frontend/src/features/auth/api/useCurrentUser.ts` | **New:** current-user query |
| `frontend/src/features/auth/api/useLogout.ts` | **New:** logout mutation + cache reset |
| `frontend/src/features/auth/api/usePasswordReset.ts` | **New:** request + confirm mutations |
| `frontend/src/features/auth/ProtectedRoute.tsx` | **Change:** gate on resolved auth state |
| `frontend/src/features/auth/ProtectedRoute.test.tsx` | **New:** loading, signed-out, signed-in |
| `frontend/src/features/auth/LoginPage.tsx` | **Change:** real login; remove Google and register footer |
| `frontend/src/features/auth/LoginPage.test.tsx` | **Rewrite:** success, failure, loader, expiry notice |
| `frontend/src/features/auth/ForgotPasswordPage.tsx` | **Change:** real request endpoint |
| `frontend/src/features/auth/ForgotPasswordPage.test.tsx` | **Extend:** transport failure path |
| `frontend/src/features/auth/ResetPasswordPage.tsx` | **Change:** real confirm endpoint |
| `frontend/src/features/auth/ResetPasswordPage.test.tsx` | **Extend:** expired / used token |
| `frontend/src/features/auth/RegisterPage.tsx` | **Delete** (D6) |
| `frontend/src/features/auth/RegisterPage.test.tsx` | **Delete** (D6) |
| `frontend/src/features/auth/GoogleIcon.tsx` | **Delete** (no backend provider) |
| `frontend/src/features/auth/index.ts` | **Change:** drop deleted exports |
| `frontend/src/app/routes.tsx` | **Change:** remove `/register` and its import |
| `frontend/src/app/providers.tsx` | **Change:** provider order for the query-backed AuthProvider |
| `frontend/src/shared/i18n/locales/en.json` | **Change:** remove register/Google keys, add new auth keys |
| `frontend/src/test/renderWithProviders.tsx` | **Change:** replace `seedAuthSession` / `clearAuthSession` with API-client session seeding |

## 9. Tests (≥ 80% line and branch)

`fetch` is mocked; no network call is made. Component tests use `renderWithProviders`.

### Context and session

- A successful login stores the token and exposes the user; `isAuthenticated` becomes `true`.
- On boot, the provider resolves the session once and `authChecked` flips exactly once.
- A failed boot refresh leaves the user signed out without throwing.
- A session-cleared notification empties the React Query cache and navigates to `/login` with a
  `returnTo` for the page the user was on.
- `logout()` calls the endpoint, clears the cache, and navigates to `/login`.
- A `403` on an unrelated request does **not** sign the user out.

### ProtectedRoute

- Renders the fallback while auth is unresolved and renders no protected child.
- Renders the unauthenticated element when the session is absent.
- Renders the outlet once the session resolves.

### Screens

- `LoginPage`: submit disables the form, shows the inline spinner and sets `aria-busy`.
- `LoginPage`: a `401` renders the backend `error.message` in a `role="alert"` element.
- `LoginPage`: an error with no parseable body renders the localized fallback.
- `LoginPage`: the correlation ID is shown when the error carries one and omitted when not.
- `LoginPage`: after a successful sign-in the user lands on `returnTo`, defaulting to `/`.
- `LoginPage`: no Google button, no registration link, and the administrator-created-accounts
  line is present.
- `ForgotPasswordPage`: the success panel shows for both known and unknown emails; a network
  failure shows the inline error instead of the success panel.
- `ResetPasswordPage`: missing token renders the invalid-link branch; mismatched passwords do
  not call the API; an expired-token error renders its backend message.
- Renders without horizontal scroll at 375 px, 768 px and 1280 px.

### Removal assertions

- Navigating to `/register` renders the not-found page.
- `en.json` contains none of the removed keys, and every key the auth screens reference exists.

## 10. Definition of Done

- [ ] `features/auth/` contains no mock-data import; `uid` is no longer imported there.
- [ ] `AuthContext` exposes no `register`, `verifyOtp`, `resendOtp`, `loginWithGoogle` or
      `pendingEmail`, and `AUTH_STORAGE_KEY` no longer exists.
- [ ] No user object or access token is written to `localStorage` or `sessionStorage`.
- [ ] `RegisterPage.tsx`, `RegisterPage.test.tsx` and `GoogleIcon.tsx` are deleted; `/register`
      returns the not-found page.
- [ ] The removed i18n keys are gone and no component references a missing key.
- [ ] Session expiry returns the user to sign-in with no protected data left in the cache and
      resumes at `returnTo` after re-authentication.
- [ ] Every submit button shows a loader, is disabled while in flight, sets `aria-busy`, and
      renders an inline `role="alert"` error from `error.message` with a localized fallback.
- [ ] `npm run typecheck`, `npm run lint` and `npm test` pass in `frontend/`.
- [ ] Coverage for every file this phase touched is ≥ 80% line and ≥ 80% branch.

## 11. Documentation & ADR updates

- ADR in `docs/adr/`: "Frontend token storage and session lifetime" — record the option chosen
  in §4.2, its consequences, and the escape hatch. Write it with this phase.
- `docs/plan/README.md` §3 already records D6; no edit needed. Do not modify the README from
  this phase.
- If Phase 07's ADR already fixes the token transport, reference it instead of duplicating it.

## 12. Risks & open questions

Ask the user; do not assume (`.cursor/rules/no-assumptions.mdc`).

1. **Token storage (blocking).** Confirm option A in §4.2 (in-memory access token + httpOnly
   refresh cookie). If Phase 07 has not decided, this phase cannot start.
2. **Permissions on the user object.** Does `GET /auth/me` return the caller's effective
   permission list, or is there a separate endpoint? Phase 15 needs it to decide which admin
   controls to render, and §85 requires human-readable labels rather than raw identifiers.
3. **Password change for the signed-in user** is required by frontend §7A but has no endpoint in
   `solution.md` §8.4. Add it to Phase 08, or defer the UI? Not invented here.
4. **Reset-link delivery.** Email channels are out of scope (README §5, in-app notifications
   only). How does a user actually receive the reset token — and what should
   `ForgotPasswordPage` say happens next so it is not a fabricated promise (§98)?
5. **Session-expired copy.** Should the sign-in screen distinguish "you were signed out" from a
   normal visit, and does that leak anything? Proposal: a neutral localized line, shown only
   when the navigation carried the expiry flag.
6. **Google sign-in removal.** Confirm that no SSO provider is planned for this slice before the
   button and icon are deleted; re-adding them later is cheap, but the decision should be
   explicit rather than silent.
