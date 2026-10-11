import { Composer } from './Composer';
import { MessageItem } from './MessageItem';
import { useTranslation } from 'react-i18next';
import { useAppData } from '@/shared/mock-data';
import { ConversationList } from './ConversationList';
import { PanelLeftOpen, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useOutletContext, useSearchParams } from 'react-router-dom';

const KEYWORDS = [
  'auth',
  'login',
  'session',
  'token',
  'password',
  'rbac',
  'role',
  'checkout',
  'cart',
  'payment',
  'stripe',
  'pay',
  'refund',
  'change',
  'recent',
  'update',
  'new',
  'diff',
  'api',
  'service',
  'data',
  'integration',
];
/**
 * Project chat workspace with history, messages, and composer.
 *
 * @returns Chat workspace UI
 */
export default function ChatWorkspace() {
  const { t } = useTranslation();
  const { project: apiProject, mockProject, activeConvId, setActiveConvId } = useOutletContext();
  const project = mockProject ?? apiProject;
  const { getConversation, createConversation, askQuestion, editUserMessage, getConversations } = useAppData();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const [searchAttachment, setSearchAttachment] = useState(location.state?.searchAttachment ?? null);
  const [showHistory, setShowHistory] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [clarification, setClarification] = useState(null);
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const initRef = useRef(false);
  const conversation = activeConvId ? getConversation(activeConvId) : null;
  const messages = conversation?.messages || [];
  const queued = project.status === 'Updating' || project.status === 'Processing';
  const contextWarning = messages.length > 10;
  const runAsk = useCallback(
    async (convId, question) => {
      setIsGenerating(true);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      await askQuestion(convId, question, { signal: controller.signal });
      setIsGenerating(false);
    },
    [askQuestion],
  );
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    const convParam = searchParams.get('conv');
    const questionParam = searchParams.get('q');
    if (convParam) {
      setActiveConvId(convParam);
      return;
    }
    if (questionParam) {
      const created = createConversation(project.id, questionParam.length > 60 ? questionParam.slice(0, 60) : t('chat.newChat'));
      setActiveConvId(created.id);
      setSearchParams({ conv: created.id }, { replace: true });
      // Seed from ?q= on first mount only — intentional one-shot bootstrap.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-only URL seed
      void runAsk(created.id, questionParam);
      return;
    }
    const recent = getConversations(project.id, { archived: false })[0];
    if (recent) setActiveConvId(recent.id);
    // Intentionally run once on mount to seed conversation from URL / recent.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only seed
  }, []);
  const lastMessageContent = messages[messages.length - 1]?.content;
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages.length, lastMessageContent]);
  /**
   * Send a question, creating a conversation when needed.
   *
   * @param text - Question text
   */
  const handleSend = (text) => {
    if (clarification) return;
    const prompt = needsClarification(text, project);
    if (prompt) {
      setClarification(prompt);
      return;
    }
    let convId = activeConvId;
    if (!convId) {
      const created = createConversation(project.id, t('chat.newChat'));
      convId = created.id;
      setActiveConvId(convId);
      setSearchParams({ conv: convId }, { replace: true });
    }
    void runAsk(convId, text);
  };
  /**
   * Narrow an ambiguous question using a clarification chip.
   *
   * @param option - Selected capability label
   */
  const handleClarify = (option) => {
    if (!clarification) return;
    const question = t('chat.clarifiedQuestion', {
      question: clarification.question,
      option,
    });
    setClarification(null);
    handleSend(question);
  };
  /**
   * Start a blank conversation (clear active selection).
   */
  const handleNew = () => {
    setActiveConvId(null);
    setSearchParams({}, { replace: true });
    setShowHistory(false);
  };
  /**
   * Select a conversation from history.
   *
   * @param convId - Conversation id
   */
  const handleSelect = (convId) => {
    setActiveConvId(convId);
    setSearchParams({ conv: convId }, { replace: true });
    setShowHistory(false);
  };
  /**
   * Abort in-flight generation.
   */
  const handleStop = () => {
    abortRef.current?.abort();
    setIsGenerating(false);
  };
  /**
   * Edit a user message and re-ask from that point.
   *
   * @param msgId - Message id
   * @param newContent - Replacement content
   */
  const handleEdit = (msgId, newContent) => {
    if (!activeConvId) return;
    editUserMessage(activeConvId, msgId, newContent);
    void runAsk(activeConvId, newContent);
  };
  /**
   * Retry the last user question in the active conversation.
   */
  const handleRetry = () => {
    if (!activeConvId || messages.length < 2) return;
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    if (lastUser) void runAsk(activeConvId, lastUser.content);
  };
  const suggestedQuestions = [t('chat.suggestedAuth'), t('chat.suggestedCheckout'), t('chat.suggestedChanges')];
  return (
    <div className="flex h-full">
      <div className="hidden w-[260px] shrink-0 border-r border-border lg:block">
        <ConversationList projectId={project.id} activeConvId={activeConvId} onSelect={handleSelect} onNew={handleNew} />
      </div>

      {showHistory && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowHistory(false)} />
          <div className="absolute left-0 top-0 h-full w-[280px] border-r border-border bg-background">
            <ConversationList projectId={project.id} activeConvId={activeConvId} onSelect={handleSelect} onNew={handleNew} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 sm:px-6">
          <button
            type="button"
            className="-ml-1 rounded p-1 text-muted-foreground hover:bg-muted lg:hidden"
            onClick={() => setShowHistory(true)}
            aria-label={t('chat.openHistory')}
          >
            <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="truncate text-sm font-medium">{conversation?.title || t('chat.newChat')}</span>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-muted text-brand">
                <Sparkles className="h-6 w-6" aria-hidden="true" />
              </div>
              <h2 className="mt-4 font-display text-xl font-medium">{t('chat.emptyTitleNamed', { name: project.name })}</h2>
              <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{t('chat.emptyDescription')}</p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {suggestedQuestions.map((question) => (
                  <button
                    key={question}
                    type="button"
                    onClick={() => handleSend(question)}
                    className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-foreground/80 hover:border-brand/40 hover:bg-brand-muted/20"
                  >
                    {question}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl pb-4">
              {messages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  isUser={message.role === 'user'}
                  canEdit={message.role === 'user' && !isGenerating}
                  onEdit={(content) => handleEdit(message.id, content)}
                  onRetry={handleRetry}
                />
              ))}
            </div>
          )}
        </div>

        {clarification && (
          <div className="border-t border-border bg-muted/30 px-4 py-3 sm:px-6">
            <div className="mx-auto max-w-3xl">
              <p className="text-sm font-medium text-foreground">{t('chat.clarifyTitle')}</p>
              <p className="text-xs text-muted-foreground">{t('chat.clarifySubtitle')}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {clarification.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => handleClarify(option)}
                    className="rounded-full border border-border bg-card px-3 py-1.5 text-xs hover:border-brand/40 hover:bg-brand-muted/20"
                  >
                    {option}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setClarification(null)}
                  className="rounded-full px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          </div>
        )}

        {searchAttachment ? (
          <div className="border-t border-border bg-brand-muted/30 px-4 py-2 sm:px-6">
            <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
              <p className="truncate text-xs text-foreground">{t('chat.attachmentChip', { title: searchAttachment.title || searchAttachment.id })}</p>
              <button
                type="button"
                className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setSearchAttachment(null)}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : null}

        <Composer
          onSend={handleSend}
          onStop={handleStop}
          isGenerating={isGenerating}
          queued={queued}
          contextWarning={contextWarning}
          disabled={project.status === 'Archived'}
          placeholder={project.status === 'Archived' ? t('chat.archivedPlaceholder') : t('chat.askPlaceholder')}
        />
      </div>
    </div>
  );

  /**
   * Detect vague questions that need a capability clarification chip.
   *
   * @param question - User question text
   * @param project - Current project with knowledge tree
   * @returns Clarification prompt, or null when not needed
   */
  function needsClarification(question, project) {
    const normalized = question.toLowerCase();
    const hasKeyword = KEYWORDS.some((keyword) => normalized.includes(keyword));
    const vague = /\b(it|this|that|them)\b/.test(normalized) || normalized.split(/\s+/).length < 4;
    if (hasKeyword || !vague) return null;
    const options = (project.knowledgeTree || []).map((node) => node.label).slice(0, 3);
    if (options.length === 0) return null;
    return { question, options };
  }
}
