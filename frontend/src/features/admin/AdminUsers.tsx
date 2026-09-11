import { useState } from 'react';
import {
  Plus,
  Search,
  MoreHorizontal,
  KeyRound,
  Trash2,
  UserCog,
  Ban,
  CheckCircle2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/shared/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { Badge } from '@/shared/ui/badge';
import { formatRelative } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { useAppData } from '@/shared/mock-data';
import type { User } from '@/shared/types/domain';

const ROLES = ['Admin', 'Editor', 'Viewer'] as const;

/**
 * Admin users management with create, role change, and password reset.
 *
 * @returns Admin users page
 */
export default function AdminUsers() {
  const { t } = useTranslation();
  const { users, updateUser, createUser, removeUser, logAudit } = useAppData();
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [newUser, setNewUser] = useState({
    name: '',
    email: '',
    role: 'Viewer' as (typeof ROLES)[number],
  });

  const filtered = users.filter(
    (user) =>
      !query ||
      `${user.name}${user.email}`.toLowerCase().includes(query.toLowerCase()),
  );

  /**
   * Create a user from the dialog form.
   */
  const submitCreate = () => {
    if (!newUser.name.trim() || !newUser.email.trim()) return;
    createUser(newUser);
    setCreateOpen(false);
    setNewUser({ name: '', email: '', role: 'Viewer' });
    toast.success(t('admin.userCreated'));
  };

  /**
   * Log an admin password reset for the selected user.
   */
  const resetPassword = () => {
    if (!resetTarget) return;
    logAudit('Reset user password', resetTarget.name);
    toast.success(t('admin.resetLinkSent'));
    setResetTarget(null);
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-xl font-medium">
              {t('admin.usersTitle')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('admin.usersSubtitle')}
            </p>
          </div>
          <Button
            onClick={() => setCreateOpen(true)}
            className="bg-brand text-brand-foreground hover:bg-brand/90"
          >
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('admin.inviteUser')}
          </Button>
        </div>

        <div className="relative mt-4 max-w-sm">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('admin.searchUsers')}
            className="pl-8"
          />
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
          <div className="grid grid-cols-[1.5fr_1fr_1fr_1.5fr_1fr_40px] gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <span>{t('admin.name')}</span>
            <span>{t('admin.role')}</span>
            <span>{t('admin.status')}</span>
            <span>{t('admin.projectAccess')}</span>
            <span>{t('admin.lastActivity')}</span>
            <span />
          </div>
          {filtered.map((user) => (
            <div
              key={user.id}
              className="grid grid-cols-[1.5fr_1fr_1fr_1.5fr_1fr_40px] items-center gap-2 border-b border-border px-4 py-2.5 text-sm last:border-0"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{user.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {user.email}
                </div>
              </div>
              <Select
                value={String(user.role)}
                onValueChange={(role) => updateUser(user.id, { role })}
              >
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span
                className={cn(
                  'inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs',
                  user.status === 'Active'
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {user.status === 'Active' ? (
                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <Ban className="h-3 w-3" aria-hidden="true" />
                )}{' '}
                {t(`status.${user.status}`, { defaultValue: String(user.status) })}
              </span>
              <div className="flex flex-wrap gap-1">
                {user.projects.length === 0 ? (
                  <span className="text-xs text-muted-foreground">—</span>
                ) : (
                  user.projects.map((projectName) => (
                    <Badge
                      key={projectName}
                      variant="secondary"
                      className="text-[10px]"
                    >
                      {projectName}
                    </Badge>
                  ))
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                {formatRelative(user.lastActivity)}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                    aria-label={t('common.actions')}
                  >
                    <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() =>
                      updateUser(user.id, {
                        status:
                          user.status === 'Active' ? 'Inactive' : 'Active',
                      })
                    }
                  >
                    <UserCog className="mr-2 h-4 w-4" aria-hidden="true" />
                    {user.status === 'Active'
                      ? t('admin.deactivate')
                      : t('admin.activate')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setResetTarget(user)}>
                    <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t('admin.resetPassword')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => removeUser(user.id)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t('admin.removeUser')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('admin.createUserTitle')}</DialogTitle>
            <DialogDescription>
              {t('admin.createUserDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="n-name">{t('auth.fullName')}</Label>
              <Input
                id="n-name"
                value={newUser.name}
                onChange={(event) =>
                  setNewUser({ ...newUser, name: event.target.value })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="n-email">{t('admin.email')}</Label>
              <Input
                id="n-email"
                type="email"
                value={newUser.email}
                onChange={(event) =>
                  setNewUser({ ...newUser, email: event.target.value })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('admin.role')}</Label>
              <Select
                value={newUser.role}
                onValueChange={(role) =>
                  setNewUser({
                    ...newUser,
                    role: role as (typeof ROLES)[number],
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={submitCreate}
              disabled={!newUser.name.trim() || !newUser.email.trim()}
            >
              {t('admin.inviteUser')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!resetTarget}
        onOpenChange={(open) => {
          if (!open) setResetTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('admin.resetPasswordFor', { name: resetTarget?.name })}
            </DialogTitle>
            <DialogDescription>
              {t('admin.resetPasswordDescription', {
                email: resetTarget?.email,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={resetPassword}>{t('auth.sendResetLink')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
