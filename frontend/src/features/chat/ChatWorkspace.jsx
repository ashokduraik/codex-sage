/**
 * Project chat workspace — conversation history and persisted messages (Phase 54 shell).
 * Streaming send arrives in Phase 55; the composer stays disabled here.
 */
import { Composer } from './Composer';
import { MessageItem } from './MessageItem';
import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { ConversationList } from './ConversationList';
import { Loader2, PanelLeftOpen, Sparkles } from 'lucide-react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useConversation } from '@/features/chat/hooks/useConversation.js';
import { isProjectAskable, isProjectArchived } from '@/shared/components/StatusBadge.jsx';
import { useCreateConversation } from '@/features/chat/hooks/useConversationMutations.js';
import { isForbiddenApiError, isNotFoundApiError, messageFromUnknown } from '@/shared/api';
import { useConversationMessages, flattenMessagePages } from '@/features/chat/hooks/useConversationMessages.js';

/**
 * Project chat workspace with history, messages, and a Phase-55-gated composer.
 *
 * @returns Chat workspace UI
 */
export default function ChatWorkspace() {
  const { t } = useTranslation();
  const { project, activeConvId, setActiveConvId } = useOutletContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showHistory, setShowHistory] = useState(false);
  const [createError, setCreateError] = useState('');
  const scrollRef = useRef(null);
  const historyToggleRef = useRef(null);
  const initRef = useRef(false);
  const projectId = project?.id ? String(project.id) : '';
  const createMutation = useCreateConversation(projectId);
  const detailQuery = useConversation(projectId, activeConvId);
  const messagesQuery = useConversationMessages(projectId, activeConvId);
  const messages = flattenMessagePages(messagesQuery.data);
  const conversation = detailQuery.data ?? null;
  const archivedProject = isProjectArchived(project);
  const askable = isProjectAskable(project);
  const knowledgeUpdating = project?.knowledgeHealth === 'updating' || project?.lifecycleStatus === 'updating';
  const title = conversation?.title || t('chat.newChat');

  useEffect(() => {
    if (initRef.current || !projectId) {
      return;
    }
    initRef.current = true;
    const convParam = searchParams.get('conv');
    if (convParam) {
      setActiveConvId(convParam);
    }
  }, [projectId, searchParams, setActiveConvId]);

  const lastMessageContent = messages[messages.length - 1]?.content;
  useEffect(() => {
    if (!messages.length) {
      return;
    }
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages.length, lastMessageContent]);

  /**
   * Creates a conversation and selects it.
   * @param {string} [titleHint] Optional title for create.
   */
  const createAndSelect = (titleHint) => {
    setCreateError('');
    createMutation.mutate(
      {
        title: titleHint,
        idempotencyKey: crypto.randomUUID(),
      },
      {
        onSuccess: (created) => {
          setActiveConvId(created.id);
          setSearchParams({ conv: created.id }, { replace: true });
          setShowHistory(false);
        },
        onError: (error) => {
          setCreateError(messageFromUnknown(error, t('chat.createFailed')));
        },
      },
    );
  };

  /**
   * Start a blank conversation via the API.
   */
  const handleNew = () => {
    createAndSelect();
  };

  /**
   * Select a conversation from history (or clear when null).
   * @param {string | null} convId Conversation id
   */
  const handleSelect = (convId) => {
    if (!convId) {
      setActiveConvId(null);
      setSearchParams({}, { replace: true });
      setShowHistory(false);
      return;
    }
    setActiveConvId(convId);
    setSearchParams({ conv: convId }, { replace: true });
    setShowHistory(false);
  };

  /**
   * Close the mobile history drawer and restore focus to the toggle.
   */
  const closeHistory = () => {
    setShowHistory(false);
    window.requestAnimationFrame(() => {
      historyToggleRef.current?.focus();
    });
  };

  const detailForbidden = activeConvId && detailQuery.isError && isForbiddenApiError(detailQuery.error);
  const detailMissing = activeConvId && detailQuery.isError && isNotFoundApiError(detailQuery.error);
  const detailFailed = activeConvId && detailQuery.isError && !detailForbidden && !detailMissing;
  const messagesPending = Boolean(activeConvId) && messagesQuery.isPending && !messagesQuery.data;
  const messagesFailed = Boolean(activeConvId) && messagesQuery.isError;

  return (
    <div className="flex h-full overflow-x-hidden">
      <div className="hidden w-[260px] shrink-0 border-r border-border lg:block">
        <ConversationList
          projectId={projectId}
          activeConvId={activeConvId}
          onSelect={handleSelect}
          onNew={handleNew}
          creating={createMutation.isPending}
        />
      </div>

      {showHistory && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={closeHistory} />
          <div className="absolute left-0 top-0 h-full w-[280px] max-w-[85vw] border-r border-border bg-background">
            <ConversationList
              projectId={projectId}
              activeConvId={activeConvId}
              onSelect={handleSelect}
              onNew={handleNew}
              creating={createMutation.isPending}
            />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 sm:px-6">
          <button
            ref={historyToggleRef}
            type="button"
            className="-ml-1 rounded p-1 text-muted-foreground hover:bg-muted lg:hidden"
            onClick={() => setShowHistory(true)}
            aria-label={t('chat.openHistory')}
          >
            <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="truncate text-sm font-medium">{title}</span>
        </div>

        {createError ? (
          <p className="border-b border-border px-4 py-2 text-xs text-destructive sm:px-6" role="alert">
            {createError}
          </p>
        ) : null}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
          {!activeConvId ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-muted text-brand">
                <Sparkles className="h-6 w-6" aria-hidden="true" />
              </div>
              <h2 className="mt-4 font-display text-xl font-medium">{t('chat.emptyTitleNamed', { name: project?.name ?? '' })}</h2>
              <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{t('chat.emptyDescription')}</p>
              <p className="mt-3 max-w-sm text-xs text-muted-foreground">{t('chat.composerPhase55Guard')}</p>
            </div>
          ) : detailForbidden ? (
            <div className="flex h-full items-center justify-center px-6 text-center" role="alert">
              <p className="text-sm text-muted-foreground">{t('chat.detailForbidden')}</p>
            </div>
          ) : detailMissing ? (
            <div className="flex h-full items-center justify-center px-6 text-center" role="alert">
              <p className="text-sm text-muted-foreground">{t('chat.detailNotFound')}</p>
            </div>
          ) : detailFailed ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center" role="alert">
              <p className="text-sm text-destructive">{messageFromUnknown(detailQuery.error, t('chat.detailFailed'))}</p>
              <button type="button" className="text-xs text-brand underline" onClick={() => void detailQuery.refetch()}>
                {t('common.retry')}
              </button>
            </div>
          ) : messagesPending || detailQuery.isPending ? (
            <div className="flex h-full items-center justify-center" aria-busy="true">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
            </div>
          ) : messagesFailed ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center" role="alert">
              <p className="text-sm text-destructive">{messageFromUnknown(messagesQuery.error, t('chat.messagesFailed'))}</p>
              <button type="button" className="text-xs text-brand underline" onClick={() => void messagesQuery.refetch()}>
                {t('common.retry')}
              </button>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-muted text-brand">
                <Sparkles className="h-6 w-6" aria-hidden="true" />
              </div>
              <h2 className="mt-4 font-display text-xl font-medium">{t('chat.emptyTitleNamed', { name: project?.name ?? '' })}</h2>
              <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{t('chat.emptyDescription')}</p>
              <p className="mt-3 max-w-sm text-xs text-muted-foreground">{t('chat.composerPhase55Guard')}</p>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl pb-4">
              {messages.map((message) => (
                <MessageItem key={message.id} message={message} isUser={message.role === 'user'} canEdit={false} />
              ))}
            </div>
          )}
        </div>

        <Composer
          onSend={() => undefined}
          onStop={() => undefined}
          isGenerating={false}
          queued={knowledgeUpdating}
          contextWarning={false}
          disabled
          placeholder={
            archivedProject ? t('chat.archivedPlaceholder') : !askable ? t('chat.notAskablePlaceholder') : t('chat.composerPhase55Placeholder')
          }
        />
      </div>
    </div>
  );
}
