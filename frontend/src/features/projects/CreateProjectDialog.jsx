import { useState } from 'react';
import { FolderKanban, GitBranch, UploadCloud, ArrowRight, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Textarea } from '@/shared/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/shared/ui/dialog';
import { cn } from '@/shared/lib/utils';
import { ConnectRepositoryDialog } from './ConnectRepositoryDialog';
import { SourceUploadDialog } from './SourceUploadDialog';
import { useCreateProject } from './hooks/useProjectMutations.js';
import { correlationFromUnknown, messageFromUnknown, retryAfterFromUnknown } from '@/shared/api';

/**
 * Dialog to create a project and continue into repo connect or upload.
 *
 * @param {{ open: boolean, onOpenChange: (open: boolean) => void }} props Dialog open state.
 * @returns Create project dialog
 */
export function CreateProjectDialog({ open, onOpenChange }) {
  const { t } = useTranslation();
  const createMutation = useCreateProject();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [path, setPath] = useState(/** @type {'upload' | 'repo' | null} */ (null));
  const [newProjectId, setNewProjectId] = useState(/** @type {string | null} */ (null));
  const [subDialog, setSubDialog] = useState(/** @type {'repo' | 'upload' | null} */ (null));

  /**
   * Reset local form state.
   */
  const reset = () => {
    setName('');
    setDescription('');
    setPath(null);
    setNewProjectId(null);
    setSubDialog(null);
    createMutation.reset();
  };

  /**
   * Create the project and open the follow-up source dialog.
   */
  const handleCreate = () => {
    if (!path || !name.trim() || createMutation.isPending) {
      return;
    }
    createMutation.mutate(
      {
        name: name.trim(),
        description: description.trim() || undefined,
        sourceType: path === 'repo' ? 'repository' : 'upload',
        idempotencyKey: crypto.randomUUID(),
      },
      {
        onSuccess: (project) => {
          setNewProjectId(project.id);
          setSubDialog(path === 'repo' ? 'repo' : 'upload');
        },
      },
    );
  };

  const errorMessage = createMutation.isError ? messageFromUnknown(createMutation.error, t('projects.listFailed')) : '';
  const correlationId = correlationFromUnknown(createMutation.error);
  const retryAfter = retryAfterFromUnknown(createMutation.error);
  const pending = createMutation.isPending;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          onOpenChange(nextOpen);
          if (!nextOpen) {
            reset();
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderKanban className="h-4 w-4 text-brand" aria-hidden="true" />
              {t('projects.createTitle')}
            </DialogTitle>
            <DialogDescription>{t('projects.createDescription')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pname">{t('projects.name')}</Label>
              <Input
                id="pname"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (createMutation.isError) {
                    createMutation.reset();
                  }
                }}
                placeholder={t('projects.namePlaceholder')}
                autoFocus
                disabled={pending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pdesc">
                {t('projects.description')} <span className="font-normal text-muted-foreground">({t('common.optional')})</span>
              </Label>
              <Textarea
                id="pdesc"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={2}
                placeholder={t('projects.descriptionPlaceholder')}
                disabled={pending}
              />
            </div>

            <div>
              <Label>{t('projects.sourceType')}</Label>
              <div className="mt-1.5 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setPath('upload')}
                  className={cn(
                    'flex flex-col items-start gap-1.5 rounded-xl border p-4 text-left transition-colors',
                    path === 'upload' ? 'border-brand bg-brand-muted/40 ring-1 ring-brand' : 'border-border hover:bg-muted',
                  )}
                >
                  <UploadCloud className={cn('h-5 w-5', path === 'upload' ? 'text-brand' : 'text-muted-foreground')} aria-hidden="true" />
                  <span className="text-sm font-medium">{t('projects.sourceUpload')}</span>
                  <span className="text-xs text-muted-foreground">{t('projects.sourceUploadHint')}</span>
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setPath('repo')}
                  className={cn(
                    'flex flex-col items-start gap-1.5 rounded-xl border p-4 text-left transition-colors',
                    path === 'repo' ? 'border-brand bg-brand-muted/40 ring-1 ring-brand' : 'border-border hover:bg-muted',
                  )}
                >
                  <GitBranch className={cn('h-5 w-5', path === 'repo' ? 'text-brand' : 'text-muted-foreground')} aria-hidden="true" />
                  <span className="text-sm font-medium">{t('projects.sourceRepo')}</span>
                  <span className="text-xs text-muted-foreground">{t('projects.sourceRepoHint')}</span>
                </button>
              </div>
            </div>

            {createMutation.isError ? (
              <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                <p>{errorMessage}</p>
                {typeof retryAfter === 'number' ? (
                  <p className="mt-1 text-muted-foreground">{t('projects.retryAfter', { seconds: retryAfter })}</p>
                ) : null}
                {correlationId ? (
                  <p className="mt-1 text-xs text-muted-foreground">{t('projects.correlationReference', { reference: correlationId })}</p>
                ) : null}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                onOpenChange(false);
                reset();
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={!name.trim() || !path || pending} aria-busy={pending}>
              {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {pending
                ? t('projects.createPending')
                : path === 'repo'
                  ? t('projects.continueConnect')
                  : path === 'upload'
                    ? t('projects.continueUpload')
                    : t('common.next')}
              {!pending ? <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" /> : null}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {newProjectId ? (
        <>
          <ConnectRepositoryDialog
            open={subDialog === 'repo'}
            onOpenChange={(nextOpen) => setSubDialog(nextOpen ? 'repo' : null)}
            projectId={newProjectId}
            onConnected={() => onOpenChange(false)}
          />
          <SourceUploadDialog
            open={subDialog === 'upload'}
            onOpenChange={(nextOpen) => setSubDialog(nextOpen ? 'upload' : null)}
            projectId={newProjectId}
            onUploaded={() => onOpenChange(false)}
          />
        </>
      ) : null}
    </>
  );
}

export default CreateProjectDialog;
