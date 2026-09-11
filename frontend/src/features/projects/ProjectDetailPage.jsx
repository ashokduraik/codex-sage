import { Archive, BookOpen, Database, GitCompare, HeartPulse, LayoutDashboard, MessageSquare, MoreHorizontal, RotateCcw, Search, } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation, useNavigate, useParams, } from 'react-router-dom';
import { ProjectStatusBadge } from '@/shared/components';
import { useAppData } from '@/shared/mock-data';
import { cn } from '@/shared/lib/utils';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, } from '@/shared/ui/alert-dialog';
import { Button } from '@/shared/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, } from '@/shared/ui/dropdown-menu';
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
    const { getProject, archiveProject } = useAppData();
    const project = id ? getProject(id) : undefined;
    const [activeConvId, setActiveConvId] = useState(null);
    const [archiveOpen, setArchiveOpen] = useState(false);
    const isArchived = project?.status === 'Archived';
    const context = useMemo(() => {
        if (!project)
            return null;
        return { project, activeConvId, setActiveConvId };
    }, [project, activeConvId]);
    if (!project || !id || !context) {
        return (<div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground">{t('projects.notFound')}</p>
          <Button variant="outline" className="mt-3" onClick={() => navigate('/projects')}>
            {t('projects.backToProjects')}
          </Button>
        </div>
      </div>);
    }
    const base = `/projects/${id}`;
    return (<div className="flex h-full flex-col">
      <div className="border-b border-border bg-card/50 px-4 py-3 sm:px-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Link to="/projects" className="hover:text-foreground">
                {t('projects.breadcrumb')}
              </Link>
              <span>/</span>
              <span className="truncate text-foreground/70">{project.name}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <h1 className="font-display text-xl font-medium text-foreground">
                {project.name}
              </h1>
              <ProjectStatusBadge status={project.status}/>
            </div>
            {project.description ? (<p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">
                {project.description}
              </p>) : null}
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('common.actions')}>
                  <MoreHorizontal className="h-4 w-4"/>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {isArchived ? (<DropdownMenuItem onClick={() => {
                archiveProject(id, false);
            }}>
                    <RotateCcw className="mr-2 h-4 w-4"/>
                    {t('projects.restore')}
                  </DropdownMenuItem>) : (<DropdownMenuItem onClick={() => setArchiveOpen(true)} className="text-destructive focus:text-destructive">
                    <Archive className="mr-2 h-4 w-4"/>
                    {t('projects.archive')}
                  </DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <nav className="mt-3 flex gap-1 overflow-x-auto scrollbar-thin">
          {PROJECT_TABS.map((tab) => {
            const to = base + tab.to;
            const active = tab.to === ''
                ? location.pathname === base
                : location.pathname.startsWith(to);
            return (<Link key={tab.to || 'overview'} to={to} className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors', active
                    ? 'bg-brand-muted text-brand'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                <tab.icon className="h-4 w-4"/>
                {t(tab.labelKey)}
              </Link>);
        })}
        </nav>
      </div>

      {isArchived && (<div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 sm:px-6">
          {t('projects.archivedBanner')}
        </div>)}

      <div className="min-h-0 flex-1">
        <Outlet context={context}/>
      </div>

      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('projects.archiveConfirm', { name: project.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('projects.archiveConfirmBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => archiveProject(id, true)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t('projects.archive')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>);
}
