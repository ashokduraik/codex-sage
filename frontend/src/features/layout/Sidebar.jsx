import { BookOpen, ChevronLeft, ChevronRight, FolderKanban, Home, MessageSquare, MessagesSquare, Search, Shield, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useProject } from '@/features/projects/hooks/useProject.js';
import { cn } from '@/shared/lib/utils';

const PRIMARY_NAV = [
  { to: '/', labelKey: 'nav.home', icon: Home },
  { to: '/projects', labelKey: 'nav.projects', icon: FolderKanban },
  { to: '/chat', labelKey: 'nav.chat', icon: MessageSquare },
  { to: '/knowledge', labelKey: 'nav.knowledge', icon: BookOpen },
  { to: '/search', labelKey: 'nav.search', icon: Search },
  { to: '/conversations', labelKey: 'nav.conversations', icon: MessagesSquare },
];

/**
 * Primary app navigation sidebar with brand, nav links, and collapse control.
 *
 * @param {{
 *   collapsed: boolean,
 *   onToggle: () => void,
 *   onNavigate?: () => void,
 * }} props Sidebar display and interaction props.
 * @returns Sidebar aside element.
 */
export default function Sidebar({ collapsed, onToggle, onNavigate }) {
  const { t } = useTranslation();
  const location = useLocation();
  const params = useParams();
  const routeProjectId = location.pathname.startsWith('/projects/') ? params.id || location.pathname.split('/')[2] : undefined;
  const activeProjectQuery = useProject(routeProjectId, {
    enabled: Boolean(routeProjectId),
  });
  const activeProject = activeProjectQuery.data;

  /**
   * Renders a single nav link with active styling.
   *
   * @param {string} to Destination path.
   * @param {string} label Localized label.
   * @param {import('lucide-react').LucideIcon} Icon Lucide icon component.
   * @returns Nav link element.
   */
  function renderNavItem(to, label, Icon) {
    const active = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to);
    return (
      <Link
        key={to}
        to={to}
        onClick={onNavigate}
        title={collapsed ? label : undefined}
        className={cn(
          'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          collapsed && 'justify-center px-0',
          active ? 'bg-brand-muted text-brand' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <Icon className={cn('h-[18px] w-[18px] shrink-0', active && 'text-brand')} />
        {!collapsed ? <span className="truncate">{label}</span> : null}
      </Link>
    );
  }

  return (
    <aside className={cn('flex h-full flex-col border-r border-border bg-sidebar', collapsed ? 'w-[60px]' : 'w-[232px]')}>
      <div className={cn('flex h-14 items-center gap-2 border-b border-border px-3', collapsed && 'justify-center px-0')}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-foreground">
          <Sparkles className="h-4 w-4" />
        </div>
        {!collapsed ? (
          <div className="min-w-0">
            <div className="font-display text-[15px] font-medium leading-tight text-foreground">{t('nav.productName')}</div>
            <div className="truncate text-[11px] text-muted-foreground">{t('nav.productTagline')}</div>
          </div>
        ) : null}
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-2 scrollbar-thin">
        {PRIMARY_NAV.map((item) => renderNavItem(item.to, t(item.labelKey), item.icon))}
        <div className="my-2 border-t border-border" />
        {renderNavItem('/admin', t('nav.administration'), Shield)}
      </nav>

      {!collapsed && activeProject ? (
        <div className="border-t border-border p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{t('nav.currentProject')}</div>
          <div className="mt-0.5 truncate text-sm font-medium text-foreground">{activeProject.name}</div>
        </div>
      ) : null}

      <div className={cn('border-t border-border p-2', collapsed && 'flex justify-center')}>
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" aria-label={t('nav.expand')} />
          ) : (
            <>
              <ChevronLeft className="h-4 w-4" />
              {t('nav.collapse')}
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
