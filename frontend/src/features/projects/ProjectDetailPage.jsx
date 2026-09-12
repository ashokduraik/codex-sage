import {
  Archive,
  BookOpen,
  Database,
  GitCompare,
  HeartPulse,
  LayoutDashboard,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { ProjectLifecycleBadge } from '@/shared/components';
import { useAppData } from '@/shared/mock-data';
import { cn } from '@/shared/lib/utils';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog';
import { Button } from '@/shared/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { buildMockProjectBridge } from './buildMockProjectBridge.js';
import { ProjectDeleteDialog } from './ProjectDeleteDialog.jsx';
import { useProject } from './hooks/useProject.js';
import {
  useArchiveProject,
  useRestoreProject,
} from './hooks/useProjectMutations.js';
import { useRecordProjectAccess } from './hooks/useRecordProjectAccess.js';
import {
  correlationFromProjectError,
  isForbiddenProjectError,
  isNotFoundProjectError,
  messageFromProjectError,
  retryAfterFromProjectError,
} from './projectErrors.js';
import { isProjectArchived, isProjectAskable } from './projectStatusMap.js';

const PROJECT_TABS = [
  { to: '', labelKey: 'projects.overview', icon: LayoutDashboard },
  { to: '/chat', labelKey: 'nav.chat', icon: MessageSquare },
  { to: '/knowledge', labelKey: 'nav.knowledge', icon: BookOpen },
  { to: '/search', labelKey: 'nav.search', icon: Search },
  { to: '/changes', labelKey: 'changes.title', icon: GitCompare },
  { to: '/sources', labelKey: 'sources.title', icon: Database },
  { to: '/health', labelKey: 'health.title', icon: HeartPulse },
];

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
  const { getProject } = useAppData();
  const detailQuery = useProject(id);
  const archiveMutation = useArchiveProject();
  const restoreMutation = useRestoreProject();
  useRecordProjectAccess(id, {
    enabled: detailQuery.isSuccess && !isNotFoundProjectError(detailQuery.error),
  });

  const [activeConvId, setActiveConvId] = useState(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionError, setActionError] = useState('');

  const apiProject = detailQuery.data;
  const mockFallback = id ? getProject(id) : undefined;
  const mockProject = useMemo(
    () => (apiProject ? buildMockProjectBridge(apiProject, mockFallback) : null),
    [apiProject, mockFallback],
  );
  const archived = isProjectArchived(apiProject);
  const askable = isProjectAskable(apiProject);

  const context = useMemo(() => {
    if (!apiProject || !mockProject) {
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

  if (detailQuery.isError && isNotFoundProjectError(detailQuery.error)) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground">{t('projects.notFound')}</p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => navigate('/projects')}
          >
            {t('projects.backToProjects')}
          </Button>
        </div>
      </div>
    );
  }

  if (detailQuery.isError || !apiProject || !id || !context) {
    const message = messageFromProjectError(detailQuery.error, t('projects.detailFailed'));
    const correlationId = correlationFromProjectError(detailQuery.error);
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div role="alert" className="max-w-md text-center">
          <p className="text-muted-foreground">{message}</p>
          {correlationId ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('projects.correlationReference', { reference: correlationId })}
            </p>
          ) : null}
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => void detailQuery.refetch()}
          >
            {t('projects.retry')}
          </Button>
        </div>
      </div>
    );
  }

  const base = `/projects/${id}`;

  /**
   * Runs archive and surfaces errors inline.
   */
  const handleArchive = () => {
    setActionError('');
    archiveMutation.mutate(id, {
      onSuccess: () => setArchiveOpen(false),
      onError: (error) => {
        setActionError(
          isForbiddenProjectError(error)
            ? t('projects.forbidden')
            : messageFromProjectError(error, t('projects.detailFailed')),
        );
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
        setActionError(
          isForbiddenProjectError(error)
            ? t('projects.forbidden')
            : messageFromProjectError(error, t('projects.detailFailed')),
        );
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
              <h1 className="font-display text-xl font-medium text-foreground">
                {apiProject.name}
              </h1>
              <ProjectLifecycleBadge code={apiProject.lifecycleStatus} />
            </div>
            {apiProject.description ? (
              <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">
                {apiProject.description}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('common.actions')}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-48 space-y-1 p-2">
                {archived ? (
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
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => setArchiveOpen(true)}
                  >
                    <Archive className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t('projects.archive')}
                  </Button>
                )}
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
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <nav className="mt-3 flex gap-1 overflow-x-auto scrollbar-thin">
          {PROJECT_TABS.map((tab) => {
            const to = base + tab.to;
            const active =
              tab.to === ''
                ? location.pathname === base
                : location.pathname.startsWith(to);
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
                  active
                    ? 'bg-brand-muted text-brand'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
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
          <Button
            size="sm"
            variant="outline"
            onClick={handleRestore}
            disabled={restoreMutation.isPending}
            aria-busy={restoreMutation.isPending}
          >
            {restoreMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            {t('projects.restore')}
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <div role="alert" className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-sm sm:px-6">
          {actionError}
          {typeof retryAfterFromProjectError(archiveMutation.error || restoreMutation.error) ===
          'number' ? (
            <span className="ml-2 text-muted-foreground">
              {t('projects.retryAfter', {
                seconds: retryAfterFromProjectError(
                  archiveMutation.error || restoreMutation.error,
                ),
              })}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <Outlet context={context} />
      </div>

      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('projects.archiveConfirm', { name: apiProject.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('projects.archiveConfirmBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiveMutation.isPending}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleArchive}
              disabled={archiveMutation.isPending}
              aria-busy={archiveMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {archiveMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
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
