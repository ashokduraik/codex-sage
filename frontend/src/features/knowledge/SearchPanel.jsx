/**
 * Project search panel backed by GET /search.
 */
import { useState } from 'react';
import { cn } from '@/shared/lib/utils';
import { Input } from '@/shared/ui/input';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/shared/components';
import SourcePreviewDrawer from './SourcePreviewDrawer.jsx';
import { useProjectSearch } from './hooks/useProjectSearch.js';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { ArrowRight, BookOpen, Boxes, FileCode, FileQuestion, Plug, Search, Workflow } from 'lucide-react';

const TYPE_CHIPS = [
  { token: '', labelKey: 'home.all' },
  { token: 'code', labelKey: 'search.type.code', icon: FileCode },
  { token: 'doc', labelKey: 'search.type.doc', icon: BookOpen },
  { token: 'symbol', labelKey: 'search.type.symbol', icon: Boxes },
  { token: 'workflow', labelKey: 'search.type.workflow', icon: Workflow },
  { token: 'api', labelKey: 'search.type.api', icon: Plug },
];

const TYPE_ICON = {
  code: FileCode,
  doc: BookOpen,
  symbol: Boxes,
  workflow: Workflow,
  api: Plug,
};

/**
 * Project knowledge search panel.
 *
 * @returns {import('react').ReactElement}
 */
export default function SearchPanel() {
  const { t } = useTranslation();
  const { project } = useOutletContext();
  const navigate = useNavigate();
  const projectId = project?.id;
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [previewTarget, setPreviewTarget] = useState(null);
  const searchQuery = useProjectSearch(projectId, query, type);
  const items = Array.isArray(searchQuery.data?.items) ? searchQuery.data.items : [];
  const state = searchQuery.data?.state;
  const idle = query.trim() === '';
  const waitingDebounce = query.trim().length >= 2 && searchQuery.debouncedQ !== query.trim();

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="font-display text-xl font-medium">{t('search.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('search.subtitle')}</p>

        <div className="relative mt-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('search.placeholder')}
            className="h-11 pl-9 text-base"
            autoFocus
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {TYPE_CHIPS.map((chip) => (
            <button
              key={chip.token || 'all'}
              type="button"
              onClick={() => setType(chip.token)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                type === chip.token ? 'bg-brand text-brand-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70',
              )}
            >
              {t(chip.labelKey)}
            </button>
          ))}
        </div>

        {state && state !== 'ready' ? (
          <p className="mt-4 text-sm text-amber-800" role="alert">
            {state === 'updating' ? t('search.updating') : t('search.unavailable')}{' '}
            <Link to={`/projects/${projectId}/health`} className="underline">
              {t('knowledge.linkHealth')}
            </Link>
          </p>
        ) : null}

        {searchQuery.isError ? (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {searchQuery.error?.message || t('search.error')}
          </p>
        ) : null}

        <div className="mt-5">
          {idle ? (
            <EmptyState icon={Search} title={t('search.idleTitle')} description={t('search.noQuery')} />
          ) : searchQuery.isFetching || waitingDebounce ? (
            <p className="text-sm text-muted-foreground" aria-busy="true">
              {t('search.loading')}
            </p>
          ) : items.length === 0 ? (
            <EmptyState icon={FileQuestion} title={t('search.emptyTitle')} description={t('search.emptyForQuery', { query })} />
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border bg-card">
              {items.map((result) => {
                const Icon = TYPE_ICON[result.type] || FileQuestion;
                return (
                  <div key={result.id} className="flex items-center gap-3 px-4 py-3">
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{result.title}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5">
                          {t(`search.type.${result.type}`, { defaultValue: result.type })}
                        </span>
                        {result.snippet}
                        {result.sourceRef?.path ? (
                          <>
                            {' '}
                            · <span className="font-mono">{result.sourceRef.path}</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    {result.sourceRef?.path ? (
                      <button
                        type="button"
                        className="text-xs text-brand hover:underline"
                        onClick={() =>
                          setPreviewTarget({
                            path: result.sourceRef.path,
                            startLine: result.sourceRef.startLine || 1,
                            endLine: result.sourceRef.endLine || result.sourceRef.startLine || 1,
                          })
                        }
                      >
                        {t('knowledge.open')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
                      onClick={() =>
                        navigate(`/projects/${projectId}/chat`, {
                          state: {
                            searchAttachment: {
                              id: result.id,
                              knowledgeVersionId: searchQuery.data?.knowledgeVersionId,
                              title: result.title,
                            },
                          },
                        })
                      }
                    >
                      {t('knowledge.askAboutThis')}
                      <ArrowRight className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <SourcePreviewDrawer projectId={projectId} target={previewTarget} onClose={() => setPreviewTarget(null)} />
    </div>
  );
}
