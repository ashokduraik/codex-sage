/**
 * Resolve `?returnTo=` to a safe same-origin path, else `/`.
 *
 * The same-origin check alone is not enough: a value like `/.//evil.com` or
 * `/\evil.com` parses same-origin but normalizes to a protocol-relative
 * `//evil.com` when assigned to `location.href` — an open redirect. So require the
 * resolved path to be exactly one leading slash (no `//` prefix, no backslash).
 *
 * @returns A same-origin path+search string safe for client-side navigation.
 */
export function safeReturnTo(): string {
  const raw = new URLSearchParams(window.location.search).get('returnTo');
  if (!raw) return '/';
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return '/';
    // Strip bootstrap / token params so they cannot be re-injected via returnTo.
    for (const param of [
      'access_token',
      'clear_access_token',
      'app_id',
      'app_base_url',
      'functions_version',
      'from_url',
    ]) {
      url.searchParams.delete(param);
    }
    const path = url.pathname + url.search;
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return '/';
    return path;
  } catch {
    return '/';
  }
}
