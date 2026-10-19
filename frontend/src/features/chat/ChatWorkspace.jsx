/**
 * Project chat workspace — conversation history, messages, SSE send/stop/retry, and clarification wizard.
 */
import { Composer } from './Composer';
import { MessageItem } from './MessageItem';
import { useTranslation } from 'react-i18next';
import { ConversationList } from './ConversationList';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ClarificationPanel } from './ClarificationPanel.jsx';
import { SourcePreviewDrawer } from '@/shared/source-preview';
import { Loader2, PanelLeftOpen, Sparkles } from 'lucide-react';
import KnowledgeVersionNotice from './KnowledgeVersionNotice.jsx';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useSendMessage } from '@/features/chat/hooks/useSendMessage.js';
import { useConversation } from '@/features/chat/hooks/useConversation.js';
import { useAskAboutContext } from '@/features/chat/hooks/useAskAboutContext.js';
import { useClarificationWizard } from '@/features/chat/hooks/useClarificationWizard.js';
import { isProjectAskable, isProjectArchived } from '@/shared/components/StatusBadge.jsx';
import { useCreateConversation } from '@/features/chat/hooks/useConversationMutations.js';
import { isForbiddenApiError, isNotFoundApiError, messageFromUnknown } from '@/shared/api';
import { useConversationMessages, flattenMessagePages } from '@/features/chat/hooks/useConversationMessages.js';

/**
 * Project chat workspace with history, messages, streaming composer, and clarification panel.
 *
 * @returns Chat workspace UI
 */
export default function ChatWorkspace() {
  const { t } = useTranslation();
  const { project, activeConvId, setActiveConvId } = useOutletContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showHistory, setShowHistory] = useState(false);
  const [createError, setCreateError] = useState('');
  const [previewTarget, setPreviewTarget] = useState(null);
  const scrollRef = useRef(null);
  const historyToggleRef = useRef(null);
  const initRef = useRef(false);
  const nearBottomRef = useRef(true);
  const projectId = project?.id ? String(project.id) : '';
  const currentKnowledgeVersionId = typeof project?.currentKnowledgeVersionId === 'string' ? project.currentKnowledgeVersionId : null;
  const { attachment, clearAttachment } = useAskAboutContext();
  const createMutation = useCreateConversation(projectId);
  const detailQuery = useConversation(projectId, activeConvId);
  const messagesQuery = useConversationMessages(projectId, activeConvId);
  const messages = flattenMessagePages(messagesQuery.data);
  const conversation = detailQuery.data ?? null;
  const archivedProject = isProjectArchived(project);
  const askable = isProjectAskable(project);
  const knowledgeUpdating = project?.knowledgeHealth === 'updating' || project?.lifecycleStatus === 'updating';
  const title = conversation?.title || t('chat.newChat');
  const { stream, isBusy, isSubmittingClarification, send, retry, edit, submitClarificationAnswers, stop, clearClarification } = useSendMessage({
    projectId,
    conversationId: activeConvId,
  });

  const contextWarning = useMemo(() => {
    const latestAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.messageStatus === 'completed');
    const percent = latestAssistant?.contextMetrics?.contextPercentUsed;
    return typeof percent === 'number' && Number.isFinite(percent) && percent >= 0.8;
  }, [messages]);

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

  const awaitingMessage = useMemo(() => {
    return [...messages].reverse().find((m) => m.role === 'assistant' && m.messageStatus === 'awaiting_clarification');
  }, [messages]);

  const clarificationSetPayload = useMemo(() => {
    if (stream.clarification && typeof stream.clarification === 'object') {
      return /** @type {object} */ (stream.clarification);
    }
    if (awaitingMessage?.clarification && typeof awaitingMessage.clarification === 'object') {
      return {
        ...awaitingMessage.clarification,
        messageId: awaitingMessage.id,
      };
    }
    return null;
  }, [stream.clarification, awaitingMessage]);

  const wizard = useClarificationWizard({
    conversationId: activeConvId,
    setPayload: clarificationSetPayload,
  });

  const clearWizard = wizard.clear;
  const wizardWasActiveRef = useRef(false);
  if (wizard.active) {
    wizardWasActiveRef.current = true;
  }
  const prevPhaseRef = useRef(stream.phase);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = stream.phase;
    if (prev !== 'completed' && stream.phase === 'completed' && wizardWasActiveRef.current) {
      wizardWasActiveRef.current = false;
      clearWizard();
      clearClarification();
    }
  }, [stream.phase, clearWizard, clearClarification]);

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
    if (!askable || archivedProject || isBusy || wizard.active || isSubmittingClarification) {
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
   * Edits a user message and regenerates the answer (replace-downstream).
   * @param {string} messageId User message id.
   * @param {string} content Replacement question text.
   */
  const handleEdit = (messageId, content) => {
    if (!askable || archivedProject || isBusy || wizard.active || isSubmittingClarification) {
      return;
    }
    void edit(messageId, content);
  };

  /**
   * Submits the full clarification answer map once.
   * @param {Record<string, string | string[]>} answers Answer map.
   */
  const handleClarificationSubmit = (answers) => {
    const messageId =
      (clarificationSetPayload && typeof clarificationSetPayload.messageId === 'string' ? clarificationSetPayload.messageId : null) ||
      stream.assistantMessageId ||
      awaitingMessage?.id;
    const clarificationSetId =
      clarificationSetPayload && typeof clarificationSetPayload.clarificationSetId === 'string' ? clarificationSetPayload.clarificationSetId : '';
    if (!activeConvId || !messageId || !clarificationSetId) {
      return;
    }
    void submitClarificationAnswers({
      conversationId: activeConvId,
      messageId,
      clarificationSetId,
      answers,
    });
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
  const clarificationActive = wizard.active || wizard.emptySetError;
  const composerDisabled = archivedProject || !askable || createMutation.isPending || clarificationActive || isSubmittingClarification;
  const showOptimisticUser =
    Boolean(stream.optimisticUserContent) && (stream.phase === 'posting' || stream.phase === 'streaming' || stream.phase === 'queued');
  const showStreamingAssistant =
    (isBusy || stream.phase === 'cancelled' || stream.phase === 'interrupted' || stream.phase === 'failed') &&
    stream.phase !== 'awaiting_clarification';
  const latestAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const canRetryLatest =
    latestAssistant &&
    (latestAssistant.messageStatus === 'failed' ||
      latestAssistant.messageStatus === 'interrupted' ||
      latestAssistant.messageStatus === 'abstained') &&
    !isBusy &&
    !clarificationActive;

  const clarificationSubmitError = stream.phase === 'failed' && clarificationActive && stream.errorMessage ? stream.errorMessage : null;

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

        {stream.phase === 'failed' && stream.errorMessage && !clarificationActive ? (
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

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin"
          aria-busy={isBusy || isSubmittingClarification}
        >
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
            <>
              <KnowledgeVersionNotice projectId={projectId} currentKnowledgeVersionId={currentKnowledgeVersionId} messages={messages} />
              <div className="mx-auto max-w-3xl pb-4">
                {messages.map((message) => (
                  <MessageItem
                    key={message.id}
                    message={message}
                    isUser={message.role === 'user'}
                    canEdit={message.role === 'user' && askable && !archivedProject && !isBusy && !clarificationActive && !isSubmittingClarification}
                    onEdit={(content) => handleEdit(message.id, content)}
                    projectId={projectId}
                    conversationId={activeConvId}
                    currentKnowledgeVersionId={currentKnowledgeVersionId}
                    onPreview={setPreviewTarget}
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
                    projectId={projectId}
                    conversationId={activeConvId}
                    currentKnowledgeVersionId={currentKnowledgeVersionId}
                    onPreview={setPreviewTarget}
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
            </>
          )}
        </div>

        <ClarificationPanel
          wizard={wizard}
          submitting={isSubmittingClarification}
          submitError={clarificationSubmitError}
          onSubmit={handleClarificationSubmit}
        />

        <Composer
          onSend={handleSend}
          onStop={stop}
          isGenerating={isBusy && !isSubmittingClarification}
          queued={knowledgeUpdating || stream.phase === 'queued'}
          contextWarning={contextWarning}
          attachment={attachment}
          onClearAttachment={clearAttachment}
          disabled={composerDisabled}
          placeholder={
            clarificationActive
              ? t('chat.awaitingClarification')
              : archivedProject
                ? t('chat.archivedPlaceholder')
                : !askable
                  ? t('chat.notAskablePlaceholder')
                  : t('chat.askPlaceholder')
          }
        />
      </div>
      <SourcePreviewDrawer projectId={projectId} target={previewTarget} onClose={() => setPreviewTarget(null)} />
    </div>
  );
}
