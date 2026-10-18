/**
 * Header inbox bell backed by GET /masters/notifications/list.
 *
 * Badge uses API `unreadTotal` only. Opening a row marks it read and navigates
 * via `resourceRef` (processing when a job id is present, otherwise sources).
 */
import { Bell } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { messageFromUnknown } from '@/shared/api';
import { useNotificationActions, useNotifications } from './hooks/useNotifications.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from '@/shared/ui/dropdown-menu';

/**
 * Builds the in-app path for a notification row.
 * @param {{ projectId?: string | null, jobId?: string | null }} resourceRef Ids.
 * @returns {string}
 */
export function pathForNotification(resourceRef) {
  const projectId = resourceRef?.projectId;
  if (!projectId) {
    return '/processing';
  }
  if (resourceRef.jobId) {
    return `/projects/${encodeURIComponent(projectId)}/processing`;
  }
  return `/projects/${encodeURIComponent(projectId)}/sources`;
}

/**
 * Notification bell with unread badge and list.
 * @returns {import('react').ReactElement}
 */
export default function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const query = useNotifications();
  const actions = useNotificationActions();
  const items = query.data?.items ?? [];
  const unreadTotal = query.data?.unreadTotal ?? 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t('common.notifications')}
        >
          <Bell className="h-[18px] w-[18px]" />
          {unreadTotal > 0 ? <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-brand" /> : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="text-sm font-semibold">{t('common.notifications')}</span>
          <button
            type="button"
            onClick={() => void actions.markAllRead()}
            className="text-xs text-brand hover:underline"
            disabled={actions.isMarking || unreadTotal === 0}
          >
            {t('common.markAllRead')}
          </button>
        </div>
        <DropdownMenuSeparator />
        {query.isLoading ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground" aria-busy="true">
            {t('common.loading')}
          </div>
        ) : null}
        {query.error ? (
          <div role="alert" className="px-3 py-4 text-sm text-red-700">
            {messageFromUnknown(query.error, t('common.notificationsLoadFailed'))}
          </div>
        ) : null}
        {!query.isLoading && !query.error && items.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">{t('common.noNotifications')}</div>
        ) : null}
        {items.map((notification) => (
          <button
            key={notification.id}
            type="button"
            onClick={() => {
              void actions.markRead(notification.id);
              navigate(pathForNotification(notification.resourceRef));
            }}
            className={cn(
              'flex w-full flex-col gap-0.5 border-b border-border px-3 py-2.5 text-left last:border-0 hover:bg-muted',
              !notification.readAt && 'bg-brand-muted/30',
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{notification.title}</span>
              {!notification.readAt ? <span className="h-1.5 w-1.5 rounded-full bg-brand" /> : null}
            </div>
            <span className="text-xs text-muted-foreground">{notification.body}</span>
          </button>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
