import { useEffect, useMemo, useState } from 'react';
import { Ban, CheckCircle2, KeyRound, Loader2, MoreHorizontal, Plus, Search, Trash2, UserCog } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '@/features/auth/AuthContext';
import { correlationFromUnknown, messageFromUnknown } from '@/shared/api';
import { useRoles } from '@/features/admin/api/useRoles.js';
import { useUsers } from '@/features/admin/api/useUsers.js';
import { useCreateUser, useRemoveUser, useResetUserPassword, useSetUserStatus, useUpdateUserRoles } from '@/features/admin/api/useUserMutations.js';
import { InlineErrorAlert } from '@/features/admin/InlineErrorAlert.jsx';
import { RoleMultiSelect } from '@/features/admin/RoleMultiSelect.jsx';
import { formatRelative } from '@/shared/lib/format';
import { cn } from '@/shared/lib/utils';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select';

/** Debounce delay before search text reaches the query key. */
const USER_SEARCH_DEBOUNCE_MS = 300;

/**
 * Admin users management against the real identity APIs.
 *
 * @returns Admin users page.
 */
export default function AdminUsers() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const canManageUsers = Boolean(currentUser?.permissions?.includes('users.manage'));
  const canManageRoles = Boolean(currentUser?.permissions?.includes('roles.manage'));

  const urlQ = searchParams.get('q') ?? '';
  const userStatus = searchParams.get('userStatus') ?? '';
  const roleId = searchParams.get('roleId') ?? '';
  const cursor = searchParams.get('cursor') ?? '';

  const [searchDraft, setSearchDraft] = useState(() => searchParams.get('q') ?? '');
  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [rolesEditTarget, setRolesEditTarget] = useState(null);
  // Which row's actions panel is open. Closed on every action so a list refetch cannot leave a detaching menu.
  const [openRowActionsUserId, setOpenRowActionsUserId] = useState(/** @type {string | null} */ (null));
  const [createForm, setCreateForm] = useState({
    displayName: '',
    email: '',
    code: '',
    roleIds: /** @type {string[]} */ ([]),
  });
  const [editRoleIds, setEditRoleIds] = useState(/** @type {string[]} */ ([]));
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordCompleted, setPasswordCompleted] = useState(false);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const next = searchDraft.trim();
      if (next === urlQ) {
        return;
      }
      const params = new URLSearchParams(searchParams);
      if (next) {
        params.set('q', next);
      } else {
        params.delete('q');
      }
      params.delete('cursor');
      setSearchParams(params, { replace: true });
    }, USER_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchDraft, urlQ, searchParams, setSearchParams]);

  const usersQuery = useUsers({
    q: urlQ || undefined,
    userStatus: userStatus || undefined,
    roleId: roleId || undefined,
    cursor: cursor || undefined,
    enabled: canManageUsers,
  });

  const rolesQuery = useRoles({ enabled: canManageRoles });
  const roles = rolesQuery.data ?? [];

  const createMutation = useCreateUser();
  const updateRolesMutation = useUpdateUserRoles();
  const statusMutation = useSetUserStatus();
  const removeMutation = useRemoveUser();
  const resetMutation = useResetUserPassword();

  const users = usersQuery.data?.items ?? [];
  const nextCursor = usersQuery.data?.pageInfo?.nextCursor ?? null;
  const hasMore = Boolean(usersQuery.data?.pageInfo?.hasMore && nextCursor);

  const listErrorMessage = usersQuery.isError ? messageFromUnknown(usersQuery.error, t('errors.unexpected')) : '';
  const listCorrelationId = usersQuery.isError ? correlationFromUnknown(usersQuery.error) : '';

  /**
   * Updates a filter query param and clears the cursor.
   * @param {string} key Param name.
   * @param {string} value Param value (empty clears).
   */
  function setFilterParam(key, value) {
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    params.delete('cursor');
    setSearchParams(params, { replace: true });
  }

  /**
   * Advances to the next keyset page.
   */
  function goNextPage() {
    if (!nextCursor) {
      return;
    }
    const params = new URLSearchParams(searchParams);
    params.set('cursor', nextCursor);
    setSearchParams(params, { replace: true });
  }

  /**
   * Returns to the first page (clears cursor).
   */
  function goFirstPage() {
    const params = new URLSearchParams(searchParams);
    params.delete('cursor');
    setSearchParams(params, { replace: true });
  }

  /**
   * Whether a row-scoped mutation is in flight for this user.
   * @param {string} userId User id.
   * @returns {boolean}
   */
  function isRowBusy(userId) {
    const statusVars = statusMutation.variables;
    const rolesVars = updateRolesMutation.variables;
    const removeVars = removeMutation.variables;
    return (
      (statusMutation.isPending && statusVars?.userId === userId) ||
      (updateRolesMutation.isPending && rolesVars?.userId === userId) ||
      (removeMutation.isPending && removeVars?.userId === userId)
    );
  }

  const createBusy = createMutation.isPending;
  const resetBusy = resetMutation.isPending;
  const removeBusy = removeMutation.isPending;
  const rolesEditBusy = updateRolesMutation.isPending;

  const createError = createMutation.isError ? messageFromUnknown(createMutation.error, t('errors.unexpected')) : '';
  const createCorrelation = createMutation.isError ? correlationFromUnknown(createMutation.error) : '';

  const resetError = resetMutation.isError ? messageFromUnknown(resetMutation.error, t('errors.unexpected')) : '';
  const resetCorrelation = resetMutation.isError ? correlationFromUnknown(resetMutation.error) : '';

  const removeError = removeMutation.isError ? messageFromUnknown(removeMutation.error, t('errors.unexpected')) : '';
  const removeCorrelation = removeMutation.isError ? correlationFromUnknown(removeMutation.error) : '';

  const rolesEditError = updateRolesMutation.isError ? messageFromUnknown(updateRolesMutation.error, t('errors.unexpected')) : '';
  const rolesEditCorrelation = updateRolesMutation.isError ? correlationFromUnknown(updateRolesMutation.error) : '';

  const rowActionError = useMemo(() => {
    if (statusMutation.isError) {
      return {
        message: messageFromUnknown(statusMutation.error, t('errors.unexpected')),
        correlationId: correlationFromUnknown(statusMutation.error),
        userId: statusMutation.variables?.userId,
      };
    }
    return null;
  }, [statusMutation.isError, statusMutation.error, statusMutation.variables, t]);

  /**
   * Opens the create dialog with a clean form.
   */
  function openCreateDialog() {
    createMutation.reset();
    setCreateForm({
      displayName: '',
      email: '',
      code: '',
      roleIds: roles[0] ? [String(roles[0].id)] : [],
    });
    setCreateOpen(true);
  }

  /**
   * Submits create-user.
   */
  async function submitCreate() {
    if (!createForm.displayName.trim() || !createForm.email.trim() || !createForm.code.trim() || !createForm.roleIds.length) {
      return;
    }
    try {
      await createMutation.mutateAsync({
        code: createForm.code.trim().toUpperCase(),
        email: createForm.email.trim(),
        displayName: createForm.displayName.trim(),
        roleIds: createForm.roleIds,
        idempotencyKey: crypto.randomUUID(),
      });
      setCreateOpen(false);
      toast.success(t('admin.userCreated'));
    } catch {
      // Inline alert renders mutation error.
    }
  }

  /**
   * Closes the row actions panel.
   */
  function closeRowActions() {
    setOpenRowActionsUserId(null);
  }

  /**
   * Opens the edit-roles dialog for a user.
   * @param {object} targetUser User row.
   */
  function openRolesEditor(targetUser) {
    closeRowActions();
    updateRolesMutation.reset();
    setRolesEditTarget(targetUser);
    setEditRoleIds((targetUser.roles ?? []).map((role) => String(role.id)));
  }

  /**
   * Saves multi-role assignment.
   */
  async function submitRolesEdit() {
    if (!rolesEditTarget || editRoleIds.length < 1) {
      return;
    }
    const selectedRoles = roles.filter((role) => editRoleIds.includes(String(role.id)));
    try {
      await updateRolesMutation.mutateAsync({
        userId: rolesEditTarget.id,
        roleIds: editRoleIds,
        roles: selectedRoles.map((role) => ({
          id: String(role.id),
          name: role.name,
        })),
      });
      setRolesEditTarget(null);
      toast.success(t('admin.rolesUpdated'));
    } catch {
      // Inline alert.
    }
  }

  /**
   * Activates or deactivates a user.
   * @param {object} targetUser User row.
   */
  async function toggleUserStatus(targetUser) {
    closeRowActions();
    statusMutation.reset();
    const action = targetUser.userStatus === 'active' ? 'deactivate' : 'activate';
    try {
      await statusMutation.mutateAsync({ userId: targetUser.id, action });
      toast.success(action === 'deactivate' ? t('admin.userDeactivated') : t('admin.userActivated'));
    } catch {
      // Row alert.
    }
  }

  /**
   * Confirms soft-remove.
   */
  async function confirmRemove() {
    if (!removeTarget) {
      return;
    }
    try {
      await removeMutation.mutateAsync({ userId: removeTarget.id });
      setRemoveTarget(null);
      toast.success(t('admin.userRemoved'));
    } catch {
      // Inline alert.
    }
  }

  /**
   * Submits administrator password set.
   */
  async function submitPasswordReset() {
    if (!resetTarget || !newPassword || newPassword !== confirmPassword) {
      return;
    }
    try {
      const result = await resetMutation.mutateAsync({
        userId: resetTarget.id,
        newPassword,
        idempotencyKey: crypto.randomUUID(),
      });
      setNewPassword('');
      setConfirmPassword('');
      if (result?.passwordResetStatus === 'completed') {
        setPasswordCompleted(true);
      }
    } catch {
      // Inline alert.
    }
  }

  /**
   * Opens the set-password dialog.
   * @param {object} targetUser User row.
   */
  function openResetDialog(targetUser) {
    closeRowActions();
    resetMutation.reset();
    setPasswordCompleted(false);
    setNewPassword('');
    setConfirmPassword('');
    setResetTarget(targetUser);
  }

  if (!canManageUsers) {
    return (
      <div className="h-full overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-5xl px-6 py-8">
          <p role="alert" className="text-sm text-destructive">
            {t('errors.codes.FORBIDDEN')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="font-display text-xl font-medium">{t('admin.usersTitle')}</h1>
            <p className="text-sm text-muted-foreground">{t('admin.usersSubtitle')}</p>
          </div>
          <Button onClick={openCreateDialog} className="bg-brand text-brand-foreground hover:bg-brand/90" disabled={!canManageUsers}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('admin.inviteUser')}
          </Button>
        </div>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder={t('admin.searchUsers')}
              className="pl-8"
              aria-label={t('admin.searchUsers')}
            />
          </div>
          <Select value={userStatus || 'all'} onValueChange={(value) => setFilterParam('userStatus', value === 'all' ? '' : value)}>
            <SelectTrigger className="w-full sm:w-40" aria-label={t('admin.filterStatus')}>
              <SelectValue placeholder={t('admin.filterStatus')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('admin.filterStatusAll')}</SelectItem>
              <SelectItem value="active">{t('admin.userStatus.active')}</SelectItem>
              <SelectItem value="invited">{t('admin.userStatus.invited')}</SelectItem>
              <SelectItem value="disabled">{t('admin.userStatus.disabled')}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={roleId || 'all'} onValueChange={(value) => setFilterParam('roleId', value === 'all' ? '' : value)}>
            <SelectTrigger className="w-full sm:w-48" aria-label={t('admin.filterRole')}>
              <SelectValue placeholder={t('admin.filterRole')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('admin.filterRoleAll')}</SelectItem>
              {roles.map((role) => (
                <SelectItem key={role.id} value={String(role.id)}>
                  {role.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {listErrorMessage ? (
          <div role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <p>{listErrorMessage}</p>
            {listCorrelationId ? <p className="mt-1 text-xs opacity-80">{t('errors.correlationId', { id: listCorrelationId })}</p> : null}
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void usersQuery.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : null}

        {rowActionError ? (
          <div className="mt-3">
            <InlineErrorAlert message={rowActionError.message} correlationId={rowActionError.correlationId} />
          </div>
        ) : null}

        <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
          <div className="hidden gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:grid md:grid-cols-[1.4fr_0.7fr_1.2fr_0.8fr_1fr_40px]">
            <span>{t('admin.name')}</span>
            <span>{t('admin.identityCode')}</span>
            <span>{t('admin.rolesColumn')}</span>
            <span>{t('admin.status')}</span>
            <span>{t('admin.lastActivity')}</span>
            <span />
          </div>

          {usersQuery.isPending && !usersQuery.data ? (
            <div className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('common.loading')}
            </div>
          ) : null}

          {!usersQuery.isPending && !usersQuery.isError && users.length === 0 ? (
            <p className="px-4 py-8 text-sm text-muted-foreground" role="status">
              {t('admin.usersEmpty')}
            </p>
          ) : null}

          {users.map((rowUser) => {
            const busy = isRowBusy(rowUser.id);
            const roleNames = (rowUser.roles ?? []).map((role) => role.name).join(', ');
            return (
              <div
                key={rowUser.id}
                className="grid grid-cols-1 gap-2 border-b border-border px-4 py-3 text-sm last:border-0 md:grid-cols-[1.4fr_0.7fr_1.2fr_0.8fr_1fr_40px] md:items-center md:py-2.5"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{rowUser.displayName}</div>
                  <div className="truncate text-xs text-muted-foreground">{rowUser.email}</div>
                </div>
                <div className="min-w-0">
                  <span className="md:hidden text-xs font-semibold uppercase text-muted-foreground">{t('admin.identityCode')}</span>
                  <div className="truncate font-mono text-xs">{rowUser.code || '—'}</div>
                </div>
                <div className="min-w-0">
                  <span className="md:hidden text-xs font-semibold uppercase text-muted-foreground">{t('admin.rolesColumn')}</span>
                  <div className="flex flex-wrap gap-1">
                    {(rowUser.roles ?? []).length === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      (rowUser.roles ?? []).map((role) => (
                        <Badge key={role.id} variant="secondary" className="text-[10px]">
                          {role.name}
                        </Badge>
                      ))
                    )}
                  </div>
                  <span className="sr-only">{roleNames}</span>
                </div>
                <div>
                  <span
                    className={cn(
                      'inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs',
                      rowUser.userStatus === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {rowUser.userStatus === 'active' ? (
                      <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <Ban className="h-3 w-3" aria-hidden="true" />
                    )}{' '}
                    {t(`admin.userStatus.${rowUser.userStatus}`, {
                      defaultValue: String(rowUser.userStatus),
                    })}
                    {busy && statusMutation.variables?.userId === rowUser.id ? (
                      <Loader2 className="ml-1 h-3 w-3 animate-spin" aria-hidden="true" />
                    ) : null}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">{formatRelative(rowUser.lastLoginAt)}</span>
                <Popover open={openRowActionsUserId === rowUser.id} onOpenChange={(open) => setOpenRowActionsUserId(open ? rowUser.id : null)}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-50"
                      aria-label={t('common.actions')}
                      disabled={busy}
                      aria-busy={busy}
                    >
                      {busy ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-48 space-y-1 p-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                      disabled={busy}
                      onClick={() => openRolesEditor(rowUser)}
                    >
                      <UserCog className="mr-2 h-4 w-4" aria-hidden="true" />
                      {t('admin.editRoles')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                      disabled={busy}
                      onClick={() => void toggleUserStatus(rowUser)}
                    >
                      <UserCog className="mr-2 h-4 w-4" aria-hidden="true" />
                      {rowUser.userStatus === 'active' ? t('admin.deactivate') : t('admin.activate')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start"
                      disabled={busy}
                      onClick={() => openResetDialog(rowUser)}
                    >
                      <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
                      {t('admin.resetPassword')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start text-destructive hover:text-destructive"
                      disabled={busy}
                      onClick={() => {
                        closeRowActions();
                        removeMutation.reset();
                        setRemoveTarget(rowUser);
                      }}
                    >
                      <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                      {t('admin.removeUser')}
                    </Button>
                  </PopoverContent>
                </Popover>
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <Button type="button" variant="outline" size="sm" disabled={!cursor || usersQuery.isFetching} onClick={goFirstPage}>
            {t('admin.paginationFirst')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasMore || usersQuery.isFetching}
            onClick={goNextPage}
            aria-busy={usersQuery.isFetching && Boolean(cursor)}
          >
            {usersQuery.isFetching && cursor ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {t('admin.paginationNext')}
          </Button>
        </div>
      </div>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('admin.createUserTitle')}</DialogTitle>
            <DialogDescription>{t('admin.createUserDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="admin-create-name">{t('auth.fullName')}</Label>
              <Input
                id="admin-create-name"
                value={createForm.displayName}
                disabled={createBusy}
                onChange={(event) => {
                  createMutation.reset();
                  setCreateForm({ ...createForm, displayName: event.target.value });
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-create-email">{t('admin.email')}</Label>
              <Input
                id="admin-create-email"
                type="email"
                value={createForm.email}
                disabled={createBusy}
                onChange={(event) => {
                  createMutation.reset();
                  setCreateForm({ ...createForm, email: event.target.value });
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-create-code">{t('admin.identityCode')}</Label>
              <Input
                id="admin-create-code"
                value={createForm.code}
                disabled={createBusy}
                onChange={(event) => {
                  createMutation.reset();
                  setCreateForm({ ...createForm, code: event.target.value.toUpperCase() });
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('admin.rolesColumn')}</Label>
              <RoleMultiSelect
                roles={roles}
                selectedRoleIds={createForm.roleIds}
                disabled={createBusy}
                idPrefix="create-role"
                onChange={(roleIds) => {
                  createMutation.reset();
                  setCreateForm({ ...createForm, roleIds });
                }}
              />
            </div>
            <InlineErrorAlert message={createError} correlationId={createCorrelation} />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={createBusy} onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => void submitCreate()}
              disabled={
                createBusy || !createForm.displayName.trim() || !createForm.email.trim() || !createForm.code.trim() || createForm.roleIds.length < 1
              }
              aria-busy={createBusy}
            >
              {createBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {t('admin.inviteUser')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(rolesEditTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setRolesEditTarget(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('admin.editRolesFor', { name: rolesEditTarget?.displayName })}</DialogTitle>
            <DialogDescription>{t('admin.editRolesDescription')}</DialogDescription>
          </DialogHeader>
          <RoleMultiSelect
            roles={roles}
            selectedRoleIds={editRoleIds}
            disabled={rolesEditBusy}
            idPrefix="edit-role"
            onChange={(next) => {
              updateRolesMutation.reset();
              setEditRoleIds(next);
            }}
          />
          <InlineErrorAlert message={rolesEditError} correlationId={rolesEditCorrelation} />
          <DialogFooter>
            <Button variant="outline" disabled={rolesEditBusy} onClick={() => setRolesEditTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void submitRolesEdit()} disabled={rolesEditBusy || editRoleIds.length < 1} aria-busy={rolesEditBusy}>
              {rolesEditBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('admin.removeUserTitle', { name: removeTarget?.displayName })}</DialogTitle>
            <DialogDescription>{t('admin.removeUserConsequences')}</DialogDescription>
          </DialogHeader>
          <InlineErrorAlert message={removeError} correlationId={removeCorrelation} />
          <DialogFooter>
            <Button variant="outline" disabled={removeBusy} onClick={() => setRemoveTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void confirmRemove()} disabled={removeBusy} aria-busy={removeBusy}>
              {removeBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {t('admin.confirmRemove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(resetTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setResetTarget(null);
            setPasswordCompleted(false);
            setNewPassword('');
            setConfirmPassword('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('admin.resetPasswordFor', { name: resetTarget?.displayName })}</DialogTitle>
            <DialogDescription>{t('admin.resetPasswordOutOfBand')}</DialogDescription>
          </DialogHeader>
          {passwordCompleted ? (
            <p role="status" className="text-sm text-foreground">
              {t('admin.passwordResetCompleted')}
            </p>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="admin-new-password">{t('admin.newPassword')}</Label>
                <Input
                  id="admin-new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  disabled={resetBusy}
                  onChange={(event) => {
                    resetMutation.reset();
                    setNewPassword(event.target.value);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="admin-confirm-password">{t('admin.confirmNewPassword')}</Label>
                <Input
                  id="admin-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  disabled={resetBusy}
                  onChange={(event) => {
                    resetMutation.reset();
                    setConfirmPassword(event.target.value);
                  }}
                />
              </div>
              {newPassword && confirmPassword && newPassword !== confirmPassword ? (
                <p role="alert" className="text-sm text-destructive">
                  {t('auth.passwordMismatch')}
                </p>
              ) : null}
              <InlineErrorAlert message={resetError} correlationId={resetCorrelation} />
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={resetBusy}
              onClick={() => {
                setResetTarget(null);
                setPasswordCompleted(false);
              }}
            >
              {passwordCompleted ? t('common.close') : t('common.cancel')}
            </Button>
            {!passwordCompleted ? (
              <Button
                onClick={() => void submitPasswordReset()}
                disabled={resetBusy || !newPassword || !confirmPassword || newPassword !== confirmPassword}
                aria-busy={resetBusy}
              >
                {resetBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {t('admin.setPassword')}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
