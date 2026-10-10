import { Loader2, Pencil, Plus, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '@/features/auth/AuthContext';
import { correlationFromUnknown, messageFromUnknown } from '@/shared/api';
import { usePermissionsCatalog } from '@/features/admin/api/usePermissionsCatalog.js';
import { useCreateRole, useDeleteRole, useUpdateRole } from '@/features/admin/api/useRoleMutations.js';
import { useRolesPage } from '@/features/admin/api/useRoles.js';
import { InlineErrorAlert } from '@/features/admin/InlineErrorAlert.jsx';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';

/** Debounce delay before search text reaches the query key. */
const ROLE_SEARCH_DEBOUNCE_MS = 300;

/** Desktop summary grid: S.No, code, name, description, permission count, actions. */
const ROLE_SUMMARY_GRID = 'md:grid-cols-[3.5rem_7rem_1.2fr_1.4fr_8rem_4.5rem]';

/**
 * Empty create/edit form.
 * @returns {{ code: string, name: string, description: string, permissionKeys: string[] }}
 */
function emptyRoleForm() {
  return { code: '', name: '', description: '', permissionKeys: [] };
}

/**
 * Roles summary: search, paginated table, and create / edit / delete dialogs.
 *
 * @returns Admin roles page.
 */
export default function AdminRoles() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const canManageRoles = Boolean(currentUser?.permissions?.includes('roles.manage'));

  const urlQ = searchParams.get('q') ?? '';
  const cursor = searchParams.get('cursor') ?? '';
  const serialOffset = parseSerialOffset(searchParams.get('offset') ?? '0');

  const [searchDraft, setSearchDraft] = useState(() => searchParams.get('q') ?? '');
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [form, setForm] = useState(emptyRoleForm);

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
      params.delete('offset');
      setSearchParams(params, { replace: true });
    }, ROLE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchDraft, urlQ, searchParams, setSearchParams]);

  const rolesQuery = useRolesPage({
    q: urlQ || undefined,
    cursor: cursor || undefined,
    enabled: canManageRoles,
  });
  const catalogQuery = usePermissionsCatalog({ enabled: canManageRoles });
  const createMutation = useCreateRole();
  const updateMutation = useUpdateRole();
  const deleteMutation = useDeleteRole();

  const roles = rolesQuery.data?.items ?? [];
  const nextCursor = rolesQuery.data?.pageInfo?.nextCursor ?? null;
  const hasMore = Boolean(rolesQuery.data?.pageInfo?.hasMore && nextCursor);

  const isError = rolesQuery.isError || catalogQuery.isError;
  const errorMessage = isError ? messageFromUnknown(rolesQuery.error ?? catalogQuery.error, t('errors.unexpected')) : '';
  const correlationId = isError ? correlationFromUnknown(rolesQuery.error ?? catalogQuery.error) : '';

  const createBusy = createMutation.isPending;
  const editBusy = updateMutation.isPending;
  const deleteBusy = deleteMutation.isPending;
  const formError = createOpen
    ? createMutation.isError
      ? messageFromUnknown(createMutation.error, t('errors.unexpected'))
      : ''
    : editTarget
      ? updateMutation.isError
        ? messageFromUnknown(updateMutation.error, t('errors.unexpected'))
        : ''
      : '';
  const formCorrelation = createOpen ? correlationFromUnknown(createMutation.error) : editTarget ? correlationFromUnknown(updateMutation.error) : '';
  const deleteError = deleteMutation.isError ? messageFromUnknown(deleteMutation.error, t('errors.unexpected')) : '';
  const deleteCorrelation = deleteMutation.isError ? correlationFromUnknown(deleteMutation.error) : '';

  /**
   * Advances to the next keyset page and keeps S.No continuous.
   */
  function goNextPage() {
    if (!nextCursor) {
      return;
    }
    const params = new URLSearchParams(searchParams);
    params.set('cursor', nextCursor);
    params.set('offset', String(serialOffset + roles.length));
    setSearchParams(params, { replace: true });
  }

  /**
   * Returns to the first page (clears cursor and serial offset).
   */
  function goFirstPage() {
    const params = new URLSearchParams(searchParams);
    params.delete('cursor');
    params.delete('offset');
    setSearchParams(params, { replace: true });
  }

  /**
   * Opens the create dialog.
   */
  function openCreateDialog() {
    createMutation.reset();
    setForm(emptyRoleForm());
    setCreateOpen(true);
  }

  /**
   * Opens the edit dialog for one role.
   * @param {object} role Role DTO.
   */
  function openEditDialog(role) {
    updateMutation.reset();
    setEditTarget(role);
    setForm({
      code: role.code ?? '',
      name: role.name ?? '',
      description: role.description ?? '',
      permissionKeys: [...(role.permissions ?? [])],
    });
  }

  /**
   * Toggles one catalog key in the form.
   * @param {string} key Permission key.
   */
  function togglePermission(key) {
    setForm((current) => {
      const has = current.permissionKeys.includes(key);
      return {
        ...current,
        permissionKeys: has ? current.permissionKeys.filter((item) => item !== key) : [...current.permissionKeys, key],
      };
    });
  }

  /**
   * Grants or clears every key in one catalog group.
   * @param {string[]} groupKeys Catalog keys in the group.
   * @param {boolean} granted Whether those keys should be selected.
   */
  function setGroupPermissions(groupKeys, granted) {
    setForm((current) => {
      const next = new Set(current.permissionKeys);
      for (const key of groupKeys) {
        if (granted) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return { ...current, permissionKeys: [...next] };
    });
  }

  /**
   * Submits create-role.
   */
  async function submitCreate() {
    if (!form.code.trim() || !form.name.trim() || form.permissionKeys.length < 1) {
      return;
    }
    try {
      await createMutation.mutateAsync({
        code: form.code.trim().toUpperCase(),
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        permissions: form.permissionKeys,
      });
      setCreateOpen(false);
      toast.success(t('admin.roleCreated'));
    } catch {
      // Inline alert.
    }
  }

  /**
   * Submits edit-role.
   */
  async function submitEdit() {
    if (!editTarget || !form.name.trim() || form.permissionKeys.length < 1) {
      return;
    }
    try {
      await updateMutation.mutateAsync({
        roleId: editTarget.id,
        name: form.name.trim(),
        description: form.description.trim(),
        permissions: form.permissionKeys,
      });
      setEditTarget(null);
      toast.success(t('admin.roleUpdated'));
    } catch {
      // Inline alert.
    }
  }

  /**
   * Confirms soft-delete.
   */
  async function submitDelete() {
    if (!deleteTarget) {
      return;
    }
    try {
      await deleteMutation.mutateAsync({ roleId: deleteTarget.id });
      setDeleteTarget(null);
      toast.success(t('admin.roleDeleted'));
    } catch {
      // Inline alert.
    }
  }

  if (!canManageRoles) {
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

  const catalogGroups = Array.isArray(catalogQuery.data?.groups) ? catalogQuery.data.groups : [];

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-brand" aria-hidden="true" />
              <h1 className="font-display text-xl font-medium">{t('admin.rolesTitle')}</h1>
            </div>
            <p className="text-sm text-muted-foreground">{t('admin.rolesSubtitle')}</p>
          </div>
          <Button onClick={openCreateDialog} className="bg-brand text-brand-foreground hover:bg-brand/90">
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('admin.createRole')}
          </Button>
        </div>

        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder={t('admin.searchRoles')}
              className="pl-8"
              aria-label={t('admin.searchRoles')}
            />
          </div>
        </div>

        {isError ? (
          <div role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <p>{errorMessage}</p>
            {correlationId ? <p className="mt-1 text-xs opacity-80">{t('errors.correlationId', { id: correlationId })}</p> : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                void rolesQuery.refetch();
                void catalogQuery.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : null}

        <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
          <div
            className={`hidden gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:grid ${ROLE_SUMMARY_GRID}`}
          >
            <span>{t('admin.serialNumber')}</span>
            <span>{t('admin.identityCode')}</span>
            <span>{t('admin.name')}</span>
            <span>{t('admin.roleDescription')}</span>
            <span>{t('admin.selectPermissions')}</span>
            <span />
          </div>

          {rolesQuery.isPending && !rolesQuery.data ? (
            <div className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('common.loading')}
            </div>
          ) : null}

          {!rolesQuery.isPending && !rolesQuery.isError && roles.length === 0 ? (
            <p className="px-4 py-8 text-sm text-muted-foreground" role="status">
              {t('admin.rolesEmpty')}
            </p>
          ) : null}

          {roles.map((role, index) => {
            const permissionCount = Array.isArray(role.permissions) ? role.permissions.length : 0;
            return (
              <div
                key={role.id}
                className={`grid grid-cols-1 gap-2 border-b border-border px-4 py-3 text-sm last:border-0 md:items-center md:py-2.5 md:grid ${ROLE_SUMMARY_GRID}`}
                aria-label={role.name}
              >
                <div>
                  <span className="md:hidden text-xs font-semibold uppercase text-muted-foreground">{t('admin.serialNumber')}</span>
                  <div className="tabular-nums text-muted-foreground">{serialOffset + index + 1}</div>
                </div>
                <div className="min-w-0">
                  <span className="md:hidden text-xs font-semibold uppercase text-muted-foreground">{t('admin.identityCode')}</span>
                  <div className="truncate font-mono text-xs">{role.code || '—'}</div>
                </div>
                <div className="min-w-0">
                  <span className="md:hidden text-xs font-semibold uppercase text-muted-foreground">{t('admin.name')}</span>
                  <div className="truncate font-medium">{role.name}</div>
                </div>
                <div className="min-w-0">
                  <span className="md:hidden text-xs font-semibold uppercase text-muted-foreground">{t('admin.roleDescription')}</span>
                  <div className="truncate text-muted-foreground">{role.description?.trim() ? role.description : '—'}</div>
                </div>
                <div>
                  <span className="md:hidden text-xs font-semibold uppercase text-muted-foreground">{t('admin.selectPermissions')}</span>
                  <div className="text-xs text-muted-foreground">{t('admin.permissionsCount', { count: permissionCount })}</div>
                </div>
                <div className="flex gap-1 md:justify-end">
                  <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => openEditDialog(role)}>
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                    <span className="sr-only">{t('admin.editRole')}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => {
                      deleteMutation.reset();
                      setDeleteTarget(role);
                    }}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    <span className="sr-only">{t('admin.deleteRole')}</span>
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <Button type="button" variant="outline" size="sm" disabled={!cursor || rolesQuery.isFetching} onClick={goFirstPage}>
            {t('admin.paginationFirst')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasMore || rolesQuery.isFetching}
            onClick={goNextPage}
            aria-busy={rolesQuery.isFetching && Boolean(cursor)}
          >
            {rolesQuery.isFetching && cursor ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {t('admin.paginationNext')}
          </Button>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">{t('admin.rolesFooter')}</p>
      </div>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('admin.createRoleTitle')}</DialogTitle>
            <DialogDescription>{t('admin.createRoleDescription')}</DialogDescription>
          </DialogHeader>
          <RoleFormFields
            form={form}
            catalogGroups={catalogGroups}
            disabled={createBusy}
            codeEditable
            onCodeChange={(code) => {
              createMutation.reset();
              setForm((current) => ({ ...current, code }));
            }}
            onNameChange={(name) => {
              createMutation.reset();
              setForm((current) => ({ ...current, name }));
            }}
            onDescriptionChange={(description) => {
              createMutation.reset();
              setForm((current) => ({ ...current, description }));
            }}
            onTogglePermission={(key) => {
              createMutation.reset();
              togglePermission(key);
            }}
            onSetGroupPermissions={(groupKeys, granted) => {
              createMutation.reset();
              setGroupPermissions(groupKeys, granted);
            }}
          />
          <InlineErrorAlert message={formError} correlationId={formCorrelation} />
          <DialogFooter>
            <Button variant="outline" disabled={createBusy} onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => void submitCreate()}
              disabled={createBusy || !form.code.trim() || !form.name.trim() || form.permissionKeys.length < 1}
              aria-busy={createBusy}
            >
              {createBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {t('admin.createRole')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(editTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setEditTarget(null);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editTarget ? t('admin.editRoleFor', { name: editTarget.name }) : t('admin.editRole')}</DialogTitle>
            <DialogDescription>{t('admin.editRoleDescription')}</DialogDescription>
          </DialogHeader>
          <RoleFormFields
            form={form}
            catalogGroups={catalogGroups}
            disabled={editBusy}
            codeEditable={false}
            onCodeChange={() => {}}
            onNameChange={(name) => {
              updateMutation.reset();
              setForm((current) => ({ ...current, name }));
            }}
            onDescriptionChange={(description) => {
              updateMutation.reset();
              setForm((current) => ({ ...current, description }));
            }}
            onTogglePermission={(key) => {
              updateMutation.reset();
              togglePermission(key);
            }}
            onSetGroupPermissions={(groupKeys, granted) => {
              updateMutation.reset();
              setGroupPermissions(groupKeys, granted);
            }}
          />
          <InlineErrorAlert message={formError} correlationId={formCorrelation} />
          <DialogFooter>
            <Button variant="outline" disabled={editBusy} onClick={() => setEditTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void submitEdit()} disabled={editBusy || !form.name.trim() || form.permissionKeys.length < 1} aria-busy={editBusy}>
              {editBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{deleteTarget ? t('admin.deleteRoleTitle', { name: deleteTarget.name }) : t('admin.deleteRole')}</DialogTitle>
            <DialogDescription>{t('admin.deleteRoleDescription')}</DialogDescription>
          </DialogHeader>
          <InlineErrorAlert message={deleteError} correlationId={deleteCorrelation} />
          <DialogFooter>
            <Button variant="outline" disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void submitDelete()} disabled={deleteBusy} aria-busy={deleteBusy}>
              {deleteBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {t('admin.deleteRole')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

  /**
   * Parses a non-negative serial offset from the URL.
   * @param {string} raw Raw query value.
   * @returns {number}
   */
  function parseSerialOffset(raw) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 0;
    }
    return parsed;
  }
}

/**
 * Shared create/edit fields: code, name, description, catalog checkboxes.
 * @param {{
 *   form: { code: string, name: string, description: string, permissionKeys: string[] },
 *   catalogGroups: Array<{ id: string, label: string, permissions: Array<{ key: string, label: string, description?: string }> }>,
 *   disabled: boolean,
 *   codeEditable: boolean,
 *   onCodeChange: (value: string) => void,
 *   onNameChange: (value: string) => void,
 *   onDescriptionChange: (value: string) => void,
 *   onTogglePermission: (key: string) => void,
 *   onSetGroupPermissions: (groupKeys: string[], granted: boolean) => void,
 * }} props Field props.
 */
function RoleFormFields({
  form,
  catalogGroups,
  disabled,
  codeEditable,
  onCodeChange,
  onNameChange,
  onDescriptionChange,
  onTogglePermission,
  onSetGroupPermissions,
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="admin-role-code">{t('admin.identityCode')}</Label>
        <Input
          id="admin-role-code"
          value={form.code}
          disabled={disabled || !codeEditable}
          readOnly={!codeEditable}
          onChange={(event) => onCodeChange(event.target.value.toUpperCase())}
        />
        {!codeEditable ? <p className="text-xs text-muted-foreground">{t('admin.roleCodeReadOnly')}</p> : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="admin-role-name">{t('admin.roleName')}</Label>
        <Input id="admin-role-name" value={form.name} disabled={disabled} onChange={(event) => onNameChange(event.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="admin-role-description">{t('admin.roleDescription')}</Label>
        <Input
          id="admin-role-description"
          value={form.description}
          disabled={disabled}
          onChange={(event) => onDescriptionChange(event.target.value)}
        />
      </div>
      <PermissionCatalogPicker
        catalogGroups={catalogGroups}
        selectedKeys={form.permissionKeys}
        disabled={disabled}
        onTogglePermission={onTogglePermission}
        onSetGroupPermissions={onSetGroupPermissions}
      />
    </div>
  );
}

/**
 * Catalog permission picker styled like the former roles matrix.
 * Labels only — catalog keys never appear as primary UI.
 * @param {{
 *   catalogGroups: Array<{ id: string, label: string, permissions: Array<{ key: string, label: string, description?: string }> }>,
 *   selectedKeys: string[],
 *   disabled: boolean,
 *   onTogglePermission: (key: string) => void,
 *   onSetGroupPermissions: (groupKeys: string[], granted: boolean) => void,
 * }} props Picker props.
 */
function PermissionCatalogPicker({ catalogGroups, selectedKeys, disabled, onTogglePermission, onSetGroupPermissions }) {
  const { t } = useTranslation();
  const selectedSet = new Set(selectedKeys);
  const totalCount = catalogGroups.reduce((sum, group) => sum + (group.permissions ?? []).length, 0);
  const selectedCount = selectedKeys.length;

  return (
    <fieldset className="space-y-3">
      <legend className="sr-only">{t('admin.selectPermissions')}</legend>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium">{t('admin.selectPermissions')}</p>
        <p className="text-xs text-muted-foreground">{t('admin.permissionsSelected', { selected: selectedCount, total: totalCount })}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {catalogGroups.map((group) => {
          const groupKeys = (group.permissions ?? []).map((permission) => permission.key);
          const groupSelected = groupKeys.filter((key) => selectedSet.has(key)).length;
          const groupTotal = groupKeys.length;
          const allGranted = groupTotal > 0 && groupSelected === groupTotal;
          return (
            <section key={group.id} className="overflow-hidden rounded-lg border border-border bg-card">
              <header className="flex items-center justify-between gap-2 border-b border-border bg-muted/50 px-3 py-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-foreground">{group.label}</h3>
                  <p className="text-xs text-muted-foreground">{t('admin.permissionsSelected', { selected: groupSelected, total: groupTotal })}</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  disabled={disabled || groupTotal === 0}
                  onClick={() => onSetGroupPermissions(groupKeys, !allGranted)}
                >
                  {allGranted ? t('admin.clearGroup') : t('admin.selectAllInGroup')}
                </Button>
              </header>
              <div>
                {(group.permissions ?? []).map((permission, index) => {
                  const granted = selectedSet.has(permission.key);
                  return (
                    <label
                      key={permission.key}
                      title={permission.description || undefined}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 px-3 py-2.5',
                        index < (group.permissions ?? []).length - 1 && 'border-b border-border/70',
                        index % 2 === 1 && 'bg-muted/15',
                        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted/40',
                      )}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={granted}
                        disabled={disabled}
                        aria-label={permission.label}
                        onChange={() => onTogglePermission(permission.key)}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm text-foreground/90">{permission.label}</span>
                        {permission.description ? <span className="mt-0.5 block text-xs text-muted-foreground">{permission.description}</span> : null}
                      </span>
                      <span
                        className={cn(
                          'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
                          granted ? 'bg-brand text-brand-foreground' : 'bg-muted text-muted-foreground/40',
                        )}
                        aria-hidden="true"
                      >
                        {granted ? '✓' : '—'}
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </fieldset>
  );
}
