/**
 * Collapsible evidence list under a completed assistant message (progressive disclosure).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import EvidenceItem from './EvidenceItem.jsx';

/**
 * @param {{
 *   evidence: unknown,
 *   projectId: string,
 *   conversationId?: string | null,
 *   onPreview: (target: { path: string, startLine?: number, endLine?: number }) => void,
 * }} props List props.
 * @returns {import('react').ReactElement | null}
 */
export default function EvidenceList({ evidence, projectId, conversationId, onPreview }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const items = Array.isArray(evidence)
    ? evidence.filter((row) => row && typeof row === 'object' && typeof row.path === 'string' && row.path.trim() !== '')
    : [];
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 border-t border-border pt-2.5">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
        {t('chat.sourceCount', { count: items.length })}
      </button>
      {open ? (
        <div className="mt-2 space-y-2">
          {items.map((item, index) => (
            <EvidenceItem
              key={typeof item.evidenceId === 'string' ? item.evidenceId : `${item.path}-${index}`}
              item={item}
              projectId={projectId}
              conversationId={conversationId}
              onPreview={onPreview}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
