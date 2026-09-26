/**
 * Latest knowledge-update change summary from the Phase 39 API.
 */
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { AlertTriangle, ChevronDown, ChevronRight, FileEdit, FileMinus, FilePlus, GitCompare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/shared/components';
import { cn } from '@/shared/lib/utils';
import { useChangeSummary } from '@/features/knowledge/hooks/useChangeSummary.js';
import SourcePreviewDrawer from '@/features/knowledge/SourcePreviewDrawer.jsx';

const ROWS = [
  {
    key: 'added',
    labelKey: 'changes.added',
    icon: FilePlus,
    tone: 'text-emerald-600',
    bg: 'bg-emerald-50',
  },
  {
    key: 'modified',
    labelKey: 'changes.modified',
    icon: FileEdit,
    tone: 'text-blue-600',
    bg: 'bg-blue-50',
  },
  {
    key: 'removed',
    labelKey: 'changes.removed',
    icon: FileMinus,
    tone: 'text-red-600',
    bg: 'bg-red-50',
  },
];

/**
 * Recent knowledge-update changes.
 *
 * @returns {import('react').ReactElement}
 */
export default function ChangesPanel() {
  const { t } = useTranslation();
  const { project } = useOutletContext();
  const projectId = project?.id;
  const summaryQuery = useChangeSummary(projectId);
  const [previewTarget, setPreviewTarget] = useState(null);
  const [openConflict, setOpenConflict] = useState(-1);
  const summary = summaryQuery.data;

  if (summaryQuery.isLoading) {
    return (
      <div className="h-full overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <p className="text-sm text-muted-foreground" aria-busy="true">
            {t('changes.loading')}
          </p>
        </div>
      </div>
    );
  }

  if (summaryQuery.isError) {
    return (
      <div className="h-full overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <p className="text-sm text-destructive" role="alert">
            {summaryQuery.error?.message || t('changes.error')}
          </p>
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="h-full overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <EmptyState icon={GitCompare} title={t('changes.emptyTitle')} description={t('changes.emptyDescription')} />
        </div>
      </div>
    );
  }

  const conflicts = Array.isArray(summary.conflicts) ? summary.conflicts : [];

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="font-display text-xl font-medium">{t('changes.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('changes.subtitle')}</p>

        <div className="mt-5 grid grid-cols-3 gap-3">
          {ROWS.map((row) => (
            <div key={row.key} className={cn('rounded-lg border border-border p-3', row.bg)}>
              <div className={cn('flex items-center gap-1.5 text-sm font-medium', row.tone)}>
                <row.icon className="h-4 w-4" aria-hidden="true" />
                {t(row.labelKey)}
              </div>
              <div className="mt-1 text-2xl font-semibold text-foreground">{Number(summary.counts?.[row.key]) || 0}</div>
            </div>
          ))}
        </div>

        {summary.impact?.apisChanged != null || summary.impact?.workflowsChanged != null ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {t('changes.affected')}: {summary.impact.apisChanged ?? '—'} / {summary.impact.workflowsChanged ?? '—'}
          </p>
        ) : null}

        <div className="mt-6 space-y-5">
          {ROWS.map((row) => {
            const paths = Array.isArray(summary.paths?.[row.key]) ? summary.paths[row.key] : [];
            if (paths.length === 0) {
              return null;
            }
            return (
              <div key={row.key}>
                <h2 className={cn('flex items-center gap-2 text-xs font-semibold uppercase tracking-wide', row.tone)}>
                  <row.icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {t(row.labelKey)}
                </h2>
                <div className="mt-2 divide-y divide-border rounded-lg border border-border bg-card">
                  {paths.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      className="block w-full px-4 py-2.5 text-left hover:bg-muted/40"
                      onClick={() => setPreviewTarget({ path: entry.path, startLine: 1, endLine: 40 })}
                    >
                      <div className="font-mono text-sm text-foreground">{entry.path}</div>
                      {entry.impact ? <div className="text-xs text-muted-foreground">{entry.impact}</div> : null}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-6">
          <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            {t('changes.docConflicts')}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('changes.docConflictsHint')}</p>
          {conflicts.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">{t('changes.noConflicts')}</p>
          ) : (
            <div className="mt-2 space-y-2">
              {conflicts.map((conflict, index) => (
                <div key={conflict.concept} className="rounded-lg border border-amber-200 bg-amber-50/50">
                  <button
                    type="button"
                    onClick={() => setOpenConflict(openConflict === index ? -1 : index)}
                    className="flex w-full items-center justify-between px-4 py-2.5 text-left"
                  >
                    <span className="text-sm font-medium text-foreground">{conflict.concept}</span>
                    {openConflict === index ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    )}
                  </button>
                  {openConflict === index ? (
                    <div className="grid gap-2 px-4 pb-3 sm:grid-cols-2">
                      <div className="rounded-lg border border-border bg-card p-3">
                        <div className="text-xs font-semibold text-blue-600">{t('changes.codeSays')}</div>
                        <p className="mt-1 text-sm">{conflict.code?.excerpt || conflict.code}</p>
                      </div>
                      <div className="rounded-lg border border-border bg-card p-3">
                        <div className="text-xs font-semibold text-amber-700">{t('changes.docsSay')}</div>
                        <p className="mt-1 text-sm">{conflict.documentation?.excerpt || conflict.docs}</p>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <SourcePreviewDrawer projectId={projectId} target={previewTarget} onClose={() => setPreviewTarget(null)} />
    </div>
  );
}
