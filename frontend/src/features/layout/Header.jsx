import { Bell, ChevronDown, FolderKanban, KeyRound, LogOut, Search, Settings, User as UserIcon, } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { useAppData } from '@/shared/mock-data';
import { cn } from '@/shared/lib/utils';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, } from '@/shared/ui/dropdown-menu';
import ProcessingIndicator from './ProcessingIndicator';
/**
 * Top app bar with org/project switchers, search, notifications, and account menu.
 *
 * @param props - Optional mobile menu handler.
 * @returns Header element.
 */
export default function Header({ onMenu }) {
    const { t } = useTranslation();
    const { org, projects, activeJob, notifications, markAllNotificationsRead, markNotificationRead, } = useAppData();
    const { user, logout } = useAuth();
    const location = useLocation();
    const navigate = useNavigate();
    const [query, setQuery] = useState('');
    const [searchOpen, setSearchOpen] = useState(false);
    const searchRef = useRef(null);
    const activeProject = projects.find((project) => location.pathname.startsWith(`/projects/${project.id}`));
    const unread = notifications.filter((notification) => !notification.read).length;
    useEffect(() => {
        /**
         * Closes the project search dropdown when clicking outside.
         * @param event - Mouse down event.
         */
        function closeOnOutsideClick(event) {
            if (searchRef.current && !searchRef.current.contains(event.target)) {
                setSearchOpen(false);
            }
        }
        document.addEventListener('mousedown', closeOnOutsideClick);
        return () => document.removeEventListener('mousedown', closeOnOutsideClick);
    }, []);
    const searchResults = query.trim()
        ? projects
            .filter((project) => project.name.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 5)
        : [];
    return (<header className="flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur">
      {onMenu && (<button type="button" className="-ml-1 p-1.5 text-muted-foreground lg:hidden" onClick={onMenu} aria-label={t('header.openMenu')}>
          <FolderKanban className="h-5 w-5"/>
        </button>)}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-foreground hover:bg-muted sm:flex">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-primary text-[11px] font-semibold text-primary-foreground">
              {org.name[0]}
            </span>
            {org.name}
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground"/>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {t('header.planLabel', { plan: org.plan })}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate('/admin')}>
            {t('header.organizationSettings')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {activeProject && (<>
          <span className="text-muted-foreground/40">/</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-foreground hover:bg-muted">
                {activeProject.name}
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground"/>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t('header.switchProject')}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {projects
                .filter((project) => project.status !== 'Archived')
                .map((project) => (<DropdownMenuItem key={project.id} onClick={() => navigate(`/projects/${project.id}`)}>
                    <span className="truncate">{project.name}</span>
                  </DropdownMenuItem>))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate('/projects')}>
                {t('header.allProjects')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>)}

      <div className="flex-1"/>

      <ProcessingIndicator job={activeJob} project={activeProject}/>

      <div ref={searchRef} className="relative">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"/>
          <input value={query} onChange={(event) => {
            setQuery(event.target.value);
            setSearchOpen(true);
        }} onFocus={() => setSearchOpen(true)} placeholder={t('header.searchProjects')} className="w-36 rounded-lg border border-input bg-muted/50 py-1.5 pl-8 pr-3 text-sm placeholder:text-muted-foreground focus:bg-background focus:outline-none focus:ring-2 focus:ring-ring/30 sm:w-56 md:w-64"/>
        </div>
        {searchOpen && searchResults.length > 0 && (<div className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-lg border border-border bg-popover p-1 shadow-lg">
            {searchResults.map((project) => (<button key={project.id} type="button" onClick={() => {
                    navigate(`/projects/${project.id}`);
                    setSearchOpen(false);
                    setQuery('');
                }} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted">
                <FolderKanban className="h-4 w-4 text-muted-foreground"/>
                <span className="truncate">{project.name}</span>
              </button>))}
          </div>)}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="relative rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t('common.notifications')}>
            <Bell className="h-[18px] w-[18px]"/>
            {unread > 0 && (<span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-brand"/>)}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-sm font-semibold">{t('common.notifications')}</span>
            <button type="button" onClick={markAllNotificationsRead} className="text-xs text-brand hover:underline">
              {t('common.markAllRead')}
            </button>
          </div>
          <DropdownMenuSeparator />
          {notifications.length === 0 && (<div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t('common.noNotifications')}
            </div>)}
          {notifications.map((notification) => (<button key={notification.id} type="button" onClick={() => markNotificationRead(notification.id)} className={cn('flex w-full flex-col gap-0.5 border-b border-border px-3 py-2.5 text-left last:border-0 hover:bg-muted', !notification.read && 'bg-brand-muted/30')}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{notification.title}</span>
                {!notification.read && (<span className="h-1.5 w-1.5 rounded-full bg-brand"/>)}
              </div>
              <span className="text-xs text-muted-foreground">{notification.body}</span>
            </button>))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="flex items-center gap-2 rounded-lg p-1 hover:bg-muted">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              {(user?.displayName || user?.email || 'U')[0]?.toUpperCase()}
            </div>
            <ChevronDown className="hidden h-3.5 w-3.5 text-muted-foreground sm:block"/>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col">
              <span className="text-sm font-medium">
                {user?.displayName || t('header.account')}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {user?.email}
              </span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate('/change-password')}>
            <KeyRound className="mr-2 h-4 w-4"/> {t('header.changePassword')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate('/admin')}>
            <UserIcon className="mr-2 h-4 w-4"/> {t('common.profile')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => navigate('/admin')}>
            <Settings className="mr-2 h-4 w-4"/> {t('common.settings')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void logout()} className="text-destructive focus:text-destructive">
            <LogOut className="mr-2 h-4 w-4"/> {t('header.signOut')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>);
}
