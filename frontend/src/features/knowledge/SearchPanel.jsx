import { useMemo, useState } from 'react';
import { useOutletContext, Link } from 'react-router-dom';
import { Search, FileCode, BookOpen, Boxes, Workflow, Plug, Database, ArrowRight, FileQuestion, } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/shared/components';
import { Input } from '@/shared/ui/input';
import { cn } from '@/shared/lib/utils';
const TYPE_KEYS = [
    'all',
    'Code',
    'Documentation',
    'Functionality',
    'Workflows',
    'APIs',
    'Data',
    'Other',
];
const TYPE_ICON = {
    Code: FileCode,
    Documentation: BookOpen,
    Functionality: Boxes,
    Workflows: Workflow,
    APIs: Plug,
    Data: Database,
    Other: FileQuestion,
};
/**
 * Build a searchable index from the project knowledge tree plus mock docs.
 *
 * @param project - Current project
 * @returns Flat search index
 */
function buildIndex(project) {
    const index = [];
    (project.knowledgeTree || []).forEach((capability) => {
        index.push({
            type: 'Functionality',
            title: capability.label,
            detail: 'Capability',
            evidence: null,
        });
        (capability.children || []).forEach((child) => {
            const mappedType = child.type === 'Workflow'
                ? 'Workflows'
                : child.type === 'API'
                    ? 'APIs'
                    : child.type === 'Data'
                        ? 'Data'
                        : child.type === 'Service'
                            ? 'Code'
                            : child.type === 'Integration'
                                ? 'APIs'
                                : 'Other';
            index.push({
                type: mappedType,
                title: child.label,
                detail: capability.label,
                evidence: child.evidence ?? null,
            });
        });
    });
    index.push({
        type: 'Documentation',
        title: 'README — getting started',
        detail: 'Docs',
        evidence: 'README.md',
    });
    index.push({
        type: 'Documentation',
        title: 'Architecture overview',
        detail: 'Docs',
        evidence: 'docs/architecture.md',
    });
    index.push({
        type: 'Code',
        title: 'Route definitions',
        detail: 'Server',
        evidence: 'src/server/routes.ts',
    });
    return index;
}
/**
 * Project knowledge search panel with type filters.
 *
 * @returns Search panel
 */
export default function SearchPanel() {
    const { t } = useTranslation();
    const { project } = useOutletContext();
    const [query, setQuery] = useState('');
    const [type, setType] = useState('all');
    const index = useMemo(() => buildIndex(project), [project]);
    const results = useMemo(() => {
        if (!query.trim())
            return [];
        return index.filter((item) => {
            if (type !== 'all' && item.type !== type)
                return false;
            return `${item.title} ${item.detail} ${item.evidence || ''}`
                .toLowerCase()
                .includes(query.toLowerCase());
        });
    }, [query, type, index]);
    return (<div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="font-display text-xl font-medium">{t('search.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('search.subtitle')}</p>

        <div className="relative mt-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true"/>
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('search.placeholder')} className="h-11 pl-9 text-base" autoFocus/>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {TYPE_KEYS.map((typeKey) => (<button key={typeKey} type="button" onClick={() => setType(typeKey)} className={cn('rounded-full px-3 py-1 text-xs font-medium transition-colors', type === typeKey
                ? 'bg-brand text-brand-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/70')}>
              {typeKey === 'all' ? t('home.all') : typeKey}
            </button>))}
        </div>

        <div className="mt-5">
          {query.trim() === '' ? (<EmptyState icon={Search} title={t('search.idleTitle')} description={t('search.noQuery')}/>) : results.length === 0 ? (<EmptyState icon={FileQuestion} title={t('search.emptyTitle')} description={t('search.emptyForQuery', { query })}/>) : (<div className="divide-y divide-border rounded-lg border border-border bg-card">
              {results.map((result) => {
                const Icon = TYPE_ICON[result.type] || FileQuestion;
                return (<div key={`${result.type}-${result.title}-${result.evidence}`} className="flex items-center gap-3 px-4 py-3">
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true"/>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {result.title}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5">
                          {result.type}
                        </span>
                        {result.detail}
                        {result.evidence && (<>
                            {' '}
                            ·{' '}
                            <span className="font-mono">{result.evidence}</span>
                          </>)}
                      </div>
                    </div>
                    <Link to={`/projects/${project.id}/chat?q=${encodeURIComponent(result.title)}`} className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
                      {t('home.ask')}
                      <ArrowRight className="h-3 w-3" aria-hidden="true"/>
                    </Link>
                  </div>);
            })}
            </div>)}
        </div>
      </div>
    </div>);
}
