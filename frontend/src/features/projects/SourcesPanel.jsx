import { useState } from 'react';
import { Link, useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';
import { AlertCircle, Check, GitBranch, KeyRound, Loader2, Plus, RefreshCw, Trash2, UploadCloud } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError, correlationFromUnknown, messageFromUnknown } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/shared/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog';
import { formatDateTime } from '@/shared/lib/format';
import { SourceUploadDialog } from './SourceUploadDialog';
import { ConnectRepositoryDialog } from './ConnectRepositoryDialog';
import { flattenSourceVersionPages, useSourceVersions } from './hooks/useSourceVersions.js';
import { useRepositoryConnection } from './hooks/useRepositoryConnection.js';
import { useRepositoryCredentialActions } from './hooks/useRepositoryCredentialActions.js';
import { useReingestSource } from './hooks/useReingestSource.js';

/** @type {Readonly<Record<string, string>>} */
const CONNECTION_STATUS_LABEL_KEYS = Object.freeze({
  connected: 'sources.connectionStatus.connected',
  authentication_required: 'sources.connectionStatus.authenticationRequired',
  access_denied: 'sources.connectionStatus.accessDenied',
  not_found: 'sources.connectionStatus.notFound',
  unreachable: 'sources.connectionStatus.unreachable',
});

/**
 * Label/value row for source metadata.
 *
 * @param {{ label: string, value?: string | null, mono?: boolean }} props Row props.
 * @returns {import('react').ReactElement}
 */
function SourceRow({ label, value, mono }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={`text-right ${mono ? 'font-mono text-xs' : ''}`}>{value ?? '—'}</span>
    </div>
  );
}

/**
 * Sources panel for repository/upload management and version history.
 *
 * @returns {import('react').ReactElement}
 */
export default function SourcesPanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { project } = useOutletContext();
  const projectId = project?.id;
  const versionsQuery = useSourceVersions(projectId);
  const connectionQuery = useRepositoryConnection(projectId);
  const actions = useRepositoryCredentialActions(projectId);
  const reingest = useReingestSource();
  const canReingest = Boolean(user?.permissions?.includes('knowledge.trigger'));
  const versions = flattenSourceVersionPages(versionsQuery.data);
  const connection = connectionQuery.data?.connection ?? null;
  const isRepository = Boolean(connection) || project?.sourceConfig?.sourceType === 'repository';
  const [uploadOpen, setUploadOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [token, setToken] = useState('');
  const excludedCount = project?.counts?.excludedFiles ?? versions[0]?.fileCounts?.excludedFromGraph ?? 0;

  /**
   * Re-tests the live connection.
   */
  async function onRetest() {
    try {
      await actions.retest();
    } catch {
      // Surfaced via retestError.
    }
  }

  /**
   * Replaces the credential and clears the write-only field.
   */
  async function onReplace() {
    try {
      await actions.replace(token.trim());
      setReplaceOpen(false);
      setToken('');
    } catch {
      // Surfaced via replaceError.
    }
  }

  /**
   * Revokes credentials after confirm.
   */
  async function onRevoke() {
    try {
      await actions.revoke();
    } catch {
      // Surfaced via revokeError.
    } finally {
      setRevokeOpen(false);
    }
  }

  /**
   * Starts a reingest job for a stored version and opens processing.
   * @param {string} sourceVersionId Version to rebuild.
   */
  async function onReingest(sourceVersionId) {
    if (!projectId) {
      return;
    }
    try {
      const result = await reingest.mutateAsync({
        projectId,
        sourceVersionId,
        idempotencyKey: crypto.randomUUID(),
      });
      navigate(`/processing?projectId=${encodeURIComponent(projectId)}&jobId=${encodeURIComponent(result.jobId)}`);
    } catch {
      // Surfaced via reingest.error.
    }
  }

  const actionError = actions.retestError || actions.replaceError || actions.revokeError;
  const listError = versionsQuery.error || connectionQuery.error;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="font-display text-xl font-medium">{t('sources.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('sources.panelSubtitle')}</p>
          </div>
          <Button variant="outline" onClick={() => (isRepository ? setConnectOpen(true) : setUploadOpen(true))}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('sources.addSource')}
          </Button>
        </div>

        {versionsQuery.isLoading || connectionQuery.isLoading ? (
          <div className="mt-5 h-32 animate-pulse rounded-xl border border-border bg-muted/40" aria-busy="true">
            <span className="sr-only">{t('common.loading')}</span>
          </div>
        ) : null}

        {listError ? (
          <div role="alert" className="mt-5 text-sm">
            <p>{messageFromUnknown(listError, t('sources.listFailed'))}</p>
            {correlationFromUnknown(listError) ? (
              <p className="mt-1 text-xs text-muted-foreground">{t('errors.correlationId', { id: correlationFromUnknown(listError) })}</p>
            ) : null}
            <Button
              variant="outline"
              className="mt-3"
              onClick={() => {
                void versionsQuery.refetch();
                void connectionQuery.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : null}

        <div className="mt-5 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            {isRepository ? (
              <GitBranch className="h-4 w-4 text-brand" aria-hidden="true" />
            ) : (
              <UploadCloud className="h-4 w-4 text-brand" aria-hidden="true" />
            )}
            <span className="text-sm font-semibold">{t('sources.origin')}</span>
          </div>
          {isRepository ? (
            <div className="mt-3 space-y-2 text-sm">
              <SourceRow label={t('sources.repository')} value={connection?.repository?.fullName} mono />
              <SourceRow label={t('sources.repoUrl')} value={connection?.repository?.webUrl} mono />
              <SourceRow label={t('sources.provider')} value={connection?.provider} />
              <SourceRow label={t('sources.branch')} value={connection?.selectedBranch} mono />
              {connection?.baseUrl ? <SourceRow label={t('sources.instance')} value={connection.baseUrl} mono /> : null}
              {connection?.lastSyncedAt ? <SourceRow label={t('sources.lastSync')} value={formatDateTime(connection.lastSyncedAt)} /> : null}
              <SourceRow
                label={t('sources.credentials')}
                value={t(
                  typeof connection?.connectionStatus === 'string' && connection.connectionStatus.length > 0
                    ? (CONNECTION_STATUS_LABEL_KEYS[connection.connectionStatus] ?? 'sources.connectionStatus.unknown')
                    : 'sources.connectionStatus.unknown',
                )}
              />
            </div>
          ) : (
            <div className="mt-3 space-y-2 text-sm">
              <SourceRow label={t('sources.type')} value={t('sources.upload')} />
              <SourceRow label={t('sources.uploads')} value={String(versions.length)} />
              <SourceRow label={t('sources.lastUpload')} value={versions[0]?.createdAt ? formatDateTime(versions[0].createdAt) : '—'} />
            </div>
          )}

          {isRepository && connection ? (
            <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
              <Button size="sm" variant="outline" onClick={() => void onRetest()} disabled={actions.isRetesting} aria-busy={actions.isRetesting}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('sources.retest')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setReplaceOpen(true)}>
                <KeyRound className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('sources.replaceCredentials')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setRevokeOpen(true)} className="text-destructive hover:text-destructive">
                <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('sources.revoke')}
              </Button>
            </div>
          ) : null}
          {actions.isRetesting ? <p className="mt-2 text-xs text-muted-foreground">{t('sources.testing')}</p> : null}
          {!actions.isRetesting &&
          actions.retestError == null &&
          connection?.connectionStatus === 'connected' &&
          connection?.lastSuccessfulProbeAt ? (
            <p className="mt-2 inline-flex items-center gap-1 text-xs text-emerald-600">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {t('sources.verified')}
            </p>
          ) : null}
          {actionError ? (
            <div role="alert" className="mt-2 text-xs text-red-700">
              {actionError instanceof ApiError && actionError.status === 403
                ? t('errors.forbidden')
                : messageFromUnknown(actionError, t('sources.actionFailed'))}
            </div>
          ) : null}
        </div>

        <div className="mt-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {isRepository ? t('sources.syncHistory') : t('sources.uploadHistory')}
          </h2>
          {reingest.error ? (
            <div role="alert" className="mt-2 text-sm text-red-700">
              {reingest.error instanceof ApiError && reingest.error.status === 403
                ? t('errors.forbidden')
                : messageFromUnknown(reingest.error, t('sources.reprocessFailed'))}
            </div>
          ) : null}
          <div className="mt-2 divide-y divide-border rounded-lg border border-border bg-card">
            {versions.length === 0 ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">{t('sources.emptyHistory')}</div>
            ) : (
              versions.map((version) => (
                <div key={version.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-sm font-medium">
                      {version.origin === 'repository' ? version.branch || t('sources.repository') : t('sources.upload')}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t('sources.versionMeta', {
                        accepted: version.fileCounts?.accepted ?? 0,
                        skipped: version.fileCounts?.skipped ?? 0,
                        when: version.createdAt ? formatDateTime(version.createdAt) : '—',
                      })}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {canReingest ? (
                      <Button
                        size="sm"
                        variant="outline"
                        title={t('sources.reprocessHint')}
                        disabled={reingest.isPending}
                        aria-busy={reingest.isPending}
                        onClick={() => void onReingest(version.id)}
                      >
                        {t('sources.reprocessVersion')}
                      </Button>
                    ) : null}
                    {version.jobId ? (
                      <Link to={`/processing?projectId=${encodeURIComponent(projectId)}`} className="text-xs font-medium text-brand hover:underline">
                        {t('sources.viewJob')}
                      </Link>
                    ) : (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{version.versionLifecycle}</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {excludedCount > 0 ? (
          <div className="mt-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">{t('sources.excludedTitle', { count: excludedCount })}</p>
              <p className="text-xs">{t('sources.excludedBody')}</p>
            </div>
          </div>
        ) : null}
      </div>

      <Dialog
        open={replaceOpen}
        onOpenChange={(open) => {
          setReplaceOpen(open);
          if (!open) {
            setToken('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-brand" aria-hidden="true" />
              {t('sources.replaceCredentials')}
            </DialogTitle>
            <DialogDescription>{t('sources.replaceCredentialsDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="new-token">{t('sources.newToken')}</Label>
            <Input
              id="new-token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={t('sources.newTokenPlaceholder')}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">{t('sources.tokenWriteOnly')}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplaceOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void onReplace()} disabled={!token.trim() || actions.isReplacing} aria-busy={actions.isReplacing}>
              {actions.isReplacing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              {t('sources.saveToken')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sources.revokeConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('sources.revokeConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onRevoke()} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t('sources.revokeAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SourceUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} projectId={projectId} />
      <ConnectRepositoryDialog open={connectOpen} onOpenChange={setConnectOpen} projectId={projectId} />
    </div>
  );
}
