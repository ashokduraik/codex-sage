import { Loader2, ShieldCheck } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/features/auth/AuthContext';
import {
  correlationFromError,
  hasPermission,
  messageFromError,
} from '@/features/admin/adminErrors.js';
import { usePermissionsCatalog } from '@/features/admin/api/usePermissionsCatalog.js';
import { useRoles } from '@/features/admin/api/useRoles.js';
import { buildPermissionMatrixRows } from '@/features/admin/permissionMatrix.js';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';

/**
 * Read-only roles and permissions matrix from the real APIs.
 *
 * @returns Admin roles page.
 */
export default function AdminRoles() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  const canManageRoles = hasPermission(currentUser?.permissions, 'roles.manage');

  const rolesQuery = useRoles({ enabled: canManageRoles });
  const catalogQuery = usePermissionsCatalog({ enabled: canManageRoles });

  const roles = useMemo(() => rolesQuery.data ?? [], [rolesQuery.data]);
  const matrixRows = useMemo(
    () =>
      buildPermissionMatrixRows(
        catalogQuery.data,
        roles,
        t('admin.otherPermissionsGroup'),
        t('admin.unknownPermissionLabel'),
      ),
    [catalogQuery.data, roles, t],
  );

  const isLoading = rolesQuery.isPending || catalogQuery.isPending;
  const isError = rolesQuery.isError || catalogQuery.isError;
  const errorMessage = isError
    ? messageFromError(
        rolesQuery.error ?? catalogQuery.error,
        t('errors.unexpected'),
      )
    : '';
  const correlationId = isError
    ? correlationFromError(rolesQuery.error ?? catalogQuery.error)
    : '';

  const gridTemplate = useMemo(() => {
    const roleCount = Math.max(roles.length, 1);
    return `minmax(10rem, 2fr) repeat(${roleCount}, minmax(3.5rem, 1fr))`;
  }, [roles.length]);

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

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-brand" aria-hidden="true" />
          <h1 className="font-display text-xl font-medium">{t('admin.rolesTitle')}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t('admin.rolesSubtitle')}</p>

        {isError ? (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <p>{errorMessage}</p>
            {correlationId ? (
              <p className="mt-1 text-xs opacity-80">
                {t('errors.correlationId', { id: correlationId })}
              </p>
            ) : null}
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
            {/* Mobile: stacked per-role sections (no horizontal scroll). */}
            <div className="mt-5 space-y-4 md:hidden">
              {roles.map((role) => (
                <section
                  key={role.id}
                  className="rounded-lg border border-border bg-card p-4"
                  aria-label={role.name}
                >
                  <h2 className="font-medium">{role.name}</h2>
                  {matrixRows.map((group) => (
                    <div key={`${role.id}-${group.groupId}`} className="mt-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {group.groupLabel}
                      </p>
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
                                className={cn(
                                  'shrink-0 text-xs font-bold',
                                  has ? 'text-brand' : 'text-muted-foreground/40',
                                )}
                                aria-label={
                                  has
                                    ? t('admin.permissionGranted')
                                    : t('admin.permissionDenied')
                                }
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

            {/* Desktop: role columns matrix. */}
            <div className="mt-5 hidden overflow-hidden rounded-lg border border-border bg-card md:block">
              <div
                className="gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                style={{ display: 'grid', gridTemplateColumns: gridTemplate }}
              >
                <span>{t('admin.permission')}</span>
                {roles.map((role) => (
                  <span key={role.id} className="text-center">
                    {role.name}
                  </span>
                ))}
              </div>

              {matrixRows.map((group) => (
                <div key={group.groupId}>
                  <div className="border-b border-border bg-muted/30 px-4 py-2 text-xs font-semibold text-muted-foreground">
                    {group.groupLabel}
                  </div>
                  {group.permissions.map((permission, index) => (
                    <div
                      key={`${group.groupId}-${permission.key}`}
                      className={cn(
                        'items-center gap-2 px-4 py-2.5 text-sm',
                        index % 2 === 1 && 'bg-muted/20',
                      )}
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
                                has
                                  ? 'bg-brand text-brand-foreground'
                                  : 'bg-muted text-muted-foreground/40',
                              )}
                              aria-label={
                                has
                                  ? t('admin.permissionGranted')
                                  : t('admin.permissionDenied')
                              }
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
    </div>
  );
}
