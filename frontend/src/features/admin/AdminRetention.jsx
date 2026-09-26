import { useState } from 'react';
import { Clock, Database, BookOpen, MessagesSquare, ScrollText, Activity } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Switch } from '@/shared/ui/switch';
import { Label } from '@/shared/ui/label';
import { useAppData } from '@/shared/mock-data';
const POLICIES = [
  {
    key: 'source',
    icon: Database,
    labelKey: 'admin.retentionSource',
    descKey: 'admin.retentionSourceDesc',
  },
  {
    key: 'knowledge',
    icon: BookOpen,
    labelKey: 'admin.retentionKnowledge',
    descKey: 'admin.retentionKnowledgeDesc',
  },
  {
    key: 'conversations',
    icon: MessagesSquare,
    labelKey: 'admin.retentionConversations',
    descKey: 'admin.retentionConversationsDesc',
  },
  {
    key: 'audit',
    icon: ScrollText,
    labelKey: 'admin.retentionAudit',
    descKey: 'admin.retentionAuditDesc',
  },
  {
    key: 'processing',
    icon: Activity,
    labelKey: 'admin.retentionProcessing',
    descKey: 'admin.retentionProcessingDesc',
  },
];
/**
 * Retention policy toggles with audit logging.
 *
 * @returns Admin retention page
 */
export default function AdminRetention() {
  const { t } = useTranslation();
  const { logAudit } = useAppData();
  const [enabled, setEnabled] = useState({
    source: true,
    knowledge: true,
    conversations: true,
    audit: true,
    processing: false,
  });
  /**
   * Toggle a retention policy and write an audit entry.
   *
   * @param key - Policy key
   */
  const toggle = (key) => {
    setEnabled((current) => {
      const next = { ...current, [key]: !current[key] };
      logAudit('Updated retention policy', key, 'Success', {
        enabled: next[key],
      });
      return next;
    });
  };
  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-brand" aria-hidden="true" />
          <h1 className="font-display text-xl font-medium">{t('admin.retentionTitle')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t('admin.retentionSubtitle')}</p>

        <div className="mt-5 space-y-3">
          {POLICIES.map((policy) => (
            <div key={policy.key} className="flex items-start gap-3 rounded-xl border border-border bg-card p-4">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-muted text-brand">
                <policy.icon className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">{t(policy.labelKey)}</Label>
                  <Switch checked={enabled[policy.key]} onCheckedChange={() => toggle(policy.key)} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t(policy.descKey)}</p>
                {enabled[policy.key] ? (
                  <p className="mt-1.5 text-xs font-medium text-brand">{t('admin.retentionActive')}</p>
                ) : (
                  <p className="mt-1.5 text-xs text-muted-foreground">{t('admin.retentionIndefinite')}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
