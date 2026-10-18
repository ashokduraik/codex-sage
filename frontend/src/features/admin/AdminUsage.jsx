/**
 * Admin usage page — observed org totals from GET projectActivities usage.
 * Renders only keys the API returns; omits question/token tiles when absent.
 */
import { useMemo, useState } from 'react';
import { Button } from '@/shared/ui/button';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { messageFromUnknown } from '@/shared/api';
import { useAuth } from '@/features/auth/AuthContext';
import { BarChart3, Database, HelpCircle, Search } from 'lucide-react';
import { fetchOrganizationUsage, organizationUsageQueryKey } from './api/usageApi.js';
import { DatePicker, parseCalendarDate, toCalendarDateString } from '@/shared/ui/date-picker';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

/** Inclusive calendar-day cap for the usage date filter. */
const USAGE_MAX_RANGE_DAYS = 366;

/**
 * Shifts a YYYY-MM-DD calendar day by a signed day count.
 * @param {string} calendarDate Day key, or empty.
 * @param {number} deltaDays Days to add (negative to subtract).
 * @returns {string} Shifted YYYY-MM-DD, or empty when invalid.
 */
function addCalendarDays(calendarDate, deltaDays) {
  const parsed = parseCalendarDate(calendarDate);
  if (!parsed) {
    return '';
  }
  return toCalendarDateString(new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate() + deltaDays));
}

/**
 * Inclusive day span between two calendar days.
 * @param {string} fromDate From day.
 * @param {string} toDate To day.
 * @returns {number | null}
 */
function inclusiveDaySpan(fromDate, toDate) {
  const from = parseCalendarDate(fromDate);
  const to = parseCalendarDate(toDate);
  if (!from || !to) {
    return null;
  }
  const ms = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  return Math.floor(ms / (24 * 60 * 60 * 1000)) + 1;
}

/**
 * Validates the draft date range.
 * @param {string} fromDate Draft from.
 * @param {string} toDate Draft to.
 * @returns {string | null} i18n key when invalid.
 */
function usageDateDraftErrorKey(fromDate, toDate) {
  if (!fromDate || !toDate || !parseCalendarDate(fromDate) || !parseCalendarDate(toDate)) {
    return 'admin.usageDateRequired';
  }
  const span = inclusiveDaySpan(fromDate, toDate);
  if (span == null || span < 1) {
    return 'admin.usageDateOrder';
  }
  if (span > USAGE_MAX_RANGE_DAYS) {
    return 'admin.usageDateTooLong';
  }
  return null;
}

/**
 * Converts a YYYY-MM-DD filter to the inclusive UTC start instant.
 * @param {string} calendarDate Calendar day.
 * @returns {string | undefined}
 */
function fromDateToUtcStart(calendarDate) {
  if (!parseCalendarDate(calendarDate)) {
    return undefined;
  }
  return `${calendarDate}T00:00:00.000Z`;
}

/**
 * Converts a YYYY-MM-DD filter to the exclusive UTC end (start of the next day).
 * @param {string} calendarDate Calendar day.
 * @returns {string | undefined}
 */
function toDateToUtcEnd(calendarDate) {
  const parsed = parseCalendarDate(calendarDate);
  if (!parsed) {
    return undefined;
  }
  return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate() + 1)).toISOString();
}

/**
 * Default applied window: last 30 calendar days ending today (local calendar).
 * @returns {{ from: string, to: string }}
 */
function defaultUsageWindow() {
  const to = toCalendarDateString(new Date());
  const from = addCalendarDays(to, -29);
  return { from, to };
}

/**
 * Usage metrics dashboard from measured backend facts.
 * @returns {import('react').ReactElement}
 */
export default function AdminUsage() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  const canViewUsage = Boolean(currentUser?.permissions?.includes('usage.view'));
  const [draftFrom, setDraftFrom] = useState(() => defaultUsageWindow().from);
  const [draftTo, setDraftTo] = useState(() => defaultUsageWindow().to);
  const [applied, setApplied] = useState(() => defaultUsageWindow());
  const dateDraftErrorKey = usageDateDraftErrorKey(draftFrom, draftTo);
  const fromIso = applied ? fromDateToUtcStart(applied.from) : undefined;
  const toIso = applied ? toDateToUtcEnd(applied.to) : undefined;

  const query = useQuery({
    queryKey: organizationUsageQueryKey({ from: fromIso, to: toIso }),
    queryFn: ({ signal }) => fetchOrganizationUsage({ from: fromIso, to: toIso, signal }),
    enabled: canViewUsage && applied !== null,
  });
  const totals = query.data?.totals ?? {};
  const byProject = query.data?.byProject ?? [];
  const byUser = query.data?.byUser ?? [];
  const hasAnyTotal = Object.keys(totals).length > 0;
  const showTokens = totals.tokensInput != null || totals.tokensOutput != null;
  const tokenDisplay = useMemo(() => {
    const input = Number(totals.tokensInput ?? 0);
    const output = Number(totals.tokensOutput ?? 0);
    return input + output;
  }, [totals.tokensInput, totals.tokensOutput]);

  const fromMaxDate = draftTo || '';
  const fromMinDate = draftTo ? addCalendarDays(draftTo, -(USAGE_MAX_RANGE_DAYS - 1)) : '';
  const toMinDate = draftFrom || '';
  const toMaxDate = draftFrom ? addCalendarDays(draftFrom, USAGE_MAX_RANGE_DAYS - 1) : '';

  if (!canViewUsage) {
    return (
      <div className="h-full overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-4xl px-6 py-8">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-brand" aria-hidden="true" />
            <h1 className="font-display text-xl font-medium">{t('admin.usageTitle')}</h1>
          </div>
          <p role="alert" className="mt-5 text-sm text-muted-foreground">
            {t('errors.codes.FORBIDDEN')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-brand" aria-hidden="true" />
          <h1 className="font-display text-xl font-medium">{t('admin.usageTitle')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t('admin.usageSubtitle')}</p>

        <div className="mt-5 flex flex-wrap items-end gap-3">
          <DatePicker
            id="usage-from"
            label={t('admin.usageFrom')}
            value={draftFrom}
            onChange={setDraftFrom}
            minDate={fromMinDate}
            maxDate={fromMaxDate}
          />
          <DatePicker id="usage-to" label={t('admin.usageTo')} value={draftTo} onChange={setDraftTo} minDate={toMinDate} maxDate={toMaxDate} />
          <Button
            type="button"
            disabled={Boolean(dateDraftErrorKey)}
            onClick={() => {
              if (dateDraftErrorKey) {
                return;
              }
              setApplied({ from: draftFrom, to: draftTo });
            }}
          >
            {t('admin.usageApply')}
          </Button>
        </div>
        {dateDraftErrorKey ? <p className="mt-2 text-xs text-muted-foreground">{t(dateDraftErrorKey)}</p> : null}

        {query.isLoading ? (
          <div className="mt-5 h-32 animate-pulse rounded-xl border border-border bg-muted/40" aria-busy="true">
            <span className="sr-only">{t('common.loading')}</span>
          </div>
        ) : null}

        {query.error ? (
          <div role="alert" className="mt-5 text-sm">
            <p>{messageFromUnknown(query.error, t('admin.usageLoadFailed'))}</p>
            <Button variant="outline" className="mt-3" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : null}

        {hasAnyTotal ? (
          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-3">
            {totals.questionsAnswered != null ? (
              <UsageStat icon={HelpCircle} label={t('admin.statQuestions')} value={totals.questionsAnswered} />
            ) : null}
            {showTokens ? <UsageStat icon={BarChart3} label={t('admin.statTokens')} value={tokenDisplay} /> : null}
            {totals.ingestJobsCompleted != null ? (
              <UsageStat icon={Database} label={t('admin.statIngestJobs')} value={totals.ingestJobsCompleted} />
            ) : null}
            {totals.sourceBytesAccepted != null ? (
              <UsageStat icon={Database} label={t('admin.statSourceBytes')} value={totals.sourceBytesAccepted} />
            ) : null}
            {totals.searchesExecuted != null ? <UsageStat icon={Search} label={t('admin.statSearches')} value={totals.searchesExecuted} /> : null}
          </div>
        ) : null}

        {!query.isLoading && !query.error && !hasAnyTotal ? <p className="mt-6 text-sm text-muted-foreground">{t('admin.usageEmpty')}</p> : null}

        {byProject.length > 0 ? (
          <div className="mt-6 rounded-xl border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">{t('admin.usageByProject')}</h2>
            <div className="mt-3 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byProject}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="projectId" tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: '1px solid hsl(var(--border))',
                      fontSize: 12,
                    }}
                  />
                  <Bar
                    dataKey={byProject.some((row) => row.questionsAnswered != null) ? 'questionsAnswered' : 'ingestJobsCompleted'}
                    fill="hsl(var(--brand))"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 divide-y divide-border">
              {byProject.map((row) => (
                <div key={row.projectId} className="flex items-center justify-between py-2 text-sm">
                  <span className="font-mono text-xs">{row.projectId}</span>
                  <span className="text-muted-foreground">{formatUsageBreakdown(t, row)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {byUser.length > 0 ? (
          <div className="mt-6 rounded-xl border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">{t('admin.usageByUser')}</h2>
            <div className="mt-3 divide-y divide-border">
              {byUser.map((row) => (
                <div key={row.userId} className="flex items-center justify-between py-2 text-sm">
                  <span className="font-mono text-xs">{row.userId}</span>
                  <span className="text-muted-foreground">{formatUsageBreakdown(t, row)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One measured usage tile.
 * @param {{ icon: import('react').ElementType, label: string, value: number }} props Tile.
 * @returns {import('react').ReactElement}
 */
function UsageStat({ icon: Icon, label, value }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden="true" />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold text-foreground">{Number(value).toLocaleString('en-US')}</div>
    </div>
  );
}

/**
 * Builds a compact breakdown line from present usage keys.
 * @param {(key: string, values?: object) => string} t Translator.
 * @param {Record<string, unknown>} row Totals row.
 * @returns {string}
 */
function formatUsageBreakdown(t, row) {
  const parts = [];
  if (row.questionsAnswered != null) {
    parts.push(t('admin.usagePartQuestions', { count: row.questionsAnswered }));
  }
  if (row.tokensInput != null || row.tokensOutput != null) {
    parts.push(
      t('admin.usagePartTokens', {
        count: Number(row.tokensInput ?? 0) + Number(row.tokensOutput ?? 0),
      }),
    );
  }
  if (row.ingestJobsCompleted != null) {
    parts.push(t('admin.usagePartJobs', { count: row.ingestJobsCompleted }));
  }
  if (row.sourceBytesAccepted != null) {
    parts.push(t('admin.usagePartBytes', { count: row.sourceBytesAccepted }));
  }
  if (row.searchesExecuted != null) {
    parts.push(t('admin.usagePartSearches', { count: row.searchesExecuted }));
  }
  return parts.join(' · ');
}
