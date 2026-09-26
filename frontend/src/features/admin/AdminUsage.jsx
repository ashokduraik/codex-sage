/**
 * Admin usage page — observed org totals from GET /usage/organization.
 * Question and token numbers are omitted until those facts exist.
 */
import { BarChart3, Database, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { messageFromUnknown } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { fetchOrganizationUsage, organizationUsageQueryKey } from './api/usageApi.js';

/**
 * Usage metrics dashboard from measured backend facts.
 * @returns {import('react').ReactElement}
 */
export default function AdminUsage() {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: organizationUsageQueryKey(),
    queryFn: ({ signal }) => fetchOrganizationUsage({ signal }),
  });
  const totals = query.data?.totals;
  const byProject = query.data?.byProject ?? [];

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-brand" aria-hidden="true" />
          <h1 className="font-display text-xl font-medium">{t('admin.usageTitle')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t('admin.usageSubtitle')}</p>

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

        {totals ? (
          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-3">
            <UsageStat icon={Database} label={t('admin.statIngestJobs')} value={totals.ingestJobsCompleted} sub={t('admin.statLast30')} />
            <UsageStat icon={Database} label={t('admin.statSourceBytes')} value={totals.sourceBytesAccepted} sub={t('admin.statLast30')} />
            <UsageStat icon={Search} label={t('admin.statSearches')} value={totals.searchesExecuted} sub={t('admin.statLast30')} />
          </div>
        ) : null}

        {totals && byProject.length === 0 && totals.ingestJobsCompleted === 0 && totals.searchesExecuted === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">{t('admin.usageEmpty')}</p>
        ) : null}

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
                  <Bar dataKey="ingestJobsCompleted" fill="hsl(var(--brand))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 divide-y divide-border">
              {byProject.map((row) => (
                <div key={row.projectId} className="flex items-center justify-between py-2 text-sm">
                  <span className="font-mono text-xs">{row.projectId}</span>
                  <span className="text-muted-foreground">
                    {t('admin.usageProjectLine', {
                      jobs: row.ingestJobsCompleted,
                      bytes: row.sourceBytesAccepted,
                      searches: row.searchesExecuted,
                    })}
                  </span>
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
 * @param {{ icon: import('react').ElementType, label: string, value: number, sub: string }} props Tile.
 * @returns {import('react').ReactElement}
 */
function UsageStat({ icon: Icon, label, value, sub }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden="true" />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold text-foreground">{Number(value).toLocaleString('en-US')}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}
