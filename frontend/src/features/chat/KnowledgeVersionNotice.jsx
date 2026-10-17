/**
 * Thread-level banner when older answers cite a knowledge version other than the project's current.
 * Shown once per project session via sessionStorage.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';

/**
 * Builds the sessionStorage key for the version notice.
 * @param {string} projectId Project id.
 * @returns {string}
 */
export function knowledgeVersionNoticeStorageKey(projectId) {
  return `codex-sage:kv-notice:${projectId}`;
}

/**
 * @param {{
 *   projectId: string,
 *   currentKnowledgeVersionId?: string | null,
 *   messages?: Array<{ knowledgeVersionId?: string | null }>,
 * }} props Notice inputs.
 * @returns {import('react').ReactElement | null}
 */
export default function KnowledgeVersionNotice({ projectId, currentKnowledgeVersionId, messages = [] }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!projectId || !currentKnowledgeVersionId) {
      setVisible(false);
      return;
    }
    const key = knowledgeVersionNoticeStorageKey(projectId);
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(key) === '1') {
      setVisible(false);
      return;
    }
    const hasStale = messages.some(
      (message) =>
        typeof message?.knowledgeVersionId === 'string' && message.knowledgeVersionId && message.knowledgeVersionId !== currentKnowledgeVersionId,
    );
    setVisible(hasStale);
  }, [projectId, currentKnowledgeVersionId, messages]);

  if (!visible) {
    return null;
  }

  /**
   * Dismisses the banner for this project in the current browser session.
   */
  const dismiss = () => {
    if (projectId && typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(knowledgeVersionNoticeStorageKey(projectId), '1');
    }
    setVisible(false);
  };

  return (
    <div
      className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 sm:mx-6"
      role="status"
      data-testid="knowledge-version-notice"
    >
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <p className="flex-1">{t('chat.knowledgeVersionNotice')}</p>
      <button type="button" onClick={dismiss} className="shrink-0 font-medium underline">
        {t('common.dismiss')}
      </button>
    </div>
  );
}
