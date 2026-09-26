import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, ScrollText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { useUsers } from '@/features/admin/api/useUsers.js';
import { useAuditEvents } from '@/features/admin/api/useAuditEvents.js';
import { ApiError, correlationFromUnknown, messageFromUnknown } from '@/shared/api';
import { formatDateTime } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select';

/**
 * Frontend mirror of the backend audit action / resource-type catalogs (Phase 10).
 * Keep in sync with backend/src/modules/audit/audit.actions.js when new actions ship.
 */

/** Known `<domain>.<verb>` audit actions offered in filter selects. */
export const AUDIT_ACTIONS = Object.freeze([
  'user.create',
  'user.update',
  'user.email_changed',
  'user.activate',
  'user.deactivate',
  'user.remove',
  'user.roles_changed',
  'user.password_changed',
  'user.password_set_by_admin',
  'role.create',
  'role.update',
  'role.remove',
  'membership.update',
  'authz.denied',
  'project.create',
  'project.update',
  'project.settings_changed',
  'project.archive',
  'project.restore',
  'project.delete',
]);

/** Known resource types paired with catalog actions. */
export const AUDIT_RESOURCE_TYPES = Object.freeze(['user', 'role', 'membership', 'route', 'project']);

/**
 * Context keys the UI knows how to present (identity / authz writers today).
 * Extend only when a known backend writer adds a safe scalar key.
 */
export const AUDIT_CONTEXT_ALLOWLIST = Object.freeze([
  'previousStatus',
  'nextStatus',
  'previousEmail',
  'nextEmail',
  'roleIds',
  'addedRoleIds',
  'removedRoleIds',
  'permissionKey',
  'route',
  'method',
  'contextTruncated',
]);

const ALLOWLIST_SET = new Set(AUDIT_CONTEXT_ALLOWLIST);

/**
 * Secret-shaped key substrings (case-insensitive). Aligns with the backend sanitizer;
 * bare "key" is matched as a whole token so `permissionKey` is not false-positive.
 */
const SECRET_KEY_SUBSTRINGS = Object.freeze(['password', 'token', 'secret', 'credential', 'authorization', 'apikey', 'privatekey', 'cookie', 'hash']);

/**
 * Returns whether a context key looks secret-shaped and must never be rendered.
 * @param {string} key Object key.
 * @returns {boolean}
 */
export function isSecretShapedAuditContextKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    return true;
  }
  const lower = key.toLowerCase();
  if (SECRET_KEY_SUBSTRINGS.some((fragment) => lower.includes(fragment))) {
    return true;
  }
  return /(^|[^a-z0-9])key([^a-z0-9]|$)/.test(lower);
}

/**
 * Filters event context down to allowlisted, non-secret, scalar (or scalar-array) entries.
 * Nested objects and unknown keys are dropped — never rendered as JSON.
 * @param {unknown} context Raw `context` from an audit event DTO.
 * @returns {Array<{ key: string, value: string | number | boolean | Array<string | number | boolean> }>}
 */
export function selectRenderableAuditContext(context) {
  if (context === undefined || context === null) {
    return [];
  }
  if (typeof context !== 'object' || Array.isArray(context)) {
    return [];
  }

  /** @type {Array<{ key: string, value: string | number | boolean | Array<string | number | boolean> }>} */
  const rows = [];

  for (const [key, raw] of Object.entries(context)) {
    if (!ALLOWLIST_SET.has(key) || isSecretShapedAuditContextKey(key)) {
      continue;
    }
    if (Array.isArray(raw)) {
      const items = raw.filter((item) => {
        const type = typeof item;
        return type === 'string' || type === 'number' || type === 'boolean';
      });
      if (items.length === 0) {
        continue;
      }
      rows.push({ key, value: items });
      continue;
    }
    const rawType = typeof raw;
    if (rawType !== 'string' && rawType !== 'number' && rawType !== 'boolean') {
      continue;
    }
    rows.push({ key, value: raw });
  }

  return rows;
}

/**
 * Actor label for list and detail rows.
 * @param {{ id?: string, email?: string | null } | null | undefined} actor Actor DTO.
 * @param {(key: string) => string} t Translator.
 * @returns {string}
 */
function actorLabel(actor, t) {
  if (!actor) {
    return t('admin.auditSystemActor');
  }
  if (typeof actor.email === 'string' && actor.email) {
    return actor.email;
  }
  if (typeof actor.id === 'string' && actor.id) {
    return actor.id;
  }
  return t('admin.auditSystemActor');
}

/**
 * Localized action label, falling back to the raw action string.
 * @param {string | undefined} action Action key.
 * @param {(key: string, options?: object) => string} t Translator.
 * @returns {string}
 */
function actionLabel(action, t) {
  if (!action) {
    return t('admin.auditNotRecorded');
  }
  return t(`admin.auditActions.${action}`, { defaultValue: action });
}

/**
 * Localized resource-type label.
 * @param {string | undefined} resourceType Resource type.
 * @param {(key: string, options?: object) => string} t Translator.
 * @returns {string}
 */
function resourceTypeLabel(resourceType, t) {
  if (!resourceType) {
    return t('admin.auditNotRecorded');
  }
  return t(`admin.auditResourceTypes.${resourceType}`, { defaultValue: resourceType });
}

/**
 * Target resource display string.
 * @param {object} event Audit event.
 * @param {(key: string, options?: object) => string} t Translator.
 * @returns {string}
 */
function targetLabel(event, t) {
  const typePart = resourceTypeLabel(event.resourceType, t);
  if (event.resourceId) {
    return `${typePart} ${event.resourceId}`;
  }
  if (event.resourceType) {
    return typePart;
  }
  return t('admin.auditNotRecorded');
}

/**
 * Result badge tone classes.
 * @param {string | undefined} result Result value.
 * @returns {string}
 */
function resultTone(result) {
  if (result === 'success') {
    return 'text-emerald-700 bg-emerald-100';
  }
  if (result === 'denied') {
    return 'text-amber-800 bg-amber-100';
  }
  if (result === 'failed') {
    return 'text-red-700 bg-red-100';
  }
  return 'text-muted-foreground bg-muted';
}

/**
 * Localized result label.
 * @param {string | undefined} result Result value.
 * @param {(key: string, options?: object) => string} t Translator.
 * @returns {string}
 */
function resultLabel(result, t) {
  if (result === 'success') {
    return t('admin.auditResultSuccess');
  }
  if (result === 'denied') {
    return t('admin.auditResultDenied');
  }
  if (result === 'failed') {
    return t('admin.auditResultFailed');
  }
  if (typeof result === 'string' && result) {
    return result;
  }
  return t('admin.auditNotRecorded');
}

/**
 * Organization audit log against GET /audit-events.
 *
 * @returns Admin audit page.
 */
export default function AdminAudit() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [openEventId, setOpenEventId] = useState(/** @type {string | null} */ (null));

  const canViewAudit = Boolean(currentUser?.permissions?.includes('audit.view'));
  const canManageUsers = Boolean(currentUser?.permissions?.includes('users.manage'));

  const fromDate = searchParams.get('from') ?? '';
  const toDate = searchParams.get('to') ?? '';
  const actor = searchParams.get('actor') ?? '';
  const action = searchParams.get('action') ?? '';
  const resourceType = searchParams.get('resourceType') ?? '';

  const hasActiveFilters = Boolean(fromDate || toDate || actor || action || resourceType);

  const fromIso = fromDate ? `${fromDate}T00:00:00.000Z` : undefined;
  let toIso;
  if (toDate) {
    const start = new Date(`${toDate}T00:00:00.000Z`);
    if (!Number.isNaN(start.getTime())) {
      start.setUTCDate(start.getUTCDate() + 1);
      toIso = start.toISOString();
    }
  }

  const auditQuery = useAuditEvents({
    from: fromIso,
    to: toIso,
    actor: actor || undefined,
    action: action || undefined,
    resourceType: resourceType || undefined,
    enabled: canViewAudit,
  });

  const usersQuery = useUsers({
    enabled: canViewAudit && canManageUsers,
    limit: 100,
  });
  const actorUsers = usersQuery.data?.items ?? [];

  const events = useMemo(() => (auditQuery.data?.pages ?? []).flatMap((page) => page.items ?? []), [auditQuery.data?.pages]);

  const isForbidden = auditQuery.isError && auditQuery.error instanceof ApiError && auditQuery.error.status === 403;

  const listErrorMessage = auditQuery.isError ? messageFromUnknown(auditQuery.error, t('errors.unexpected')) : '';
  const listCorrelationId = auditQuery.isError ? correlationFromUnknown(auditQuery.error) : '';

  /**
   * Updates a filter query param.
   * @param {string} key Param name.
   * @param {string} value Param value (empty clears).
   */
  function setFilterParam(key, value) {
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    setSearchParams(params, { replace: true });
    setOpenEventId(null);
  }

  /**
   * Clears all audit filter params.
   */
  function clearFilters() {
    setSearchParams(new URLSearchParams(), { replace: true });
    setOpenEventId(null);
  }

  /**
   * Retries the list query.
   */
  function retryList() {
    void auditQuery.refetch();
  }

  if (!canViewAudit) {
    return (
      <div className="h-full overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-4xl px-6 py-8">
          <p role="alert" className="text-sm text-destructive">
            {t('errors.codes.FORBIDDEN')}
          </p>
        </div>
      </div>
    );
  }

  const showSkeleton = auditQuery.isPending && events.length === 0;
  const showEmpty = !auditQuery.isPending && !auditQuery.isError && events.length === 0;
  const showList = !showSkeleton && events.length > 0;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-brand" aria-hidden="true" />
          <h1 className="font-display text-xl font-medium">{t('admin.auditTitle')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t('admin.auditSubtitle')}</p>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label htmlFor="audit-from" className="text-xs text-muted-foreground">
              {t('admin.auditFrom')}
            </label>
            <Input id="audit-from" type="date" value={fromDate} onChange={(event) => setFilterParam('from', event.target.value)} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label htmlFor="audit-to" className="text-xs text-muted-foreground">
              {t('admin.auditTo')}
            </label>
            <Input id="audit-to" type="date" value={toDate} onChange={(event) => setFilterParam('to', event.target.value)} />
          </div>
          {canManageUsers ? (
            <Select value={actor || 'all'} onValueChange={(value) => setFilterParam('actor', value === 'all' ? '' : value)}>
              <SelectTrigger className="w-full sm:w-48" aria-label={t('admin.auditFilterActor')}>
                <SelectValue placeholder={t('admin.auditFilterActor')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('admin.auditFilterActorAll')}</SelectItem>
                {actorUsers.map((rowUser) => (
                  <SelectItem key={rowUser.id} value={rowUser.id}>
                    {rowUser.email || rowUser.displayName || rowUser.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Select value={action || 'all'} onValueChange={(value) => setFilterParam('action', value === 'all' ? '' : value)}>
            <SelectTrigger className="w-full sm:w-48" aria-label={t('admin.auditFilterAction')}>
              <SelectValue placeholder={t('admin.auditFilterAction')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('admin.auditFilterActionAll')}</SelectItem>
              {AUDIT_ACTIONS.map((actionKey) => (
                <SelectItem key={actionKey} value={actionKey}>
                  {actionLabel(actionKey, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={resourceType || 'all'} onValueChange={(value) => setFilterParam('resourceType', value === 'all' ? '' : value)}>
            <SelectTrigger className="w-full sm:w-44" aria-label={t('admin.auditFilterResourceType')}>
              <SelectValue placeholder={t('admin.auditFilterResourceType')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('admin.auditFilterResourceTypeAll')}</SelectItem>
              {AUDIT_RESOURCE_TYPES.map((typeKey) => (
                <SelectItem key={typeKey} value={typeKey}>
                  {resourceTypeLabel(typeKey, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {auditQuery.isError ? (
          <div role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <p>{isForbidden ? t('errors.codes.FORBIDDEN') : listErrorMessage}</p>
            {listCorrelationId ? <p className="mt-1 text-xs opacity-80">{t('errors.correlationId', { id: listCorrelationId })}</p> : null}
            {!isForbidden ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => {
                  retryList();
                }}
              >
                {t('common.retry')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {showSkeleton ? (
          <div className="mt-4 space-y-2 rounded-lg border border-border bg-card p-4" aria-busy="true" aria-label={t('common.loading')}>
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="h-12 animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        ) : null}

        {showEmpty ? (
          <div className="mt-4 rounded-lg border border-border bg-card px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground" role="status">
              {hasActiveFilters ? t('admin.auditEmptyFiltered') : t('admin.auditEmpty')}
            </p>
            {hasActiveFilters ? (
              <Button type="button" variant="outline" size="sm" className="mt-3" onClick={clearFilters}>
                {t('admin.auditClearFilters')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {showList ? (
          <div className="mt-4 divide-y divide-border rounded-lg border border-border bg-card">
            {events.map((event) => {
              const eventId = String(event.id);
              const expanded = openEventId === eventId;
              const contextRows = expanded ? selectRenderableAuditContext(event.context) : [];
              return (
                <div key={eventId}>
                  <button
                    type="button"
                    onClick={() => setOpenEventId(expanded ? null : eventId)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/30"
                  >
                    {expanded ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">
                        <span className="font-medium">{actorLabel(event.actor, t)}</span>{' '}
                        <span className="text-muted-foreground">{actionLabel(event.action, t)}</span>{' '}
                        <span className="font-medium">{targetLabel(event, t)}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {event.createdAt ? formatDateTime(event.createdAt) : t('admin.auditNotRecorded')}
                      </div>
                    </div>
                    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs', resultTone(event.result))}>{resultLabel(event.result, t)}</span>
                  </button>
                  {expanded ? (
                    <div className="space-y-1 px-4 pb-3 pl-11 text-xs text-muted-foreground">
                      <div>
                        {t('admin.auditActor')}: {actorLabel(event.actor, t)}
                      </div>
                      <div>
                        {t('admin.auditAction')}: {event.action ? actionLabel(event.action, t) : t('admin.auditNotRecorded')}
                      </div>
                      <div>
                        {t('admin.auditTarget')}: {targetLabel(event, t)}
                      </div>
                      <div>
                        {t('admin.auditTimestamp')}: {event.createdAt ? formatDateTime(event.createdAt) : t('admin.auditNotRecorded')}
                      </div>
                      <div>
                        {t('admin.auditResult')}: {resultLabel(event.result, t)}
                      </div>
                      {event.correlationId ? (
                        <div>
                          {t('admin.auditReference')}: {event.correlationId}
                        </div>
                      ) : null}
                      {contextRows.length > 0 ? (
                        <div className="pt-1">
                          <div className="font-medium text-foreground/80">{t('admin.auditContext')}</div>
                          {contextRows.map((row) => (
                            <div key={row.key}>
                              {row.key}: {Array.isArray(row.value) ? row.value.map(String).join(', ') : String(row.value)}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {auditQuery.hasNextPage ? (
          <div className="mt-4 flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={auditQuery.isFetchingNextPage}
              onClick={() => {
                void auditQuery.fetchNextPage();
              }}
            >
              {auditQuery.isFetchingNextPage ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {t('admin.auditLoadMore')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
