import { useOutletContext, Link } from 'react-router-dom';
import {
  Boxes,
  Workflow,
  Component,
  Plug,
  Database,
  ArrowRight,
  MessageSquare,
  BookOpen,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';

import { EmptyState, KnowledgeStatusBadge } from '@/shared/components';
import { Button } from '@/shared/ui/button';
import type { KnowledgeNode } from '@/shared/types/domain';

import type { ProjectOutletContext } from './ProjectDetailPage';

const SECTION_DEFS: { key: string; labelKey: string; icon: LucideIcon }[] = [
  { key: 'Workflow', labelKey: 'projects.workflows', icon: Workflow },
  { key: 'Service', labelKey: 'projects.services', icon: Component },
  { key: 'API', labelKey: 'projects.apis', icon: Plug },
  { key: 'Component', labelKey: 'projects.components', icon: Component },
  { key: 'Data', labelKey: 'projects.dataConcepts', icon: Database },
  { key: 'Integration', labelKey: 'projects.integrations', icon: Plug },
];

/**
 * Project overview briefing built from the knowledge tree.
 *
 * @returns Project overview panel
 */
export default function ProjectOverview() {
  const { t } = useTranslation();
  const { project } = useOutletContext<ProjectOutletContext>();
  const tree = project.knowledgeTree || [];
  const flat = tree.flatMap((node) => node.children || []);
  const byType = flat.reduce<Record<string, KnowledgeNode[]>>((acc, node) => {
    const bucket = acc[node.type] ?? [];
    bucket.push(node);
    acc[node.type] = bucket;
    return acc;
  }, {});

  if (tree.length === 0) {
    return (
      <div className="h-full overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-4xl px-6 py-8">
          <EmptyState
            icon={BookOpen}
            title={t('projects.knowledgeNotReadyTitle')}
            description={t('projects.knowledgeNotReadyDescription')}
            action={
              <Link to="/processing">
                <Button variant="outline">{t('nav.processing')}</Button>
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const sections = SECTION_DEFS.filter(
    (section) => (byType[section.key]?.length ?? 0) > 0,
  );

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <section className="animate-fade-in">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('projects.summary')}
          </h2>
          <p className="mt-2 text-[15px] leading-relaxed text-foreground/90">
            {project.description}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <KnowledgeStatusBadge status={String(project.knowledgeStatus)} />
            <span>·</span>
            <span>
              {t('projects.filesMapped', {
                count: project.fileCount.toLocaleString(),
              })}
            </span>
            {project.partial && (
              <>
                <span>·</span>
                <span className="text-amber-700">
                  {t('projects.excluded', { count: project.excludedCount })}
                </span>
              </>
            )}
            <span>·</span>
            <span>{t('chat.knowledgeVersion', { version: 'v3' })}</span>
          </div>
        </section>

        <section className="mt-8">
          <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Boxes className="h-3.5 w-3.5" aria-hidden="true" />
            {t('projects.capabilities')}
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {tree.map((capability) => (
              <Link
                key={capability.label}
                to={`/projects/${project.id}/knowledge`}
                className="group rounded-lg border border-border bg-card p-4 hover:border-brand/40"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-foreground group-hover:text-brand">
                    {capability.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('projects.itemCount', {
                      count: capability.children?.length || 0,
                    })}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {(capability.children || []).slice(0, 3).map((child) => (
                    <span
                      key={child.label}
                      className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      {child.label}
                    </span>
                  ))}
                  {(capability.children?.length || 0) > 3 && (
                    <span className="px-1 py-0.5 text-xs text-muted-foreground">
                      +{(capability.children!.length - 3)} {t('projects.more')}
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </section>

        {sections.map((section) => {
          const items = byType[section.key] ?? [];
          return (
            <section key={section.key} className="mt-8">
              <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <section.icon className="h-3.5 w-3.5" aria-hidden="true" />
                {t(section.labelKey)}
              </h2>
              <div className="mt-3 divide-y divide-border rounded-lg border border-border bg-card">
                {items.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between px-4 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {item.label}
                      </div>
                      {item.evidence && (
                        <div className="truncate font-mono text-xs text-muted-foreground">
                          {item.evidence}
                        </div>
                      )}
                    </div>
                    <Link
                      to={`/projects/${project.id}/chat?q=${encodeURIComponent(`Explain ${item.label}`)}`}
                      className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
                    >
                      {t('home.ask')}
                      <ArrowRight className="h-3 w-3" aria-hidden="true" />
                    </Link>
                  </div>
                ))}
              </div>
            </section>
          );
        })}

        <section className="mt-8 rounded-xl border border-border bg-gradient-to-br from-brand-muted/30 to-card p-5">
          <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
            {t('projects.knowledgeHealth')}
          </h2>
          <p className="mt-2 text-sm text-foreground/90">
            {project.partial
              ? t('projects.knowledgePartialNote', {
                  count: project.excludedCount,
                })
              : t('projects.knowledgeCompleteNote')}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to={`/projects/${project.id}/chat`}>
              <Button className="bg-brand text-brand-foreground hover:bg-brand/90">
                <MessageSquare className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('projects.openChat')}
              </Button>
            </Link>
            <Link to={`/projects/${project.id}/knowledge`}>
              <Button variant="outline">
                <BookOpen className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('knowledge.title')}
              </Button>
            </Link>
            <Link to={`/projects/${project.id}/health`}>
              <Button variant="outline">{t('health.title')}</Button>
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
