/**
 * Admin retention page — read-only policy copy. Rules live as backend constants;
 * this screen does not PATCH retention settings.
 */
import { BookOpen, Clock, Database, MessagesSquare, ScrollText, Activity, Bell } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const POLICIES = [
  {
    key: 'source',
    icon: Database,
    labelKey: 'admin.retentionSourceKeep',
    descKey: 'admin.retentionSourceKeepDesc',
  },
  {
    key: 'jobs',
    icon: Activity,
    labelKey: 'admin.retentionJobs',
    descKey: 'admin.retentionJobsDesc',
  },
  {
    key: 'notifications',
    icon: Bell,
    labelKey: 'admin.retentionNotifications',
    descKey: 'admin.retentionNotificationsDesc',
  },
  {
    key: 'usage',
    icon: BookOpen,
    labelKey: 'admin.retentionUsage',
    descKey: 'admin.retentionUsageDesc',
  },
  {
    key: 'conversations',
    icon: MessagesSquare,
    labelKey: 'admin.retentionConversations',
    descKey: 'admin.retentionConversationsWindow',
  },
  {
    key: 'audit',
    icon: ScrollText,
    labelKey: 'admin.retentionAudit',
    descKey: 'admin.retentionAuditWindow',
  },
];

/**
 * Read-only retention defaults (no PATCH in this slice).
 * @returns {import('react').ReactElement}
 */
export default function AdminRetention() {
  const { t } = useTranslation();
  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-brand" aria-hidden="true" />
          <h1 className="font-display text-xl font-medium">{t('admin.retentionTitle')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t('admin.retentionReadOnly')}</p>

        <div className="mt-5 space-y-3">
          {POLICIES.map((policy) => (
            <div key={policy.key} className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-muted text-brand">
                <policy.icon className="h-4 w-4" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-sm font-semibold">{t(policy.labelKey)}</h2>
                <p className="text-sm text-muted-foreground">{t(policy.descKey)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
