/**
 * Project chat workspace — conversation history, messages, and SSE send/stop/retry (Phase 55).
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
import { useSendMessage } from '@/features/chat/hooks/useSendMessage.js';
import { isForbiddenApiError, isNotFoundApiError, messageFromUnknown } from '@/shared/api';
import { useConversationMessages, flattenMessagePages } from '@/features/chat/hooks/useConversationMessages.js';

/**
 * Project chat workspace with history, messages, and streaming composer.
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
  const nearBottomRef = useRef(true);
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
  const { stream, isBusy, send, retry, stop } = useSendMessage({
    projectId,
    conversationId: activeConvId,
  });

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
    if (!nearBottomRef.current || (!messages.length && !stream.draftText)) {
      return;
    }
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages.length, lastMessageContent, stream.draftText, stream.stage]);

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

  /**
   * Sends a question; creates a conversation first when none is selected.
   * @param {string} content Question text.
   */
  const handleSend = (content) => {
    if (!askable || archivedProject || isBusy) {
      return;
    }
    if (!activeConvId) {
      setCreateError('');
      createMutation.mutate(
        {
          title: content.slice(0, 80),
          idempotencyKey: crypto.randomUUID(),
        },
        {
          onSuccess: (created) => {
            setActiveConvId(created.id);
            setSearchParams({ conv: created.id }, { replace: true });
            void send(content, { conversationId: created.id });
          },
          onError: (error) => {
            setCreateError(messageFromUnknown(error, t('chat.createFailed')));
          },
        },
      );
      return;
    }
    void send(content);
  };

  /**
   * Retries the latest failed/interrupted assistant in the thread.
   * @param {string} assistantMessageId Assistant id.
   */
  const handleRetry = (assistantMessageId) => {
    void retry(assistantMessageId);
  };

  /**
   * Tracks whether the user is near the bottom for auto-scroll.
   */
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const detailForbidden = activeConvId && detailQuery.isError && isForbiddenApiError(detailQuery.error);
  const detailMissing = activeConvId && detailQuery.isError && isNotFoundApiError(detailQuery.error);
  const detailFailed = activeConvId && detailQuery.isError && !detailForbidden && !detailMissing;
  const messagesPending = Boolean(activeConvId) && messagesQuery.isPending && !messagesQuery.data;
  const messagesFailed = Boolean(activeConvId) && messagesQuery.isError;
  const composerDisabled = archivedProject || !askable || createMutation.isPending;
  const showOptimisticUser =
    Boolean(stream.optimisticUserContent) && (stream.phase === 'posting' || stream.phase === 'streaming' || stream.phase === 'queued');
  const showStreamingAssistant = isBusy || stream.phase === 'cancelled' || stream.phase === 'interrupted' || stream.phase === 'failed';
  const latestAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const canRetryLatest =
    latestAssistant && (latestAssistant.messageStatus === 'failed' || latestAssistant.messageStatus === 'interrupted') && !isBusy;

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

        {stream.phase === 'failed' && stream.errorMessage ? (
          <p className="border-b border-border px-4 py-2 text-xs text-destructive sm:px-6" role="alert">
            {stream.errorMessage}
            {stream.errorReference ? ` (${stream.errorReference})` : ''}
          </p>
        ) : null}

        {stream.phase === 'cancelled' ? (
          <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground sm:px-6" role="status">
            {t('chat.generationStopped')}
          </p>
        ) : null}

        {stream.needsClarification ? (
          <p className="border-b border-border px-4 py-2 text-xs text-amber-700 sm:px-6" role="status">
            {t('chat.needsClarificationStub')}
          </p>
        ) : null}

        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin" aria-busy={isBusy}>
          {!activeConvId && !showOptimisticUser ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-muted text-brand">
                <Sparkles className="h-6 w-6" aria-hidden="true" />
              </div>
              <h2 className="mt-4 font-display text-xl font-medium">{t('chat.emptyTitleNamed', { name: project?.name ?? '' })}</h2>
              <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{t('chat.emptyDescription')}</p>
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
          ) : (
            <div className="mx-auto max-w-3xl pb-4">
              {messages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  isUser={message.role === 'user'}
                  canEdit={false}
                  onRetry={canRetryLatest && message.id === latestAssistant?.id ? () => handleRetry(message.id) : undefined}
                />
              ))}
              {showOptimisticUser ? (
                <MessageItem
                  key="optimistic-user"
                  message={{
                    id: 'optimistic-user',
                    role: 'user',
                    content: stream.optimisticUserContent,
                    messageStatus: stream.phase === 'queued' ? 'queued' : 'accepted',
                  }}
                  isUser
                  canEdit={false}
                />
              ) : null}
              {showStreamingAssistant && stream.phase !== 'queued' ? (
                <MessageItem
                  key="streaming-assistant"
                  message={{
                    id: 'streaming-assistant',
                    role: 'assistant',
                    content: stream.draftText,
                    messageStatus:
                      stream.phase === 'failed'
                        ? 'failed'
                        : stream.phase === 'cancelled'
                          ? 'cancelled'
                          : stream.phase === 'interrupted'
                            ? 'interrupted'
                            : 'generating',
                    evidence: stream.evidenceItems,
                  }}
                  isUser={false}
                  streaming={isBusy}
                  streamStage={stream.stage}
                  canEdit={false}
                />
              ) : null}
              {messages.length === 0 && !showOptimisticUser ? (
                <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-muted text-brand">
                    <Sparkles className="h-6 w-6" aria-hidden="true" />
                  </div>
                  <h2 className="mt-4 font-display text-xl font-medium">{t('chat.emptyTitleNamed', { name: project?.name ?? '' })}</h2>
                  <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{t('chat.emptyDescription')}</p>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <Composer
          onSend={handleSend}
          onStop={stop}
          isGenerating={isBusy}
          queued={knowledgeUpdating || stream.phase === 'queued'}
          contextWarning={false}
          disabled={composerDisabled}
          placeholder={archivedProject ? t('chat.archivedPlaceholder') : !askable ? t('chat.notAskablePlaceholder') : t('chat.askPlaceholder')}
        />
      </div>
    </div>
  );
}
