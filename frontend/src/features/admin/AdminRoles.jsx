import { Loader2, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAuth } from '@/features/auth/AuthContext';
import { correlationFromUnknown, messageFromUnknown } from '@/shared/api';
import { usePermissionsCatalog } from '@/features/admin/api/usePermissionsCatalog.js';
import { useCreateRole, useDeleteRole, useUpdateRole } from '@/features/admin/api/useRoleMutations.js';
import { useRoles } from '@/features/admin/api/useRoles.js';
import { InlineErrorAlert } from '@/features/admin/InlineErrorAlert.jsx';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';

/**
 * Builds matrix rows from the catalog plus unknown keys found on roles.
 * @param {{
 *   groups?: Array<{
 *     id: string,
 *     label: string,
 *     permissions: Array<{ key: string, label: string, description?: string }>,
 *   }>,
 * }} catalog Permissions catalog payload.
 * @param {object[]} roles Role DTOs.
 * @param {string} otherGroupLabel Localized "other" group title.
 * @param {string} unknownPermissionLabel Localized generic permission label.
 * @returns {Array<{
 *   groupId: string,
 *   groupLabel: string,
 *   permissions: Array<{ key: string, label: string, description?: string }>,
 * }>}
 */
export function buildPermissionMatrixRows(catalog, roles, otherGroupLabel, unknownPermissionLabel) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  /** @type {Map<string, { key: string, label: string, description?: string }>} */
  const knownByKey = new Map();
  for (const group of groups) {
    for (const permission of group.permissions ?? []) {
      knownByKey.set(permission.key, permission);
    }
  }

  /** @type {Set<string>} */
  const unknownKeys = new Set();
  for (const role of roles) {
    for (const key of role.permissions ?? []) {
      if (typeof key === 'string' && key && !knownByKey.has(key)) {
        unknownKeys.add(key);
      }
    }
  }

  const rows = groups.map((group) => ({
    groupId: group.id,
    groupLabel: group.label,
    permissions: [...(group.permissions ?? [])],
  }));

  if (unknownKeys.size > 0) {
    rows.push({
      groupId: 'other',
      groupLabel: otherGroupLabel,
      permissions: [...unknownKeys].sort().map((key) => ({
        key,
        label: unknownPermissionLabel,
      })),
    });
  }

  return rows;
}

/**
 * Empty create/edit form.
 * @returns {{ code: string, name: string, description: string, permissionKeys: string[] }}
 */
function emptyRoleForm() {
  return { code: '', name: '', description: '', permissionKeys: [] };
}

/**
 * Roles and permissions matrix with create / edit / delete dialogs.
 *
 * @returns Admin roles page.
 */
export default function AdminRoles() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  const canManageRoles = Boolean(currentUser?.permissions?.includes('roles.manage'));

  const rolesQuery = useRoles({ enabled: canManageRoles });
  const catalogQuery = usePermissionsCatalog({ enabled: canManageRoles });
  const createMutation = useCreateRole();
  const updateMutation = useUpdateRole();
  const deleteMutation = useDeleteRole();

  const roles = useMemo(() => rolesQuery.data ?? [], [rolesQuery.data]);
  const matrixRows = useMemo(
    () => buildPermissionMatrixRows(catalogQuery.data, roles, t('admin.otherPermissionsGroup'), t('admin.unknownPermissionLabel')),
    [catalogQuery.data, roles, t],
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [form, setForm] = useState(emptyRoleForm);

  const isLoading = rolesQuery.isPending || catalogQuery.isPending;
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

  const gridTemplate = useMemo(() => {
    const roleCount = Math.max(roles.length, 1);
    return `minmax(10rem, 2fr) repeat(${roleCount}, minmax(4.5rem, 1fr))`;
  }, [roles.length]);

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
        <div className="mx-auto max-w-4xl px-6 py-8">
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
      <div className="mx-auto max-w-4xl px-6 py-8">
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

        {isLoading ? (
          <div className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {t('common.loading')}
          </div>
        ) : null}

        {!isLoading && !isError && roles.length === 0 ? (
          <p className="mt-5 text-sm text-muted-foreground" role="status">
            {t('admin.rolesEmpty')}
          </p>
        ) : null}

        {!isLoading && !isError && roles.length > 0 ? (
          <>
            <div className="mt-5 space-y-4 md:hidden">
              {roles.map((role) => (
                <section key={role.id} className="rounded-lg border border-border bg-card p-4" aria-label={role.name}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h2 className="font-medium">{role.name}</h2>
                      {role.code ? <p className="text-xs text-muted-foreground">{role.code}</p> : null}
                    </div>
                    <div className="flex gap-1">
                      <Button type="button" variant="ghost" size="sm" onClick={() => openEditDialog(role)}>
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                        <span className="sr-only">{t('admin.editRole')}</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
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
                  {matrixRows.map((group) => (
                    <div key={`${role.id}-${group.groupId}`} className="mt-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.groupLabel}</p>
                      <ul className="mt-1 space-y-1">
                        {group.permissions.map((permission) => {
                          const has = (role.permissions ?? []).includes(permission.key);
                          return (
                            <li
                              key={`${role.id}-${permission.key}`}
                              className="flex items-start justify-between gap-2 text-sm"
                              title={permission.description || undefined}
                            >
                              <span>{permission.label}</span>
                              <span
                                className={cn('shrink-0 text-xs font-bold', has ? 'text-brand' : 'text-muted-foreground/40')}
                                aria-label={has ? t('admin.permissionGranted') : t('admin.permissionDenied')}
                              >
                                {has ? '✓' : '—'}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </section>
              ))}
            </div>

            <div className="mt-5 hidden overflow-hidden rounded-lg border border-border bg-card md:block">
              <div
                className="gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                style={{ display: 'grid', gridTemplateColumns: gridTemplate }}
              >
                <span>{t('admin.permission')}</span>
                {roles.map((role) => (
                  <span key={role.id} className="text-center">
                    <span className="block">{role.name}</span>
                    <span className="mt-1 flex justify-center gap-1 normal-case tracking-normal">
                      <Button type="button" variant="ghost" size="sm" className="h-6 px-1" onClick={() => openEditDialog(role)}>
                        <Pencil className="h-3 w-3" aria-hidden="true" />
                        <span className="sr-only">{t('admin.editRole')}</span>
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1"
                        onClick={() => {
                          deleteMutation.reset();
                          setDeleteTarget(role);
                        }}
                      >
                        <Trash2 className="h-3 w-3" aria-hidden="true" />
                        <span className="sr-only">{t('admin.deleteRole')}</span>
                      </Button>
                    </span>
                  </span>
                ))}
              </div>

              {matrixRows.map((group) => (
                <div key={group.groupId}>
                  <div className="border-b border-border bg-muted/30 px-4 py-2 text-xs font-semibold text-muted-foreground">{group.groupLabel}</div>
                  {group.permissions.map((permission, index) => (
                    <div
                      key={`${group.groupId}-${permission.key}`}
                      className={cn('items-center gap-2 px-4 py-2.5 text-sm', index % 2 === 1 && 'bg-muted/20')}
                      style={{ display: 'grid', gridTemplateColumns: gridTemplate }}
                      title={permission.description || undefined}
                    >
                      <span className="text-foreground/90">{permission.label}</span>
                      {roles.map((role) => {
                        const has = (role.permissions ?? []).includes(permission.key);
                        return (
                          <div key={role.id} className="flex justify-center">
                            <span
                              className={cn(
                                'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold',
                                has ? 'bg-brand text-brand-foreground' : 'bg-muted text-muted-foreground/40',
                              )}
                              aria-label={has ? t('admin.permissionGranted') : t('admin.permissionDenied')}
                            >
                              {has ? '✓' : '—'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </>
        ) : null}

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
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
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
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
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
 * }} props Field props.
 */
function RoleFormFields({ form, catalogGroups, disabled, codeEditable, onCodeChange, onNameChange, onDescriptionChange, onTogglePermission }) {
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
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('admin.selectPermissions')}</legend>
        {catalogGroups.map((group) => (
          <div key={group.id}>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</p>
            <ul className="mt-1 space-y-1">
              {(group.permissions ?? []).map((permission) => (
                <li key={permission.key}>
                  <label className="flex items-start gap-2 text-sm" title={permission.description || undefined}>
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={form.permissionKeys.includes(permission.key)}
                      disabled={disabled}
                      onChange={() => onTogglePermission(permission.key)}
                    />
                    <span>{permission.label}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </fieldset>
    </div>
  );
}
