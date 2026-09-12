import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { GitBranch, UploadCloud, Plus, RefreshCw, KeyRound, Trash2, AlertCircle, Check, } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, } from '@/shared/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, } from '@/shared/ui/alert-dialog';
import { formatDateTime } from '@/shared/lib/format';
import { useAppData } from '@/shared/mock-data';
import { SourceUploadDialog } from './SourceUploadDialog';
import { ConnectRepositoryDialog } from './ConnectRepositoryDialog';
/**
 * Label/value row for source metadata.
 *
 * @param props - Row props
 * @returns Row UI
 */
function SourceRow({ label, value, mono }) {
    return (<div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={`text-right ${mono ? 'font-mono text-xs' : ''}`}>
        {value ?? '—'}
      </span>
    </div>);
}
/**
 * Sources panel for repository/upload management and credentials.
 *
 * @returns Sources panel
 */
export default function SourcesPanel() {
    const { t } = useTranslation();
    const { project: apiProject, mockProject } = useOutletContext();
    const project = mockProject ?? apiProject;
    const { updateProject, logAudit } = useAppData();
    const source = (project.source || { type: 'upload', origin: 'Upload' });
    const repoLabel = source.type === 'repo' ? source.fullName || project.name : project.name;
    const [uploadOpen, setUploadOpen] = useState(false);
    const [connectOpen, setConnectOpen] = useState(false);
    const [replaceOpen, setReplaceOpen] = useState(false);
    const [revokeOpen, setRevokeOpen] = useState(false);
    const [token, setToken] = useState('');
    const [testState, setTestState] = useState(null);
    /**
     * Simulate a connection re-test and write an audit entry.
     */
    const retest = async () => {
        setTestState('testing');
        await new Promise((resolve) => setTimeout(resolve, 900));
        setTestState('ok');
        logAudit('Re-tested connection', repoLabel);
    };
    /**
     * Save a replacement token (write-only) and close the dialog.
     */
    const replaceToken = () => {
        setReplaceOpen(false);
        setToken('');
        logAudit('Replaced repository credentials', repoLabel);
    };
    /**
     * Revoke repository credentials on the project source.
     */
    const revoke = () => {
        setRevokeOpen(false);
        const nextSource = {
            ...source,
            hasCredentials: false,
        };
        updateProject(project.id, {
            source: nextSource,
        });
        logAudit('Revoked repository credentials', repoLabel);
    };
    return (<div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-xl font-medium">
              {t('sources.title')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t('sources.panelSubtitle')}
            </p>
          </div>
          <Button variant="outline" onClick={() => source.type === 'repo' ? setConnectOpen(true) : setUploadOpen(true)}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true"/>
            {t('sources.addSource')}
          </Button>
        </div>

        <div className="mt-5 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            {source.type === 'repo' ? (<GitBranch className="h-4 w-4 text-brand" aria-hidden="true"/>) : (<UploadCloud className="h-4 w-4 text-brand" aria-hidden="true"/>)}
            <span className="text-sm font-semibold">{t('sources.origin')}</span>
          </div>
          {source.type === 'repo' ? (<div className="mt-3 space-y-2 text-sm">
              <SourceRow label={t('sources.repository')} value={source.fullName} mono/>
              <SourceRow label={t('sources.repoUrl')} value={source.repoUrl} mono/>
              <SourceRow label={t('sources.provider')} value={source.origin}/>
              <SourceRow label={t('sources.branch')} value={source.branch} mono/>
              {source.baseUrl && (<SourceRow label={t('sources.instance')} value={source.baseUrl} mono/>)}
              <SourceRow label={t('sources.lastSync')} value={formatDateTime(source.lastSync)}/>
              <SourceRow label={t('sources.credentials')} value={source.hasCredentials === false
                ? t('sources.credentialsMissing')
                : t('sources.credentialsConnected')}/>
            </div>) : (<div className="mt-3 space-y-2 text-sm">
              <SourceRow label={t('sources.type')} value={t('sources.upload')}/>
              <SourceRow label={t('sources.uploads')} value={`${source.uploads?.length || 0}`}/>
              <SourceRow label={t('sources.lastUpload')} value={formatDateTime(source.uploads?.[source.uploads.length - 1]?.uploadedAt)}/>
            </div>)}

          {source.type === 'repo' && (<div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
              <Button size="sm" variant="outline" onClick={() => void retest()}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true"/>
                {t('sources.retest')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setReplaceOpen(true)}>
                <KeyRound className="mr-1.5 h-3.5 w-3.5" aria-hidden="true"/>
                {t('sources.replaceCredentials')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setRevokeOpen(true)} className="text-destructive hover:text-destructive">
                <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true"/>
                {t('sources.revoke')}
              </Button>
            </div>)}
          {testState === 'testing' && (<p className="mt-2 text-xs text-muted-foreground">
              {t('sources.testing')}
            </p>)}
          {testState === 'ok' && (<p className="mt-2 inline-flex items-center gap-1 text-xs text-emerald-600">
              <Check className="h-3.5 w-3.5" aria-hidden="true"/>
              {t('sources.verified')}
            </p>)}
        </div>

        <div className="mt-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {source.type === 'repo'
            ? t('sources.syncHistory')
            : t('sources.uploadHistory')}
          </h2>
          <div className="mt-2 divide-y divide-border rounded-lg border border-border bg-card">
            {(source.uploads || []).length === 0 && source.type === 'repo' && (<div className="px-4 py-3 text-sm text-muted-foreground">
                {t('sources.repoSyncedAt', {
                when: formatDateTime(source.lastSync),
            })}
              </div>)}
            {(source.uploads || []).map((upload) => (<div key={`${upload.name}-${upload.uploadedAt}`} className="flex items-center justify-between px-4 py-3">
                <div>
                  <div className="text-sm font-medium">{upload.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('sources.uploadMeta', {
                files: upload.files,
                size: upload.size,
                when: formatDateTime(upload.uploadedAt),
            })}
                  </div>
                </div>
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                  {upload.status}
                </span>
              </div>))}
          </div>
        </div>

        {project.excludedCount > 0 && (<div className="mt-5 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true"/>
            <div>
              <p className="font-medium">
                {t('sources.excludedTitle', { count: project.excludedCount })}
              </p>
              <p className="text-xs">{t('sources.excludedBody')}</p>
            </div>
          </div>)}
      </div>

      <Dialog open={replaceOpen} onOpenChange={setReplaceOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-brand" aria-hidden="true"/>
              {t('sources.replaceCredentials')}
            </DialogTitle>
            <DialogDescription>
              {t('sources.replaceCredentialsDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="new-token">{t('sources.newToken')}</Label>
            <Input id="new-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={t('sources.newTokenPlaceholder')} autoFocus/>
            <p className="text-xs text-muted-foreground">
              {t('sources.tokenWriteOnly')}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplaceOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={replaceToken} disabled={!token.trim()}>
              {t('sources.saveToken')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('sources.revokeConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('sources.revokeConfirmBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={revoke} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t('sources.revokeAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SourceUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} projectId={project.id}/>
      <ConnectRepositoryDialog open={connectOpen} onOpenChange={setConnectOpen} projectId={project.id}/>
    </div>);
}
