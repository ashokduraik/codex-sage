/**
 * Admin retention page — load/save org retentionPolicy (requires org.manage).
 */
import { toast } from 'sonner';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Button } from '@/shared/ui/button';
import { useEffect, useState } from 'react';
import { Clock, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/features/auth/AuthContext';
import { InlineErrorAlert } from '@/features/admin/InlineErrorAlert.jsx';
import { correlationFromUnknown, messageFromUnknown } from '@/shared/api';
import { useRetentionPolicy, useUpdateRetentionPolicy } from '@/features/admin/api/useRetentionPolicy.js';

/** Form field metadata aligned with backend retentionPolicy. */
const POLICY_FIELDS = [
  {
    key: 'readySourceVersionsKeep',
    labelKey: 'admin.retentionFieldReadyKeep',
    descKey: 'admin.retentionFieldReadyKeepDesc',
  },
  {
    key: 'jobDays',
    labelKey: 'admin.retentionFieldJobs',
    descKey: 'admin.retentionFieldJobsDesc',
  },
  {
    key: 'notificationDays',
    labelKey: 'admin.retentionFieldNotifications',
    descKey: 'admin.retentionFieldNotificationsDesc',
  },
  {
    key: 'notificationReadDays',
    labelKey: 'admin.retentionFieldNotificationsRead',
    descKey: 'admin.retentionFieldNotificationsReadDesc',
  },
  {
    key: 'usageDays',
    labelKey: 'admin.retentionFieldUsage',
    descKey: 'admin.retentionFieldUsageDesc',
  },
  {
    key: 'conversationDays',
    labelKey: 'admin.retentionFieldConversations',
    descKey: 'admin.retentionFieldConversationsDesc',
  },
  {
    key: 'auditDays',
    labelKey: 'admin.retentionFieldAudit',
    descKey: 'admin.retentionFieldAuditDesc',
  },
];

/**
 * Empty draft matching policy field keys.
 * @returns {Record<string, string>}
 */
function emptyDraft() {
  return Object.fromEntries(POLICY_FIELDS.map((field) => [field.key, '']));
}

/**
 * Maps API policy numbers into controlled string inputs.
 * @param {Record<string, number>} policy Effective policy.
 * @returns {Record<string, string>}
 */
function draftFromPolicy(policy) {
  /** @type {Record<string, string>} */
  const draft = {};
  for (const field of POLICY_FIELDS) {
    draft[field.key] = String(policy[field.key] ?? '');
  }
  return draft;
}

/**
 * Writable retention settings when the user holds org.manage; otherwise a short denial.
 * @returns {import('react').ReactElement}
 */
export default function AdminRetention() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  const canManageOrg = Boolean(currentUser?.permissions?.includes('org.manage'));
  const policyQuery = useRetentionPolicy({ enabled: canManageOrg });
  const updateMutation = useUpdateRetentionPolicy();
  const [draft, setDraft] = useState(() => emptyDraft());
  const [formError, setFormError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (policyQuery.data) {
      setDraft(draftFromPolicy(policyQuery.data));
    }
  }, [policyQuery.data]);

  if (!canManageOrg) {
    return (
      <div className="h-full overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-brand" aria-hidden="true" />
            <h1 className="font-display text-xl font-medium">{t('admin.retentionTitle')}</h1>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{t('admin.retentionNoPermission')}</p>
        </div>
      </div>
    );
  }

  /**
   * @param {string} key Field key.
   * @param {string} value Raw input.
   */
  function onFieldChange(key, value) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setFormError(null);
  }

  /**
   * @param {import('react').FormEvent} event Submit event.
   */
  async function onSubmit(event) {
    event.preventDefault();
    setFormError(null);
    /** @type {Record<string, number>} */
    const patch = {};
    for (const field of POLICY_FIELDS) {
      const parsed = Number(draft[field.key]);
      if (!Number.isInteger(parsed)) {
        setFormError(t('admin.retentionInvalidNumber', { field: t(field.labelKey) }));
        return;
      }
      patch[field.key] = parsed;
    }
    try {
      await updateMutation.mutateAsync({
        ...patch,
        idempotencyKey: crypto.randomUUID(),
      });
      toast.success(t('admin.retentionSaved'));
    } catch (error) {
      const message = messageFromUnknown(error) || t('admin.retentionSaveFailed');
      setFormError(message);
      toast.error(message, { description: correlationFromUnknown(error) || undefined });
    }
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex items-center gap-2">
          <Clock className="h-5 w-5 text-brand" aria-hidden="true" />
          <h1 className="font-display text-xl font-medium">{t('admin.retentionTitle')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t('admin.retentionExplainer')}</p>

        {policyQuery.isLoading ? (
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('admin.retentionLoading')}
          </div>
        ) : null}

        {policyQuery.isError ? (
          <div className="mt-4">
            <InlineErrorAlert message={messageFromUnknown(policyQuery.error) || t('admin.retentionLoadFailed')} />
          </div>
        ) : null}

        {policyQuery.isSuccess ? (
          <form className="mt-6 space-y-4" onSubmit={onSubmit}>
            {POLICY_FIELDS.map((field) => (
              <div key={field.key} className="space-y-1.5">
                <Label htmlFor={`retention-${field.key}`}>{t(field.labelKey)}</Label>
                <p className="text-xs text-muted-foreground">{t(field.descKey)}</p>
                <Input
                  id={`retention-${field.key}`}
                  type="number"
                  inputMode="numeric"
                  value={draft[field.key]}
                  onChange={(event) => onFieldChange(field.key, event.target.value)}
                  disabled={updateMutation.isPending}
                />
              </div>
            ))}

            {formError ? <InlineErrorAlert message={formError} /> : null}

            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  {t('admin.retentionSaving')}
                </>
              ) : (
                t('admin.retentionSave')
              )}
            </Button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
