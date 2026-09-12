import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, MessageSquare, Sparkles, FolderKanban, Plus, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { KnowledgeHealthBadge } from '@/shared/components';
import { Button } from '@/shared/ui/button';
import { formatRelative } from '@/shared/lib/format';
import { useAppData, SUGGESTED_QUESTIONS } from '@/shared/mock-data';
import { flattenProjectPages, useProjects } from '@/features/projects/hooks/useProjects.js';
import {
  correlationFromProjectError,
  messageFromProjectError,
} from '@/features/projects/projectErrors.js';

/**
 * Home dashboard with suggested questions, recent projects, and conversations.
 *
 * @returns Home page
 */
export default function HomePage() {
  const { t } = useTranslation();
  const { conversations, getProject } = useAppData();
  const navigate = useNavigate();
  const recentQuery = useProjects({
    sort: 'lastAccessedAt',
    limit: 4,
    includeArchived: false,
  });
  const recentProjects = flattenProjectPages(recentQuery.data).slice(0, 4);
  const recentConversations = conversations
    .filter((conversation) => !conversation.archived)
    .slice(0, 4);

  /**
   * Navigate to project chat with a prefilled question.
   *
   * @param {string} projectId Target project id
   * @param {string} question Question text
   */
  const askAbout = (projectId, question) => {
    navigate(`/projects/${projectId}/chat?q=${encodeURIComponent(question)}`);
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-5xl px-6 py-10 sm:px-10">
        <section className="animate-fade-in">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs font-medium text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
            {t('home.eyebrow')}
          </div>
          <h1 className="mt-4 font-display text-4xl font-medium leading-tight tracking-tight text-foreground sm:text-5xl">
            {t('home.heroTitle')}
          </h1>
          <p className="mt-3 max-w-xl text-base text-muted-foreground">
            {t('home.heroSubtitle')}
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button
              size="lg"
              onClick={() => navigate('/projects')}
              className="bg-brand text-brand-foreground hover:bg-brand/90"
            >
              {t('home.askCta')}
              <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
            </Button>
            <Button size="lg" variant="outline" onClick={() => navigate('/projects')}>
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('home.newProject')}
            </Button>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t('home.suggestedQuestions')}
          </h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {SUGGESTED_QUESTIONS.map((question) => {
              const firstProject = recentProjects[0];
              return (
                <button
                  key={question}
                  type="button"
                  onClick={() => firstProject && askAbout(firstProject.id, question)}
                  disabled={!firstProject}
                  className="group flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3 text-left text-sm transition-colors hover:border-brand/40 hover:bg-brand-muted/20 disabled:opacity-50"
                >
                  <span className="text-foreground/90">{question}</span>
                  <ArrowRight
                    className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-brand"
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        </section>

        <div className="mt-10 grid gap-8 lg:grid-cols-2">
          <section>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {t('home.recentProjects')}
              </h2>
              <Link to="/projects" className="text-xs text-brand hover:underline">
                {t('home.viewAll')}
              </Link>
            </div>
            <div className="mt-3 space-y-2">
              {recentQuery.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-busy="true">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                </div>
              ) : null}
              {recentQuery.isError ? (
                <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                  <p>
                    {messageFromProjectError(recentQuery.error, t('home.projectsFailed'))}
                  </p>
                  {correlationFromProjectError(recentQuery.error) ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('projects.correlationReference', {
                        reference: correlationFromProjectError(recentQuery.error),
                      })}
                    </p>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => void recentQuery.refetch()}
                  >
                    {t('home.retry')}
                  </Button>
                </div>
              ) : null}
              {!recentQuery.isLoading && !recentQuery.isError && recentProjects.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('home.noProjectsYet')}</p>
              ) : null}
              {recentProjects.map((project) => (
                <Link
                  key={project.id}
                  to={`/projects/${project.id}`}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:bg-muted/40"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-muted text-brand">
                    <FolderKanban className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{project.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {project.description}
                    </div>
                  </div>
                  <KnowledgeHealthBadge code={project.knowledgeHealth} />
                </Link>
              ))}
            </div>
          </section>

          <section className="space-y-8">
            <div>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('home.recentConversations')}
                </h2>
                <Link to="/conversations" className="text-xs text-brand hover:underline">
                  {t('home.all')}
                </Link>
              </div>
              <div className="mt-3 space-y-2">
                {recentConversations.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t('home.noConversationsYet')}
                  </p>
                ) : null}
                {recentConversations.map((conversation) => {
                  const project = getProject(conversation.projectId);
                  return (
                    <Link
                      key={conversation.id}
                      to={`/projects/${conversation.projectId}/chat?conv=${conversation.id}`}
                      className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:bg-muted/40"
                    >
                      <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {conversation.title}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {project?.name} · {formatRelative(conversation.createdAt)}
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>

            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {t('home.knowledgeStatus')}
              </h2>
              <div className="mt-3 space-y-2">
                {recentProjects.map((project) => (
                  <Link
                    key={project.id}
                    to={`/projects/${project.id}/health`}
                    className="flex items-center justify-between rounded-lg border border-border bg-card p-3 hover:bg-muted/40"
                  >
                    <span className="truncate text-sm">{project.name}</span>
                    <KnowledgeHealthBadge code={project.knowledgeHealth} />
                  </Link>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
