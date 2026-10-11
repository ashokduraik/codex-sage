import { useMemo } from 'react';
import { cn } from '@/shared/lib/utils';
import { useTranslation } from 'react-i18next';
import { Outlet, NavLink } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { Users, ShieldCheck, FolderKanban, Clock, BarChart3, ScrollText } from 'lucide-react';

const ITEMS = [
  { to: '/admin/users', labelKey: 'admin.users', icon: Users },
  { to: '/admin/roles', labelKey: 'admin.roles', icon: ShieldCheck },
  { to: '/admin/projects', labelKey: 'admin.projects', icon: FolderKanban },
  { to: '/admin/retention', labelKey: 'admin.retention', icon: Clock },
  { to: '/admin/usage', labelKey: 'admin.usage', icon: BarChart3, requiredPermission: 'usage.view' },
  {
    to: '/admin/audit',
    labelKey: 'admin.audit',
    icon: ScrollText,
    requiredPermission: 'audit.view',
  },
];

/**
 * Administration shell with sidebar and mobile tab nav.
 *
 * @returns Admin layout
 */
export default function AdminLayout() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  const permissions = currentUser?.permissions;

  const visibleItems = useMemo(
    () =>
      ITEMS.filter((item) => {
        if (!item.requiredPermission) {
          return true;
        }
        return Array.isArray(permissions) && permissions.includes(item.requiredPermission);
      }),
    [permissions],
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-56 shrink-0 border-r border-border bg-sidebar p-3 md:block">
        <div className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('admin.title')}</div>
        <nav className="mt-1 space-y-0.5">
          {visibleItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium',
                  isActive ? 'bg-brand-muted text-brand' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )
              }
            >
              <item.icon className="h-4 w-4" aria-hidden="true" />
              {t(item.labelKey)}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex h-full flex-col">
          <div className="flex gap-1 overflow-x-auto border-b border-border px-3 py-2 scrollbar-thin md:hidden">
            {visibleItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn('whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium', isActive ? 'bg-brand-muted text-brand' : 'text-muted-foreground')
                }
              >
                {t(item.labelKey)}
              </NavLink>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
