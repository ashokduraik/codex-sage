import { useState, type ComponentType } from 'react';
import {
  FileCode,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  RefreshCw,
  Pencil,
  Check,
  X,
  Loader2,
  Ban,
  Clock,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { MarkdownRenderer, AbstainNotice } from '@/shared/components';
import { Button } from '@/shared/ui/button';
import { Textarea } from '@/shared/ui/textarea';
import { cn } from '@/shared/lib/utils';
import type { ChatMessage, EvidenceItem } from '@/shared/types/domain';

export interface MessageItemProps {
  message: ChatMessage;
  isUser: boolean;
  onEdit: (content: string) => void;
  onRetry: () => void;
  canEdit?: boolean;
}

interface StatusMeta {
  labelKey: string;
  icon: ComponentType<{ className?: string }> | null;
  spin?: boolean;
  tone: string;
}

const STATUS_META: Record<string, StatusMeta> = {
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

interface EvidenceSourcesProps {
  evidence?: EvidenceItem[];
}

/**
 * Collapsible evidence list attached to a completed assistant message.
 *
 * @param props - Evidence items
 * @returns Evidence disclosure UI, or null when empty
 */
function EvidenceSources({ evidence }: EvidenceSourcesProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!evidence?.length) return null;
  return (
    <div className="mt-3 border-t border-border pt-2.5">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {t('chat.sourceCount', { count: evidence.length })}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {evidence.map((item, index) => (
            <div
              key={`${item.file}-${index}`}
              className="rounded-lg border border-border bg-muted/30 p-2.5"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <FileCode className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
                <span className="font-mono">{item.file}</span>
                {item.location && (
                  <span className="text-muted-foreground">
                    · {item.location}
                  </span>
                )}
              </div>
              <pre className="mt-1.5 overflow-x-auto rounded bg-[hsl(215_28%_8%)] p-2.5 font-mono text-[12px] leading-relaxed text-white/85 scrollbar-thin">
                {item.snippet}
              </pre>
            </div>
          ))}
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
export function MessageItem({
  message,
  isUser,
  onEdit,
  onRetry,
  canEdit = false,
}: MessageItemProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const meta = STATUS_META[message.status];

  /**
   * Persist an edited user message when the draft changed.
   */
  const saveEdit = () => {
    if (draft.trim() && draft.trim() !== message.content) {
      onEdit(draft.trim());
    }
    setEditing(false);
  };

  return (
    <div
      className={cn(
        'group flex gap-3 px-4 py-4 sm:px-6',
        isUser && 'bg-muted/20',
      )}
    >
      <div
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-brand text-brand-foreground',
        )}
      >
        {isUser ? t('chat.youInitial') : t('chat.assistantInitial')}
      </div>
      <div className="min-w-0 flex-1">
        {isUser ? (
          editing ? (
            <div className="space-y-2">
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
                autoFocus
                className="text-sm"
              />
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
              <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground/90">
                {message.content}
              </div>
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
            {meta && message.status !== 'Completed' && meta.icon && (
              <div className={cn('flex items-center gap-1.5 text-sm', meta.tone)}>
                <meta.icon
                  className={cn('h-3.5 w-3.5', meta.spin && 'animate-spin')}
                />
                {t(meta.labelKey)}
              </div>
            )}
            {message.content && <MarkdownRenderer content={message.content} />}
            {message.abstain && (
              <AbstainNotice
                missing={message.missing}
                onRetry={onRetry}
                onNarrow={onRetry}
              />
            )}
            {message.status === 'Failed' && !message.abstain && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm text-destructive">
                  {t('chat.generationFailed')}
                </span>
                <Button size="sm" variant="outline" onClick={onRetry}>
                  <RefreshCw
                    className="mr-1.5 h-3.5 w-3.5"
                    aria-hidden="true"
                  />
                  {t('chat.retry')}
                </Button>
              </div>
            )}
            {message.status === 'Completed' && (
              <EvidenceSources evidence={message.evidence} />
            )}
            {message.status === 'Completed' &&
              (message.evidence || message.knowledgeVersion) && (
                <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                  {message.knowledgeVersion && (
                    <span>
                      {t('chat.knowledgeVersion', {
                        version: message.knowledgeVersion,
                      })}
                    </span>
                  )}
                </div>
              )}
          </div>
        )}
      </div>
    </div>
  );
}

export default MessageItem;
