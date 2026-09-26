/**
 * Knowledge explorer backed by the Phase 37 browse API.
 */
import { useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { ArrowRight, BookOpen, Boxes, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/shared/components';
import { useKnowledgeFacet, useKnowledgeFacets, useKnowledgeHealth } from './hooks/useKnowledgeFacets.js';
import SourcePreviewDrawer from './SourcePreviewDrawer.jsx';

/**
 * @param {{
 *   projectId: string,
 *   facetKey: string,
 *   expanded: boolean,
 *   knowledgeVersionId: string | null,
 *   onOpen: (target: object) => void,
 *   onAsk: (item: object) => void,
 * }} props Facet body props.
 * @returns {import('react').ReactElement | null}
 */
function FacetBody({ projectId, facetKey, expanded, knowledgeVersionId, onOpen, onAsk }) {
  const { t } = useTranslation();
  const [symbolQ, setSymbolQ] = useState('');
  const needsSymbolQ = facetKey === 'symbols';
  const facetQuery = useKnowledgeFacet(projectId, facetKey, {
    q: symbolQ,
    enabled: expanded && (!needsSymbolQ || symbolQ.trim().length >= 2),
  });

  if (!expanded) {
    return null;
  }

  if (needsSymbolQ && symbolQ.trim().length < 2) {
    return (
      <input
        value={symbolQ}
        onChange={(event) => setSymbolQ(event.target.value)}
        placeholder={t('knowledge.symbolQuery')}
        className="mt-2 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
      />
    );
  }

  if (facetQuery.isLoading) {
    return (
      <p className="mt-2 text-xs text-muted-foreground" aria-busy="true">
        {t('knowledge.loadingFacet')}
      </p>
    );
  }
  if (facetQuery.isError) {
    return (
      <p className="mt-2 text-xs text-destructive" role="alert">
        {facetQuery.error?.message || t('knowledge.error')}
      </p>
    );
  }

  const payload = facetQuery.data ?? {};
  if (facetKey === 'summary' || facetKey === 'documentation') {
    if (!payload.summary) {
      return <p className="mt-2 text-xs text-muted-foreground">{t('knowledge.emptyFacet')}</p>;
    }
    return <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{payload.summary}</p>;
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length === 0) {
    return <p className="mt-2 text-xs text-muted-foreground">{t('knowledge.emptyFacet')}</p>;
  }

  return (
    <div className="mt-1">
      {needsSymbolQ ? (
        <input
          value={symbolQ}
          onChange={(event) => setSymbolQ(event.target.value)}
          placeholder={t('knowledge.symbolQuery')}
          className="mb-2 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
        />
      ) : null}
      {items.map((item) => {
        const title = item.title || item.name;
        const sourceRef = item.sourceRef || item.sourceRefs?.[0];
        return (
          <div key={item.id || title} className="flex items-center gap-2 rounded-lg py-1.5 pr-2 hover:bg-muted/50">
            <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
            {sourceRef?.path ? <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">{sourceRef.path}</span> : null}
            {sourceRef?.path ? (
              <button
                type="button"
                className="text-xs text-brand hover:underline"
                onClick={() =>
                  onOpen({
                    path: sourceRef.path,
                    startLine: sourceRef.startLine || 1,
                    endLine: sourceRef.endLine || sourceRef.startLine || 1,
                  })
                }
              >
                {t('knowledge.open')}
              </button>
            ) : null}
            <button
              type="button"
              className="inline-flex items-center gap-0.5 text-xs text-brand hover:underline"
              onClick={() =>
                onAsk({
                  id: item.id,
                  knowledgeVersionId,
                  title,
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
  );
}

/**
 * Knowledge explorer for the current project.
 *
 * @returns {import('react').ReactElement}
 */
export default function KnowledgeExplorer() {
  const { t } = useTranslation();
  const { project } = useOutletContext();
  const navigate = useNavigate();
  const projectId = project?.id;
  const facetsQuery = useKnowledgeFacets(projectId);
  const healthQuery = useKnowledgeHealth(projectId);
  const [expanded, setExpanded] = useState({});
  const [previewTarget, setPreviewTarget] = useState(null);

  const state = facetsQuery.data?.state;
  const facets = Array.isArray(facetsQuery.data?.facets) ? facetsQuery.data.facets : [];
  const knowledgeVersionId = facetsQuery.data?.knowledgeVersionId ?? null;

  /**
   * @param {string} key Facet key.
   */
  const toggle = (key) => {
    setExpanded((current) => ({ ...current, [key]: !current[key] }));
  };

  /**
   * @param {{ id?: string, knowledgeVersionId?: string, title?: string }} item Attachment.
   */
  const askAbout = (item) => {
    navigate(`/projects/${projectId}/chat`, {
      state: {
        searchAttachment: {
          id: item.id,
          knowledgeVersionId: item.knowledgeVersionId ?? knowledgeVersionId,
          title: item.title,
        },
      },
    });
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="font-display text-xl font-medium">{t('knowledge.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('knowledge.subtitle')}</p>

        {healthQuery.data?.dimensions ? (
          <div className="mt-4 rounded-lg border border-border bg-card px-4 py-3 text-sm">
            <div className="font-medium">{t('knowledge.healthTitle')}</div>
            <p className="mt-1 text-muted-foreground">{healthQuery.data.dimensions.publishedHealth?.state || healthQuery.data.knowledgeHealth}</p>
          </div>
        ) : null}

        {facetsQuery.isLoading ? (
          <p className="mt-5 text-sm text-muted-foreground" aria-busy="true">
            {t('knowledge.loading')}
          </p>
        ) : null}
        {facetsQuery.isError ? (
          <p className="mt-5 text-sm text-destructive" role="alert">
            {facetsQuery.error?.message || t('knowledge.error')}
          </p>
        ) : null}
        {state && state !== 'ready' ? (
          <p className="mt-5 text-sm text-amber-800" role="alert">
            {state === 'updating' ? t('knowledge.updating') : t('knowledge.unavailable')}{' '}
            <Link to={`/projects/${projectId}/health`} className="underline">
              {t('knowledge.linkHealth')}
            </Link>
          </p>
        ) : null}

        {!facetsQuery.isLoading && state === 'ready' && facets.length === 0 ? (
          <div className="mt-5">
            <EmptyState icon={BookOpen} title={t('knowledge.emptyTitle')} description={t('knowledge.emptyDescription')} />
          </div>
        ) : null}

        {facets.length > 0 ? (
          <div className="mt-5 rounded-xl border border-border bg-card p-3">
            {facets.map((facet) => {
              const key = facet.key;
              const isOpen = Boolean(expanded[key]);
              return (
                <div key={key}>
                  <div className="flex items-center gap-2 rounded-lg py-1.5 pr-2 font-medium hover:bg-muted/50">
                    <button
                      type="button"
                      onClick={() => toggle(key)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-expanded={isOpen}
                      aria-label={t(`knowledge.facet.${key}`, { defaultValue: key })}
                    >
                      {isOpen ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
                    </button>
                    <Boxes className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
                    <span className="flex-1 truncate text-sm">{t(`knowledge.facet.${key}`, { defaultValue: key })}</span>
                  </div>
                  <div className="ml-6 border-l border-border pl-2">
                    <FacetBody
                      projectId={projectId}
                      facetKey={key}
                      expanded={isOpen}
                      knowledgeVersionId={knowledgeVersionId}
                      onOpen={setPreviewTarget}
                      onAsk={askAbout}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
      <SourcePreviewDrawer projectId={projectId} target={previewTarget} onClose={() => setPreviewTarget(null)} />
    </div>
  );
}
