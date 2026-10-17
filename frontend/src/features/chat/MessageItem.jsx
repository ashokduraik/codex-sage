/**
 * Single chat message row for persisted user/assistant turns (static; no streaming).
 */
import { useState } from 'react';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { useTranslation } from 'react-i18next';
import { Textarea } from '@/shared/ui/textarea';
import { MarkdownRenderer, AbstainNotice } from '@/shared/components';
import { X, Ban, Check, Clock, Pencil, Loader2, FileCode, RefreshCw, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';

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
 * Collapsible evidence list attached to a completed assistant message.
 *
 * @param props - Evidence items
 * @returns Evidence disclosure UI, or null when empty
 */
function EvidenceSources({ evidence }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const items = Array.isArray(evidence) ? evidence : [];
  if (items.length === 0) return null;
  return (
    <div className="mt-3 border-t border-border pt-2.5">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
        {t('chat.sourceCount', { count: items.length })}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {items.map((item, index) => {
            const file = item.file ?? item.path ?? item.locator?.path ?? 'source';
            const location = item.location ?? item.locator?.range ?? '';
            const snippet = item.snippet ?? item.text ?? '';
            return (
              <div key={`${file}-${index}`} className="rounded-lg border border-border bg-muted/30 p-2.5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <FileCode className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
                  <span className="font-mono">{file}</span>
                  {location ? <span className="text-muted-foreground">· {location}</span> : null}
                </div>
                {snippet ? (
                  <pre className="mt-1.5 overflow-x-auto rounded bg-[hsl(215_28%_8%)] p-2.5 font-mono text-[12px] leading-relaxed text-white/85 scrollbar-thin">
                    {snippet}
                  </pre>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Single chat message row for user or assistant turns.
 *
 * @param props - Message data and edit/retry handlers
 * @returns Message row
 */
export function MessageItem({ message, isUser, onEdit, onRetry, canEdit = false }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const statusCode = resolveMessageStatus(message);
  const meta = STATUS_META[statusCode];
  const isCompleted = statusCode === 'completed' || statusCode === 'Completed';
  const isFailed = statusCode === 'failed' || statusCode === 'Failed';
  const isAbstained = statusCode === 'abstained' || message.abstain || message.supportLevel === 'insufficient';
  const showStatusChrome = Boolean(meta?.icon) && !isCompleted;
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
    <div className={cn('group flex gap-3 px-4 py-4 sm:px-6', isUser && 'bg-muted/20')}>
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
            {showStatusChrome && meta?.icon ? (
              <div className={cn('flex items-center gap-1.5 text-sm', meta.tone)}>
                <meta.icon className={cn('h-3.5 w-3.5', meta.spin && 'animate-spin')} aria-hidden="true" />
                {t(meta.labelKey)}
              </div>
            ) : null}
            {message.content ? <MarkdownRenderer content={message.content} /> : null}
            {isAbstained && typeof onRetry === 'function' ? <AbstainNotice missing={message.missing} onRetry={onRetry} onNarrow={onRetry} /> : null}
            {isAbstained && typeof onRetry !== 'function' ? <p className="mt-2 text-sm text-muted-foreground">{t('chat.statusAbstained')}</p> : null}
            {isFailed && !isAbstained ? (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm text-destructive">{t('chat.generationFailed')}</span>
                {typeof onRetry === 'function' ? (
                  <Button size="sm" variant="outline" onClick={onRetry}>
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    {t('chat.retry')}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {isCompleted ? <EvidenceSources evidence={message.evidence} /> : null}
            {isCompleted && (message.evidence || message.knowledgeVersion || message.knowledgeVersionId) ? (
              <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                {(message.knowledgeVersion || message.knowledgeVersionId) && (
                  <span>
                    {t('chat.knowledgeVersion', {
                      version: message.knowledgeVersion || message.knowledgeVersionId,
                    })}
                  </span>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export default MessageItem;
