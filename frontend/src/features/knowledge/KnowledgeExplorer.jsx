import { useState } from 'react';
import { useOutletContext, Link } from 'react-router-dom';
import { ChevronRight, ChevronDown, Boxes, ArrowRight, BookOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/shared/components';
import { cn } from '@/shared/lib/utils';
/**
 * Expandable knowledge tree explorer for the current project.
 *
 * @returns Knowledge explorer panel
 */
export default function KnowledgeExplorer() {
    const { t } = useTranslation();
    const { project } = useOutletContext();
    const tree = project.knowledgeTree || [];
    const [expanded, setExpanded] = useState(() => Object.fromEntries(tree.map((node) => [node.label, true])));
    if (tree.length === 0) {
        return (<div className="h-full overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <EmptyState icon={BookOpen} title={t('knowledge.emptyTitle')} description={t('knowledge.emptyDescription')}/>
        </div>
      </div>);
    }
    /**
     * Toggle a knowledge node expansion state.
     *
     * @param label - Node label key
     */
    const toggle = (label) => {
        setExpanded((current) => ({ ...current, [label]: !current[label] }));
    };
    /**
     * Recursively render a knowledge tree node.
     *
     * @param node - Knowledge node
     * @param depth - Nesting depth
     * @returns Node element
     */
    const renderNode = (node, depth = 0) => {
        const hasChildren = Boolean(node.children?.length);
        const isOpen = expanded[node.label];
        return (<div key={node.label}>
        <div className={cn('flex items-center gap-2 rounded-lg py-1.5 pr-2 hover:bg-muted/50', depth === 0 && 'font-medium')} style={{ paddingLeft: depth * 18 + 8 }}>
          {hasChildren ? (<button type="button" onClick={() => toggle(node.label)} className="text-muted-foreground hover:text-foreground" aria-expanded={isOpen}>
              {isOpen ? (<ChevronDown className="h-4 w-4" aria-hidden="true"/>) : (<ChevronRight className="h-4 w-4" aria-hidden="true"/>)}
            </button>) : (<span className="w-4"/>)}
          <Boxes className={cn('h-4 w-4 shrink-0', depth === 0 ? 'text-brand' : 'text-muted-foreground')} aria-hidden="true"/>
          <span className="flex-1 truncate text-sm">{node.label}</span>
          {node.type && (<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {node.type}
            </span>)}
          {node.evidence && (<span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
              {node.evidence}
            </span>)}
          <Link to={`/projects/${project.id}/chat?q=${encodeURIComponent(`Explain ${node.label}`)}`} className="inline-flex items-center gap-0.5 text-xs text-brand hover:underline">
            {t('home.ask')}
            <ArrowRight className="h-3 w-3" aria-hidden="true"/>
          </Link>
        </div>
        {hasChildren && isOpen && (<div className="ml-2 border-l border-border">
            {(node.children || []).map((child) => renderNode(child, depth + 1))}
          </div>)}
      </div>);
    };
    return (<div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <h1 className="font-display text-xl font-medium">{t('knowledge.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('knowledge.subtitle')}</p>
        <div className="mt-5 rounded-xl border border-border bg-card p-3">
          {tree.map((node) => renderNode(node))}
        </div>
      </div>
    </div>);
}
