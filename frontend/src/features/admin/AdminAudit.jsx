import { useEffect, useMemo, useRef, useState } from 'react';
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
import { DatePicker, parseCalendarDate, toCalendarDateString } from '@/shared/ui/date-picker';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select';

/**
 * Frontend mirror of the backend audit action / resource-type catalogs (Phase 10).
 * Keep in sync with backend/src/modules/access/audit.js when new actions ship.
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
  'project.member_added',
  'project.member_removed',
  'job.retry',
  'job.cancel',
  'source.upload',
  'knowledge.completed',
  'knowledge.failed',
  'repository.connected',
  'repository.branch_changed',
  'repository.credential_replaced',
  'repository.credential_revoked',
  'repository.sync_triggered',
  'conversation.created',
  'conversation.archived',
  'conversation.restored',
  'conversation.deleted',
  'conversation.title_changed',
]);

/** Known resource types paired with catalog actions. */
export const AUDIT_RESOURCE_TYPES = Object.freeze([
  'user',
  'role',
  'membership',
  'route',
  'project',
  'job',
  'source',
  'knowledge',
  'repository',
  'conversation',
]);

/** How far ahead of the list footer to prefetch the next keyset page. */
const AUDIT_LOAD_MORE_ROOT_MARGIN = '200px';

/** Page size so a typical audit trail paginates instead of dumping one long list. */
const AUDIT_LIST_PAGE_SIZE = 20;

/** Inclusive calendar-day cap matching GET /audit-events when both dates are sent. */
export const AUDIT_LIST_MAX_RANGE_DAYS = 31;

/**
 * Converts a YYYY-MM-DD filter to the inclusive UTC start instant.
 * @param calendarDate Calendar day from the URL, or empty.
 * @returns ISO instant, or undefined when the day is missing or invalid.
 */
function fromDateToUtcStart(calendarDate) {
  if (!parseCalendarDate(calendarDate)) {
    return undefined;
  }
  return `${calendarDate}T00:00:00.000Z`;
}

/**
 * Converts a YYYY-MM-DD filter to the exclusive UTC end (start of the next day).
 * @param calendarDate Calendar day from the URL, or empty.
 * @returns ISO instant, or undefined when the day is missing or invalid.
 */
function toDateToUtcEnd(calendarDate) {
  const parsed = parseCalendarDate(calendarDate);
  if (!parsed) {
    return undefined;
  }
  return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate() + 1)).toISOString();
}

/**
 * Shifts a YYYY-MM-DD calendar day by a signed day count.
 * @param calendarDate Day key, or empty.
 * @param deltaDays Days to add (negative to subtract).
 * @returns Shifted YYYY-MM-DD, or empty when the input is not a real day.
 */
export function addCalendarDays(calendarDate, deltaDays) {
  const parsed = parseCalendarDate(calendarDate);
  if (!parsed) {
    return '';
  }
  return toCalendarDateString(new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate() + deltaDays));
}

/**
 * Inclusive calendar-day count between two YYYY-MM-DD keys.
 * @param fromDate From day.
 * @param toDate To day.
 * @returns Day count, or null when either day is missing or invalid.
 */
export function inclusiveAuditDaySpan(fromDate, toDate) {
  const from = parseCalendarDate(fromDate);
  const to = parseCalendarDate(toDate);
  if (!from || !to) {
    return null;
  }
  const startUtc = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const endUtc = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((endUtc - startUtc) / 86_400_000) + 1;
}

/**
 * i18n key for an invalid audit date draft, or null when Search may run.
 * @param fromDate Draft from day.
 * @param toDate Draft to day.
 * @returns Error key, or null when both days are present and within 31 days.
 */
export function auditDateDraftErrorKey(fromDate, toDate) {
  if (!fromDate || !toDate || !parseCalendarDate(fromDate) || !parseCalendarDate(toDate)) {
    return 'admin.auditDatesRequired';
  }
  const span = inclusiveAuditDaySpan(fromDate, toDate);
  if (span === null || span < 1) {
    return 'admin.auditDateOrderInvalid';
  }
  if (span > AUDIT_LIST_MAX_RANGE_DAYS) {
    return 'admin.auditDateRangeInvalid';
  }
  return null;
}

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
export function targetLabel(event, t) {
  const typePart = resourceTypeLabel(event.resourceType, t);
  const name = typeof event.resourceName === 'string' && event.resourceName ? event.resourceName : event.resourceId;
  if (name) {
    return `${typePart} ${name}`;
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
  const loadMoreRef = useRef(/** @type {HTMLDivElement | null} */ (null));

  const canViewAudit = Boolean(currentUser?.permissions?.includes('audit.view'));
  const canManageUsers = Boolean(currentUser?.permissions?.includes('users.manage'));

  const [draftFrom, setDraftFrom] = useState(() => searchParams.get('from') ?? '');
  const [draftTo, setDraftTo] = useState(() => searchParams.get('to') ?? '');
  const [draftActor, setDraftActor] = useState(() => searchParams.get('actor') ?? '');
  const [draftAction, setDraftAction] = useState(() => searchParams.get('action') ?? '');
  const [draftResourceType, setDraftResourceType] = useState(() => searchParams.get('resourceType') ?? '');
  const [applied, setApplied] = useState(
    /** @type {{ from: string, to: string, actor: string, action: string, resourceType: string } | null} */ (null),
  );

  const dateDraftErrorKey = auditDateDraftErrorKey(draftFrom, draftTo);
  const fromIso = applied ? fromDateToUtcStart(applied.from) : undefined;
  const toIso = applied ? toDateToUtcEnd(applied.to) : undefined;

  const auditQuery = useAuditEvents({
    from: fromIso,
    to: toIso,
    actor: applied?.actor || undefined,
    action: applied?.action || undefined,
    resourceType: applied?.resourceType || undefined,
    limit: AUDIT_LIST_PAGE_SIZE,
    enabled: canViewAudit && applied !== null,
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

  const fromMaxDate = draftTo || '';
  const fromMinDate = draftTo ? addCalendarDays(draftTo, -(AUDIT_LIST_MAX_RANGE_DAYS - 1)) : '';
  const toMinDate = draftFrom || '';
  const toMaxDate = draftFrom ? addCalendarDays(draftFrom, AUDIT_LIST_MAX_RANGE_DAYS - 1) : '';

  /**
   * Copies the draft into applied filters and the URL so the list can load.
   */
  function applySearch() {
    if (dateDraftErrorKey) {
      return;
    }
    const next = {
      from: draftFrom,
      to: draftTo,
      actor: draftActor,
      action: draftAction,
      resourceType: draftResourceType,
    };
    setApplied(next);
    const params = new URLSearchParams();
    if (next.from) {
      params.set('from', next.from);
    }
    if (next.to) {
      params.set('to', next.to);
    }
    if (next.actor) {
      params.set('actor', next.actor);
    }
    if (next.action) {
      params.set('action', next.action);
    }
    if (next.resourceType) {
      params.set('resourceType', next.resourceType);
    }
    setSearchParams(params, { replace: true });
    setOpenEventId(null);
  }

  /**
   * Clears draft and applied filters and returns the page to the idle state.
   */
  function resetFilters() {
    setDraftFrom('');
    setDraftTo('');
    setDraftActor('');
    setDraftAction('');
    setDraftResourceType('');
    setApplied(null);
    setSearchParams(new URLSearchParams(), { replace: true });
    setOpenEventId(null);
  }

  /**
   * Retries the list query.
   */
  function retryList() {
    void auditQuery.refetch();
  }

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !auditQuery.hasNextPage || auditQuery.isFetchingNextPage) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void auditQuery.fetchNextPage();
        }
      },
      { rootMargin: AUDIT_LOAD_MORE_ROOT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [auditQuery.hasNextPage, auditQuery.isFetchingNextPage, auditQuery.fetchNextPage]);

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

  const hasSearched = applied !== null;
  const showSkeleton = hasSearched && auditQuery.isPending && events.length === 0;
  const showIdle = !hasSearched;
  const showEmpty = hasSearched && !auditQuery.isPending && !auditQuery.isError && events.length === 0;
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
          <DatePicker
            id="audit-from"
            label={t('admin.auditFrom')}
            value={draftFrom}
            onChange={setDraftFrom}
            minDate={fromMinDate}
            maxDate={fromMaxDate}
            className="w-full sm:w-48"
          />
          <DatePicker
            id="audit-to"
            label={t('admin.auditTo')}
            value={draftTo}
            onChange={setDraftTo}
            minDate={toMinDate}
            maxDate={toMaxDate}
            className="w-full sm:w-48"
          />
          {canManageUsers ? (
            <Select value={draftActor || 'all'} onValueChange={(value) => setDraftActor(value === 'all' ? '' : value)}>
              <SelectTrigger className="w-full sm:w-48" aria-label={t('admin.auditFilterUser')}>
                <SelectValue placeholder={t('admin.auditFilterUser')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('admin.auditFilterUserAll')}</SelectItem>
                {actorUsers.map((rowUser) => (
                  <SelectItem key={rowUser.id} value={rowUser.id}>
                    {rowUser.email || rowUser.displayName || rowUser.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Select value={draftResourceType || 'all'} onValueChange={(value) => setDraftResourceType(value === 'all' ? '' : value)}>
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
          <Select value={draftAction || 'all'} onValueChange={(value) => setDraftAction(value === 'all' ? '' : value)}>
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
          <div className="flex items-end gap-2">
            <Button type="button" size="sm" disabled={Boolean(dateDraftErrorKey)} onClick={applySearch}>
              {t('common.search')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={resetFilters}>
              {t('admin.auditReset')}
            </Button>
          </div>
        </div>
        {dateDraftErrorKey ? (
          <p className="mt-2 text-xs text-muted-foreground" role="status">
            {t(dateDraftErrorKey)}
          </p>
        ) : null}

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

        {showIdle ? (
          <div className="mt-4 rounded-lg border border-border bg-card px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground" role="status">
              {t('admin.auditIdle')}
            </p>
          </div>
        ) : null}

        {showEmpty ? (
          <div className="mt-4 rounded-lg border border-border bg-card px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground" role="status">
              {t('admin.auditEmptyFiltered')}
            </p>
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
          <div ref={loadMoreRef} className="mt-4 flex justify-center">
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
