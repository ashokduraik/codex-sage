import { useState } from 'react';
import { Plus, Search, Archive, MoreHorizontal, MessageSquare, RotateCcw, Pencil, Trash2, } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppData } from '@/shared/mock-data';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, } from '@/shared/ui/dropdown-menu';
import { cn } from '@/shared/lib/utils';
import { formatRelative } from '@/shared/lib/format';
/**
 * Sidebar list of project conversations with rename/archive/delete actions.
 *
 * @param props - Project scope and selection handlers
 * @returns Conversation history panel
 */
export function ConversationList({ projectId, activeConvId, onSelect, onNew, }) {
    const { t } = useTranslation();
    const { getConversations, renameConversation, archiveConversation, deleteConversation, } = useAppData();
    const [query, setQuery] = useState('');
    const [view, setView] = useState('recent');
    const [renaming, setRenaming] = useState(null);
    const [renameVal, setRenameVal] = useState('');
    const conversations = getConversations(projectId, {
        archived: view === 'archived',
    }).filter((conversation) => !query ||
        conversation.title.toLowerCase().includes(query.toLowerCase()));
    /**
     * Begin inline rename for a conversation.
     *
     * @param conversation - Conversation to rename
     */
    const startRename = (conversation) => {
        setRenaming(conversation.id);
        setRenameVal(conversation.title);
    };
    /**
     * Commit the inline rename when the draft title is non-empty.
     */
    const commitRename = () => {
        if (renameVal.trim() && renaming) {
            renameConversation(renaming, renameVal.trim());
        }
        setRenaming(null);
    };
    return (<div className="flex h-full flex-col">
      <div className="p-3">
        <Button onClick={onNew} className="w-full justify-start bg-brand text-brand-foreground hover:bg-brand/90">
          <Plus className="mr-2 h-4 w-4" aria-hidden="true"/>
          {t('chat.newChat')}
        </Button>
      </div>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true"/>
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('chat.searchConversations')} className="h-9 pl-8 text-sm"/>
        </div>
      </div>
      <div className="flex gap-1 px-3 pb-1">
        <button type="button" onClick={() => setView('recent')} className={cn('rounded-md px-2.5 py-1 text-xs font-medium', view === 'recent'
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:text-foreground')}>
          {t('chat.recent')}
        </button>
        <button type="button" onClick={() => setView('archived')} className={cn('inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium', view === 'archived'
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:text-foreground')}>
          <Archive className="h-3 w-3" aria-hidden="true"/>
          {t('chat.archived')}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 scrollbar-thin">
        {conversations.length === 0 && (<p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {view === 'archived'
                ? t('chat.noArchivedConversations')
                : t('chat.noConversations')}
          </p>)}
        {conversations.map((conversation) => (<div key={conversation.id} className="group relative">
            <button type="button" onClick={() => onSelect(conversation.id)} className={cn('flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors', activeConvId === conversation.id
                ? 'bg-brand-muted/50'
                : 'hover:bg-muted')}>
              <MessageSquare className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', activeConvId === conversation.id
                ? 'text-brand'
                : 'text-muted-foreground')} aria-hidden="true"/>
              <div className="min-w-0 flex-1">
                {renaming === conversation.id ? (<input autoFocus value={renameVal} onChange={(event) => setRenameVal(event.target.value)} onBlur={commitRename} onKeyDown={(event) => {
                    if (event.key === 'Enter')
                        commitRename();
                }} onClick={(event) => event.stopPropagation()} className="w-full rounded border border-input bg-background px-1 py-0.5 text-sm outline-none"/>) : (<div className="truncate text-sm font-medium text-foreground/90">
                    {conversation.title}
                  </div>)}
                <div className="truncate text-[11px] text-muted-foreground">
                  {formatRelative(conversation.createdAt)} ·{' '}
                  {t('chat.messageCount', {
                count: conversation.messages.length,
            })}
                </div>
              </div>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="absolute right-1.5 top-1.5 hidden h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background group-hover:flex" onClick={(event) => event.stopPropagation()} aria-label={t('common.actions')}>
                  <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true"/>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => startRename(conversation)}>
                  <Pencil className="mr-2 h-3.5 w-3.5" aria-hidden="true"/>
                  {t('chat.rename')}
                </DropdownMenuItem>
                {view === 'archived' ? (<DropdownMenuItem onClick={() => archiveConversation(conversation.id, false)}>
                    <RotateCcw className="mr-2 h-3.5 w-3.5" aria-hidden="true"/>
                    {t('conversations.restore')}
                  </DropdownMenuItem>) : (<DropdownMenuItem onClick={() => archiveConversation(conversation.id, true)}>
                    <Archive className="mr-2 h-3.5 w-3.5" aria-hidden="true"/>
                    {t('chat.archive')}
                  </DropdownMenuItem>)}
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => deleteConversation(conversation.id)}>
                  <Trash2 className="mr-2 h-3.5 w-3.5" aria-hidden="true"/>
                  {t('chat.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>))}
      </div>
    </div>);
}
export default ConversationList;
