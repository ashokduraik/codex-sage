/**
 * Single chat message row for user/assistant turns (persisted or in-flight streaming).
 */
import { useState } from 'react';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { useTranslation } from 'react-i18next';
import { Textarea } from '@/shared/ui/textarea';
import MetricsLine from '@/features/chat/MetricsLine.jsx';
import EvidenceList from '@/features/chat/EvidenceList.jsx';
import { MarkdownRenderer, AbstainNotice } from '@/shared/components';
import SupportLevelBanner from '@/features/chat/SupportLevelBanner.jsx';
import { StreamingMarkdown } from '@/features/chat/StreamingMarkdown.jsx';
import { ExecutionStatus } from '@/features/chat/ExecutionStatus.jsx';
import { shortenKnowledgeVersionId } from '@/features/chat/utils/formatMessageMetrics.js';
import { X, Ban, Check, Clock, Pencil, Loader2, RefreshCw, AlertTriangle } from 'lucide-react';

const STATUS_META = {
  queued: {
    labelKey: 'chat.statusQueued',
    icon: Clock,
    spin: false,
    tone: 'text-blue-600',
  },
  accepted: {
    labelKey: 'chat.searching',
    icon: Loader2,
    spin: true,
    tone: 'text-muted-foreground',
  },
  generating: {
    labelKey: 'chat.generating',
    icon: Loader2,
    spin: true,
    tone: 'text-muted-foreground',
  },
  awaiting_clarification: {
    labelKey: 'chat.awaitingClarification',
    icon: AlertTriangle,
    spin: false,
    tone: 'text-amber-600',
  },
  completed: { labelKey: 'chat.statusCompleted', icon: null, tone: '' },
  abstained: { labelKey: 'chat.statusAbstained', icon: Ban, tone: 'text-muted-foreground' },
  failed: {
    labelKey: 'chat.statusFailed',
    icon: AlertTriangle,
    tone: 'text-destructive',
  },
  interrupted: {
    labelKey: 'chat.statusInterrupted',
    icon: Ban,
    tone: 'text-amber-600',
  },
  cancelled: {
    labelKey: 'chat.statusCancelled',
    icon: Ban,
    tone: 'text-muted-foreground',
  },
  // Legacy mock display strings (tests / transitional props)
  Searching: {
    labelKey: 'chat.searching',
    icon: Loader2,
    spin: true,
    tone: 'text-muted-foreground',
  },
  Generating: {
    labelKey: 'chat.generating',
    icon: Loader2,
    spin: true,
    tone: 'text-muted-foreground',
  },
  Completed: { labelKey: 'chat.statusCompleted', icon: null, tone: '' },
  Failed: {
    labelKey: 'chat.statusFailed',
    icon: AlertTriangle,
    tone: 'text-destructive',
  },
  Cancelled: {
    labelKey: 'chat.statusCancelled',
    icon: Ban,
    tone: 'text-muted-foreground',
  },
  Interrupted: {
    labelKey: 'chat.statusInterrupted',
    icon: Ban,
    tone: 'text-amber-600',
  },
  Queued: {
    labelKey: 'chat.statusQueued',
    icon: Clock,
    tone: 'text-blue-600',
  },
};

/**
 * Resolves the display status code from a message DTO.
 * @param {object} message Message row.
 * @returns {string}
 */
function resolveMessageStatus(message) {
  if (typeof message?.messageStatus === 'string' && message.messageStatus) {
    return message.messageStatus;
  }
  if (typeof message?.status === 'string' && message.status) {
    return message.status;
  }
  return 'completed';
}

/**
 * Single chat message row for user or assistant turns.
 *
 * @param {{
 *   message: object,
 *   isUser?: boolean,
 *   onEdit?: (content: string) => void,
 *   onRetry?: () => void,
 *   canEdit?: boolean,
 *   streaming?: boolean,
 *   streamStage?: string,
 *   projectId?: string,
 *   conversationId?: string | null,
 *   currentKnowledgeVersionId?: string | null,
 *   onPreview?: (target: { path: string, startLine?: number, endLine?: number }) => void,
 * }} props Message data and edit/retry/stream handlers.
 * @returns Message row
 */
export function MessageItem({
  message,
  isUser,
  onEdit,
  onRetry,
  canEdit = false,
  streaming = false,
  streamStage = '',
  projectId = '',
  conversationId = null,
  currentKnowledgeVersionId = null,
  onPreview,
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const statusCode = resolveMessageStatus(message);
  const meta = STATUS_META[statusCode];
  const isCompleted = !streaming && (statusCode === 'completed' || statusCode === 'Completed');
  const isFailed = statusCode === 'failed' || statusCode === 'Failed';
  const isInterrupted = statusCode === 'interrupted' || statusCode === 'Interrupted' || statusCode === 'cancelled' || statusCode === 'Cancelled';
  const isAbstained = statusCode === 'abstained' || message.abstain || message.supportLevel === 'insufficient';
  const showStatusChrome = !streaming && Boolean(meta?.icon) && !isCompleted;
  const versionId = typeof message.knowledgeVersionId === 'string' ? message.knowledgeVersionId : null;
  const versionShort = shortenKnowledgeVersionId(versionId);
  const versionStale = Boolean(versionId && currentKnowledgeVersionId && versionId !== currentKnowledgeVersionId);
  /**
   * Persist an edited user message when the draft changed.
   */
  const saveEdit = () => {
    if (draft.trim() && draft.trim() !== message.content && typeof onEdit === 'function') {
      onEdit(draft.trim());
    }
    setEditing(false);
  };
  return (
    <div
      className={cn(
        'group flex gap-3 px-4 py-4 sm:px-6',
        isUser && 'bg-muted/20',
        !isUser && isAbstained && 'border-l-2 border-amber-400 bg-amber-50/40',
      )}
    >
      <div
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-brand text-brand-foreground',
        )}
      >
        {isUser ? t('chat.youInitial') : t('chat.assistantInitial')}
      </div>
      <div className="min-w-0 flex-1">
        {isUser ? (
          editing ? (
            <div className="space-y-2">
              <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} autoFocus className="text-sm" />
              <div className="flex gap-2">
                <Button size="sm" onClick={saveEdit}>
                  <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  {t('chat.submitEdit')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setDraft(message.content);
                  }}
                >
                  <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  {t('common.cancel')}
                </Button>
              </div>
              <p className="text-xs text-amber-600">{t('chat.editWarning')}</p>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-2">
              <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground/90">{message.content}</div>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                  title={t('chat.edit')}
                  aria-label={t('chat.edit')}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          )
        ) : (
          <div>
            {streaming && streamStage ? <ExecutionStatus stage={streamStage} className="mb-2" /> : null}
            {showStatusChrome && meta?.icon ? (
              <div className={cn('flex items-center gap-1.5 text-sm', meta.tone)}>
                <meta.icon className={cn('h-3.5 w-3.5', meta.spin && 'animate-spin')} aria-hidden="true" />
                {t(meta.labelKey)}
              </div>
            ) : null}
            {message.content ? streaming ? <StreamingMarkdown content={message.content} /> : <MarkdownRenderer content={message.content} /> : null}
            {!streaming && (isCompleted || isAbstained) ? (
              <SupportLevelBanner supportLevel={message.supportLevel} messageStatus={statusCode} />
            ) : null}
            {isAbstained && typeof onRetry === 'function' ? <AbstainNotice missing={message.missing} onRetry={onRetry} onNarrow={onRetry} /> : null}
            {isAbstained && typeof onRetry !== 'function' && !message.supportLevel ? (
              <p className="mt-2 text-sm text-muted-foreground">{t('chat.statusAbstained')}</p>
            ) : null}
            {(isFailed || isInterrupted) && !isAbstained && !streaming ? (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm text-destructive">{isInterrupted ? t('chat.statusInterrupted') : t('chat.generationFailed')}</span>
                {typeof onRetry === 'function' ? (
                  <Button size="sm" variant="outline" onClick={onRetry}>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    {t('chat.retry')}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {!streaming && (isCompleted || isAbstained) ? <MetricsLine message={message} /> : null}
            {!streaming && (isCompleted || isAbstained) && typeof onPreview === 'function' ? (
              <EvidenceList evidence={message.evidence} projectId={projectId} conversationId={conversationId} onPreview={onPreview} />
            ) : null}
            {!streaming && (isCompleted || isAbstained) && versionShort ? (
              <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className={versionStale ? 'text-amber-700' : undefined}>
                  {versionStale ? t('chat.knowledgeVersionStale', { version: versionShort }) : t('chat.knowledgeVersion', { version: versionShort })}
                </span>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export default MessageItem;
