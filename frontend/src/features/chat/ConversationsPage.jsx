import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Input } from '@/shared/ui/input';
import { Button } from '@/shared/ui/button';
import { useTranslation } from 'react-i18next';
import { useAppData } from '@/shared/mock-data';
import { EmptyState } from '@/shared/components';
import { formatRelative } from '@/shared/lib/format';
import { MessagesSquare, Search, Archive } from 'lucide-react';

/**
 * Cross-project conversations list with archive toggle and search.
 *
 * @returns Conversations page
 */
export default function ConversationsPage() {
  const { t } = useTranslation();
  const { conversations, getProject, archiveConversation } = useAppData();
  const [query, setQuery] = useState('');
  const [view, setView] = useState('recent');
  const list = conversations
    .filter((conversation) => (view === 'archived' ? conversation.archived : !conversation.archived))
    .filter((conversation) => !query || conversation.title.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <h1 className="font-display text-xl font-medium">{t('conversations.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('conversations.subtitle')}</p>

        <div className="mt-4 flex items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('conversations.searchPlaceholder')}
              className="pl-8"
            />
          </div>
          <Button
            variant={view === 'archived' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setView(view === 'archived' ? 'recent' : 'archived')}
          >
            <Archive className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {view === 'archived' ? t('conversations.archived') : t('conversations.active')}
          </Button>
        </div>

        <div className="mt-5">
          {list.length === 0 ? (
            <EmptyState
              icon={MessagesSquare}
              title={t('conversations.emptyTitle')}
              description={view === 'archived' ? t('conversations.emptyArchived') : t('conversations.emptyActive')}
            />
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border bg-card">
              {list.map((conversation) => {
                const project = getProject(conversation.projectId);
                return (
                  <div key={conversation.id} className="flex items-center gap-3 px-4 py-3">
                    <MessagesSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <Link
                        to={`/projects/${conversation.projectId}/chat?conv=${conversation.id}`}
                        className="block truncate text-sm font-medium hover:text-brand"
                      >
                        {conversation.title}
                      </Link>
                      <div className="truncate text-xs text-muted-foreground">
                        {project?.name} · {formatRelative(conversation.createdAt)} ·{' '}
                        {t('chat.messageCount', {
                          count: conversation.messages.length,
                        })}
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => archiveConversation(conversation.id, !conversation.archived)}>
                      {conversation.archived ? t('conversations.restore') : t('conversations.archive')}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
