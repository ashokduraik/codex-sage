/**
 * Project conversation history panel — list, search, and lifecycle actions via React Query.
 */
import { useState } from 'react';
import { cn } from '@/shared/lib/utils';
import { Input } from '@/shared/ui/input';
import { Button } from '@/shared/ui/button';
import { useTranslation } from 'react-i18next';
import { messageFromUnknown } from '@/shared/api';
import { formatRelative } from '@/shared/lib/format';
import { useAuth } from '@/features/auth/AuthContext';
import { useConversationSearch } from '@/features/chat/hooks/useConversationSearch.js';
import { useConversations, flattenConversationPages } from '@/features/chat/hooks/useConversations.js';
import { Loader2, Plus, Search, Archive, MoreHorizontal, MessageSquare, RotateCcw, Pencil, Trash2 } from 'lucide-react';
import { DropdownMenu, DropdownMenuItem, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuSeparator } from '@/shared/ui/dropdown-menu';
import {
  useDeleteConversation,
  useRenameConversation,
  useArchiveConversation,
  useRestoreConversation,
} from '@/features/chat/hooks/useConversationMutations.js';

/**
 * Sidebar list of project conversations with rename/archive/delete actions.
 *
 * @param props - Project scope and selection handlers
 * @returns Conversation history panel
 */
export function ConversationList({ projectId, activeConvId, onSelect, onNew, creating = false }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const permissions = Array.isArray(user?.permissions) ? user.permissions : [];
  const canSearch = permissions.includes('conversations.search');
  const canArchive = permissions.includes('conversations.archive');
  const [query, setQuery] = useState('');
  const [view, setView] = useState('recent');
  const [renaming, setRenaming] = useState(null);
  const [renameVal, setRenameVal] = useState('');
  const [actionError, setActionError] = useState('');
  const archived = view === 'archived';
  const searching = canSearch && query.trim().length > 0;

  const listQuery = useConversations(projectId, {
    archived,
    enabled: !searching,
  });
  const {
    debouncedQuery,
    query: searchQuery,
    hits,
  } = useConversationSearch(projectId, {
    q: query,
    archived,
    enabled: searching,
  });
  const renameMutation = useRenameConversation(projectId);
  const archiveMutation = useArchiveConversation(projectId);
  const restoreMutation = useRestoreConversation(projectId);
  const deleteMutation = useDeleteConversation(projectId);

  const listItems = flattenConversationPages(listQuery.data);
  const busy = creating || renameMutation.isPending || archiveMutation.isPending || restoreMutation.isPending || deleteMutation.isPending;

  /**
   * Begin inline rename for a conversation.
   * @param conversation - Conversation to rename
   */
  const startRename = (conversation) => {
    setActionError('');
    setRenaming(conversation.id);
    setRenameVal(conversation.title);
  };

  /**
   * Commit the inline rename when the draft title is non-empty.
   */
  const commitRename = () => {
    const conversationId = renaming;
    const nextTitle = renameVal.trim();
    setRenaming(null);
    if (!conversationId || !nextTitle) {
      return;
    }
    const previous = listItems.find((row) => String(row.id) === String(conversationId));
    renameMutation.mutate(
      {
        conversationId,
        title: nextTitle,
        previousTitle: previous?.title,
      },
      {
        onError: (error) => {
          setActionError(messageFromUnknown(error, t('chat.renameFailed')));
        },
      },
    );
  };

  /**
   * Archives or restores a conversation based on the current view.
   * @param conversationId - Conversation id
   */
  const handleArchiveToggle = (conversationId) => {
    setActionError('');
    const mutation = archived ? restoreMutation : archiveMutation;
    mutation.mutate(conversationId, {
      onError: (error) => {
        setActionError(messageFromUnknown(error, archived ? t('chat.restoreFailed') : t('chat.archiveFailed')));
      },
    });
  };

  /**
   * Soft-deletes a conversation after confirm.
   * @param conversationId - Conversation id
   */
  const handleDelete = (conversationId) => {
    const confirmed = window.confirm(t('chat.deleteConfirm'));
    if (!confirmed) {
      return;
    }
    setActionError('');
    deleteMutation.mutate(conversationId, {
      onSuccess: () => {
        if (String(activeConvId) === String(conversationId)) {
          onSelect(null);
        }
      },
      onError: (error) => {
        setActionError(messageFromUnknown(error, t('chat.deleteFailed')));
      },
    });
  };

  const showSearchPending = searching && searchQuery.isPending && !searchQuery.data;
  const showListPending = !searching && listQuery.isPending && !listQuery.data;
  const showSearchError = searching && searchQuery.isError;
  const showListError = !searching && listQuery.isError;
  const showSearchEmpty = searching && !searchQuery.isPending && !searchQuery.isError && debouncedQuery && hits.length === 0;
  const showListEmpty = !searching && !listQuery.isPending && !listQuery.isError && listItems.length === 0;

  return (
    <div className="flex h-full flex-col" aria-busy={busy || undefined}>
      <div className="p-3">
        <Button onClick={onNew} disabled={creating} className="w-full justify-start bg-brand text-brand-foreground hover:bg-brand/90">
          {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="mr-2 h-4 w-4" aria-hidden="true" />}
          {t('chat.newChat')}
        </Button>
      </div>
      {canSearch ? (
        <div className="px-3 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('chat.searchConversations')}
              className="h-9 pl-8 text-sm"
            />
          </div>
        </div>
      ) : null}
      <p className="px-3 pb-2 text-[11px] leading-snug text-muted-foreground">{t('chat.privacyNote')}</p>
      <div className="flex gap-1 px-3 pb-1" role="tablist" aria-label={t('chat.historyViews')}>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'recent'}
          onClick={() => setView('recent')}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium',
            view === 'recent' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {t('chat.recent')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'archived'}
          onClick={() => setView('archived')}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium',
            view === 'archived' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Archive className="h-3 w-3" aria-hidden="true" />
          {t('chat.archived')}
        </button>
      </div>
      {actionError ? (
        <p className="px-3 pb-2 text-xs text-destructive" role="alert">
          {actionError}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 scrollbar-thin" role="listbox" aria-label={t('chat.historyList')}>
        {(showListPending || showSearchPending) && (
          <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground" aria-busy="true">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('common.loading')}
          </div>
        )}
        {showListError && (
          <div className="space-y-2 px-3 py-6 text-center" role="alert">
            <p className="text-xs text-destructive">{messageFromUnknown(listQuery.error, t('chat.listFailed'))}</p>
            <Button size="sm" variant="outline" onClick={() => void listQuery.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        )}
        {showSearchError && (
          <div className="space-y-2 px-3 py-6 text-center" role="alert">
            <p className="text-xs text-destructive">{messageFromUnknown(searchQuery.error, t('chat.searchFailed'))}</p>
            <Button size="sm" variant="outline" onClick={() => void searchQuery.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        )}
        {showListEmpty && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {view === 'archived' ? t('chat.noArchivedConversations') : t('chat.noConversations')}
          </p>
        )}
        {showSearchEmpty && <p className="px-3 py-6 text-center text-xs text-muted-foreground">{t('chat.searchEmpty')}</p>}
        {searching
          ? hits.map((hit) => (
              <button
                key={hit.id}
                type="button"
                role="option"
                aria-selected={activeConvId === hit.id}
                aria-current={activeConvId === hit.id ? 'true' : undefined}
                onClick={() => onSelect(hit.id)}
                className={cn(
                  'mb-0.5 flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                  activeConvId === hit.id ? 'bg-brand-muted/50' : 'hover:bg-muted',
                )}
              >
                <span className="truncate text-sm font-medium text-foreground/90">{hit.title}</span>
                {hit.snippet ? <span className="line-clamp-2 text-[11px] text-muted-foreground">{hit.snippet}</span> : null}
                <span className="text-[11px] text-muted-foreground">{formatRelative(hit.updatedAt)}</span>
              </button>
            ))
          : listItems.map((conversation) => (
              <div key={conversation.id} className="group relative">
                <button
                  type="button"
                  role="option"
                  aria-selected={activeConvId === conversation.id}
                  aria-current={activeConvId === conversation.id ? 'true' : undefined}
                  onClick={() => onSelect(conversation.id)}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                    activeConvId === conversation.id ? 'bg-brand-muted/50' : 'hover:bg-muted',
                  )}
                >
                  <MessageSquare
                    className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', activeConvId === conversation.id ? 'text-brand' : 'text-muted-foreground')}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    {renaming === conversation.id ? (
                      <input
                        autoFocus
                        value={renameVal}
                        onChange={(event) => setRenameVal(event.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitRename();
                        }}
                        onClick={(event) => event.stopPropagation()}
                        className="w-full rounded border border-input bg-background px-1 py-0.5 text-sm outline-none"
                      />
                    ) : (
                      <div className="truncate text-sm font-medium text-foreground/90">{conversation.title || t('chat.untitled')}</div>
                    )}
                    <div className="truncate text-[11px] text-muted-foreground">
                      {formatRelative(conversation.lastMessageAt || conversation.updatedAt)} ·{' '}
                      {t('chat.messageCount', {
                        count: conversation.messageCount ?? 0,
                      })}
                    </div>
                  </div>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background"
                      onClick={(event) => event.stopPropagation()}
                      aria-label={t('common.actions')}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => {
                        // Defer so the menu close does not steal focus from the rename field.
                        window.setTimeout(() => startRename(conversation), 0);
                      }}
                    >
                      <Pencil className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                      {t('chat.rename')}
                    </DropdownMenuItem>
                    {canArchive ? (
                      <DropdownMenuItem
                        onSelect={() => {
                          handleArchiveToggle(conversation.id);
                        }}
                      >
                        {view === 'archived' ? (
                          <>
                            <RotateCcw className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                            {t('conversations.restore')}
                          </>
                        ) : (
                          <>
                            <Archive className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                            {t('chat.archive')}
                          </>
                        )}
                      </DropdownMenuItem>
                    ) : null}
                    {canArchive ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => {
                            handleDelete(conversation.id);
                          }}
                        >
                          <Trash2 className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                          {t('chat.delete')}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
        {!searching && listQuery.hasNextPage ? (
          <div className="px-2 pt-1">
            <Button
              size="sm"
              variant="ghost"
              className="w-full text-xs"
              disabled={listQuery.isFetchingNextPage}
              onClick={() => void listQuery.fetchNextPage()}
            >
              {listQuery.isFetchingNextPage ? t('common.loading') : t('chat.loadMore')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default ConversationList;
