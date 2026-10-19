import { cn } from '@/shared/lib/utils';
import { useMemo, useState } from 'react';
import { Button } from '@/shared/ui/button';
import { useTranslation } from 'react-i18next';
import { useAppData } from '@/shared/mock-data';
import { useProject } from './hooks/useProject.js';
import { useAuth } from '@/features/auth/AuthContext';
import { ProjectDeleteDialog } from './ProjectDeleteDialog.jsx';
import { useRecordProjectAccess } from './hooks/useRecordProjectAccess.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useArchiveProject, useRestoreProject } from './hooks/useProjectMutations.js';
import { ProjectLifecycleBadge, isProjectArchived, isProjectAskable } from '@/shared/components/StatusBadge.jsx';
import { correlationFromUnknown, isForbiddenApiError, isNotFoundApiError, messageFromUnknown, retryAfterFromUnknown } from '@/shared/api';
import {
  Search,
  Trash2,
  Archive,
  Loader2,
  Activity,
  BookOpen,
  Database,
  RotateCcw,
  GitCompare,
  HeartPulse,
  MessageSquare,
  MoreHorizontal,
  LayoutDashboard,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogTitle,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogContent,
  AlertDialogDescription,
} from '@/shared/ui/alert-dialog';

/**
 * Project sub-nav tabs. `anyOf` = show when the user holds at least one listed permission;
 * omit `anyOf` for tabs every project viewer may open (Overview, Processing).
 */
const PROJECT_TABS = [
  { to: '', labelKey: 'projects.overview', icon: LayoutDashboard },
  { to: '/chat', labelKey: 'nav.chat', icon: MessageSquare, anyOf: ['chat.ask'] },
  { to: '/knowledge', labelKey: 'nav.knowledge', icon: BookOpen, anyOf: ['knowledge.browse', 'knowledge.view'] },
  { to: '/search', labelKey: 'nav.search', icon: Search, anyOf: ['search.run'] },
  { to: '/changes', labelKey: 'changes.title', icon: GitCompare, anyOf: ['knowledge.browse', 'knowledge.view'] },
  { to: '/sources', labelKey: 'sources.title', icon: Database, anyOf: ['sources.preview', 'sources.upload', 'repos.connect'] },
  { to: '/processing', labelKey: 'nav.processing', icon: Activity },
  { to: '/health', labelKey: 'health.title', icon: HeartPulse, anyOf: ['knowledge.view'] },
];

/**
 * Returns whether the caller holds at least one of the required keys.
 * @param {Iterable<string> | null | undefined} permissions Effective permission keys.
 * @param {string[] | undefined} anyOf Required keys (any match). Undefined = always allowed.
 * @returns {boolean}
 */
export function hasAnyPermission(permissions, anyOf) {
  if (!anyOf || anyOf.length === 0) {
    return true;
  }
  const set = permissions instanceof Set ? permissions : new Set(Array.isArray(permissions) ? permissions : []);
  return anyOf.some((key) => set.has(key));
}

/**
 * Picks the PROJECT_TABS entry that matches the current path under a project base.
 * @param {string} pathname Location pathname.
 * @param {string} base Project base path (`/projects/:id`).
 * @returns {(typeof PROJECT_TABS)[number] | null}
 */
export function matchProjectTabForPath(pathname, base) {
  const ranked = [...PROJECT_TABS].filter((tab) => tab.to !== '').sort((left, right) => right.to.length - left.to.length);
  for (const tab of ranked) {
    if (pathname.startsWith(base + tab.to)) {
      return tab;
    }
  }
  if (pathname === base || pathname === `${base}/`) {
    return PROJECT_TABS.find((tab) => tab.to === '') ?? null;
  }
  return null;
}

/**
 * Maps backend lifecycle codes onto legacy mock status display strings for panels.
 * @param {string} lifecycleStatus Backend code.
 * @returns {string}
 */
function mockStatusFromLifecycle(lifecycleStatus) {
  /** @type {Record<string, string>} */
  const map = {
    creating: 'Creating',
    awaiting_source: 'Awaiting source',
    connecting_repository: 'Connecting repository',
    source_received: 'Source received',
    processing: 'Processing',
    knowledge_ready: 'Knowledge ready',
    updating: 'Updating',
    failed: 'Failed',
    partially_available: 'Partially available',
    archived: 'Archived',
  };
  return map[lifecycleStatus] ?? 'Creating';
}

/**
 * Maps backend knowledgeHealth onto legacy mock knowledge status strings.
 * @param {string} knowledgeHealth Backend code.
 * @returns {string}
 */
function mockKnowledgeFromHealth(knowledgeHealth) {
  /** @type {Record<string, string>} */
  const map = {
    none: 'Needs attention',
    updating: 'Updating',
    ready: 'Ready',
    partially_available: 'Partially available',
    stale: 'Outdated',
    failed: 'Needs attention',
  };
  return map[knowledgeHealth] ?? 'Needs attention';
}

/**
 * Builds the mock-shaped project bridge for panels still on useAppData fields.
 * @param {import('./api/projectsApi.js').ProjectDto} apiProject API project DTO.
 * @param {object | undefined} mockFallback Optional mock project from AppData.
 * @returns {object} Mock-compatible project for Sources/Health/Chat/Knowledge.
 */
export function buildMockProjectBridge(apiProject, mockFallback) {
  if (mockFallback) {
    return {
      ...mockFallback,
      id: apiProject.id,
      name: apiProject.name,
      description: apiProject.description ?? mockFallback.description,
      status: mockStatusFromLifecycle(apiProject.lifecycleStatus),
      knowledgeStatus: mockKnowledgeFromHealth(apiProject.knowledgeHealth),
    };
  }

  const sourceType = apiProject.sourceConfig?.sourceType;
  return {
    id: apiProject.id,
    name: apiProject.name,
    description: apiProject.description ?? '',
    status: mockStatusFromLifecycle(apiProject.lifecycleStatus),
    knowledgeStatus: mockKnowledgeFromHealth(apiProject.knowledgeHealth),
    knowledgeTree: [],
    fileCount: apiProject.counts?.files ?? 0,
    excludedCount: apiProject.counts?.excludedFiles ?? 0,
    partial: (apiProject.counts?.excludedFiles ?? 0) > 0,
    source: sourceType === 'repository' ? { type: 'repo', fullName: '', url: '', branch: '' } : { type: 'upload', origin: 'Upload' },
    createdAt: apiProject.createdAt,
    createdBy: apiProject.createdBy ?? '',
  };
}

/**
 * Project detail shell with sub-navigation and nested tab routes.
 *
 * @returns Project detail layout or a not-found state.
 */
export default function ProjectDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { getProject } = useAppData();
  const detailQuery = useProject(id);
  const archiveMutation = useArchiveProject();
  const restoreMutation = useRestoreProject();
  useRecordProjectAccess(id, {
    enabled: detailQuery.isSuccess && !isNotFoundApiError(detailQuery.error),
  });

  const [activeConvId, setActiveConvId] = useState(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionError, setActionError] = useState('');

  const permissions = user?.permissions;
  const canUpdateProject = Boolean(user?.permissions?.includes('projects.update'));
  const canDeleteProject = Boolean(user?.permissions?.includes('projects.delete'));
  const visibleTabs = useMemo(() => PROJECT_TABS.filter((tab) => hasAnyPermission(permissions, tab.anyOf)), [permissions]);

  const apiProject = detailQuery.data;
  const mockFallback = id ? getProject(id) : undefined;
  const mockProject = useMemo(() => (apiProject ? buildMockProjectBridge(apiProject, mockFallback) : null), [apiProject, mockFallback]);
  const archived = isProjectArchived(apiProject);
  const askable = isProjectAskable(apiProject);

  // Chat uses API `project`. mockProject remains for Overview until that panel migrates.
  const context = useMemo(() => {
    if (!apiProject) {
      return null;
    }
    return {
      project: apiProject,
      mockProject,
      activeConvId,
      setActiveConvId,
    };
  }, [apiProject, mockProject, activeConvId]);

  if (detailQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center" aria-busy="true">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    );
  }

  if (detailQuery.isError && isNotFoundApiError(detailQuery.error)) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground">{t('projects.notFound')}</p>
          <Button variant="outline" className="mt-3" onClick={() => navigate('/projects')}>
            {t('projects.backToProjects')}
          </Button>
        </div>
      </div>
    );
  }

  if (detailQuery.isError || !apiProject || !id || !context) {
    const message = messageFromUnknown(detailQuery.error, t('projects.detailFailed'));
    const correlationId = correlationFromUnknown(detailQuery.error);
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div role="alert" className="max-w-md text-center">
          <p className="text-muted-foreground">{message}</p>
          {correlationId ? (
            <p className="mt-1 text-xs text-muted-foreground">{t('projects.correlationReference', { reference: correlationId })}</p>
          ) : null}
          <Button variant="outline" className="mt-3" onClick={() => void detailQuery.refetch()}>
            {t('projects.retry')}
          </Button>
        </div>
      </div>
    );
  }

  const base = `/projects/${id}`;
  const matchedTab = matchProjectTabForPath(location.pathname, base);
  const tabAllowed = !matchedTab || hasAnyPermission(permissions, matchedTab.anyOf);
  const showActionsMenu = canUpdateProject || canDeleteProject;

  /**
   * Runs archive and surfaces errors inline.
   */
  const handleArchive = () => {
    setActionError('');
    archiveMutation.mutate(id, {
      onSuccess: () => setArchiveOpen(false),
      onError: (error) => {
        setActionError(isForbiddenApiError(error) ? t('projects.forbidden') : messageFromUnknown(error, t('projects.detailFailed')));
      },
    });
  };

  /**
   * Runs restore and surfaces errors inline.
   */
  const handleRestore = () => {
    setActionError('');
    restoreMutation.mutate(id, {
      onError: (error) => {
        setActionError(isForbiddenApiError(error) ? t('projects.forbidden') : messageFromUnknown(error, t('projects.detailFailed')));
      },
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-card/50 px-4 py-3 sm:px-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Link to="/projects" className="hover:text-foreground">
                {t('projects.breadcrumb')}
              </Link>
              <span>/</span>
              <span className="truncate text-foreground/70">{apiProject.name}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <h1 className="font-display text-xl font-medium text-foreground">{apiProject.name}</h1>
              <ProjectLifecycleBadge code={apiProject.lifecycleStatus} />
            </div>
            {apiProject.description ? <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{apiProject.description}</p> : null}
          </div>
          {showActionsMenu ? (
            <div className="flex items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={t('common.actions')}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-48 space-y-1 p-2">
                  {canUpdateProject && archived ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                      onClick={handleRestore}
                      disabled={restoreMutation.isPending}
                    >
                      <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                      {t('projects.restore')}
                    </Button>
                  ) : null}
                  {canUpdateProject && !archived ? (
                    <Button type="button" variant="ghost" size="sm" className="w-full justify-start" onClick={() => setArchiveOpen(true)}>
                      <Archive className="mr-2 h-4 w-4" aria-hidden="true" />
                      {t('projects.archive')}
                    </Button>
                  ) : null}
                  {canDeleteProject ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start text-destructive hover:text-destructive"
                      onClick={() => setDeleteOpen(true)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                      {t('projects.delete')}
                    </Button>
                  ) : null}
                </PopoverContent>
              </Popover>
            </div>
          ) : null}
        </div>

        <nav className="mt-3 flex gap-1 overflow-x-auto scrollbar-thin">
          {visibleTabs.map((tab) => {
            const to = base + tab.to;
            const active = tab.to === '' ? location.pathname === base : location.pathname.startsWith(to);
            const isChat = tab.to === '/chat';
            const disabled = isChat && !askable;
            if (disabled) {
              return (
                <span
                  key={tab.to || 'overview'}
                  aria-disabled="true"
                  title={t('chat.archivedPlaceholder')}
                  className="inline-flex cursor-not-allowed items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground/50"
                >
                  <tab.icon className="h-4 w-4" />
                  {t(tab.labelKey)}
                </span>
              );
            }
            return (
              <Link
                key={tab.to || 'overview'}
                to={to}
                className={cn(
                  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  active ? 'bg-brand-muted text-brand' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <tab.icon className="h-4 w-4" />
                {t(tab.labelKey)}
              </Link>
            );
          })}
        </nav>
      </div>

      {archived ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 sm:px-6">
          <span>{t('projects.archivedBanner')}</span>
          {canUpdateProject ? (
            <Button size="sm" variant="outline" onClick={handleRestore} disabled={restoreMutation.isPending} aria-busy={restoreMutation.isPending}>
              {restoreMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              {t('projects.restore')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {actionError ? (
        <div role="alert" className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-sm sm:px-6">
          {actionError}
          {typeof retryAfterFromUnknown(archiveMutation.error || restoreMutation.error) === 'number' ? (
            <span className="ml-2 text-muted-foreground">
              {t('projects.retryAfter', {
                seconds: retryAfterFromUnknown(archiveMutation.error || restoreMutation.error),
              })}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {tabAllowed ? (
          <Outlet context={context} />
        ) : (
          <div className="flex h-full items-center justify-center px-6">
            <p role="alert" className="max-w-md text-center text-sm text-destructive">
              {t('errors.forbidden')}
            </p>
          </div>
        )}
      </div>

      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('projects.archiveConfirm', { name: apiProject.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t('projects.archiveConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiveMutation.isPending}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleArchive}
              disabled={archiveMutation.isPending}
              aria-busy={archiveMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {archiveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {t('projects.archive')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ProjectDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        projectId={id}
        projectName={apiProject.name}
        onDeleted={() => navigate('/projects')}
      />
    </div>
  );
}
