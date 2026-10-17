/**
 * One evidence row: path/lines, excluded callout, preview open, and knowledge deep-link.
 */
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { BookOpen, FileCode } from 'lucide-react';

/**
 * @param {{
 *   item: object,
 *   projectId: string,
 *   conversationId?: string | null,
 *   onPreview: (target: { path: string, startLine?: number, endLine?: number }) => void,
 * }} props Row props.
 * @returns {import('react').ReactElement | null}
 */
export default function EvidenceItem({ item, projectId, conversationId, onPreview }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (!item || typeof item !== 'object') {
    return null;
  }

  const path = typeof item.path === 'string' ? item.path : '';
  if (!path) {
    return null;
  }

  const startLine = typeof item.startLine === 'number' ? item.startLine : undefined;
  const endLine = typeof item.endLine === 'number' ? item.endLine : undefined;
  const heading = typeof item.heading === 'string' ? item.heading : '';
  const excerpt = typeof item.excerpt === 'string' ? item.excerpt : '';
  const kind = typeof item.kind === 'string' ? item.kind : '';
  const excluded = item.excludedFromGraph === true;
  const key = typeof item.evidenceId === 'string' ? item.evidenceId : path;

  /**
   * Opens the shared source preview drawer for this path/range.
   */
  const openPreview = () => {
    onPreview({
      path,
      ...(startLine != null ? { startLine } : {}),
      ...(endLine != null ? { endLine } : {}),
    });
  };

  /**
   * Navigates to knowledge explorer with a return token to this conversation.
   */
  const openInKnowledge = () => {
    if (!projectId) {
      return;
    }
    navigate(`/projects/${projectId}/knowledge`, {
      state: conversationId ? { returnConversationId: conversationId } : undefined,
    });
  };

  const rangeLabel =
    startLine != null && endLine != null
      ? t('chat.evidence.lineRange', { start: startLine, end: endLine })
      : startLine != null
        ? t('chat.evidence.lineStart', { start: startLine })
        : '';

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-2.5" data-evidence-id={key}>
      <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-foreground">
        <FileCode className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
        <button type="button" onClick={openPreview} className="font-mono text-left hover:underline">
          {path}
        </button>
        {kind ? <span className="text-muted-foreground">· {t(`chat.evidence.kind.${kind}`, { defaultValue: kind })}</span> : null}
        {rangeLabel ? <span className="text-muted-foreground">· {rangeLabel}</span> : null}
        {heading ? <span className="text-muted-foreground">· {heading}</span> : null}
      </div>
      {excluded ? (
        <p className="mt-1.5 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800" role="status">
          {t('chat.evidence.excludedFromGraph')}
        </p>
      ) : null}
      {excerpt ? (
        <pre className="mt-1.5 overflow-x-auto rounded bg-[hsl(215_28%_8%)] p-2.5 font-mono text-[12px] leading-relaxed text-white/85 scrollbar-thin">
          {excerpt}
        </pre>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-3">
        <button type="button" onClick={openPreview} className="text-[11px] font-medium text-brand hover:underline">
          {t('chat.evidence.preview')}
        </button>
        <button type="button" onClick={openInKnowledge} className="inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:underline">
          <BookOpen className="h-3 w-3" aria-hidden="true" />
          {t('chat.evidence.openInKnowledge')}
        </button>
      </div>
    </div>
  );
}
