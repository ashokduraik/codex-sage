import { useState } from 'react';
import { FolderKanban, GitBranch, UploadCloud, ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Textarea } from '@/shared/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, } from '@/shared/ui/dialog';
import { cn } from '@/shared/lib/utils';
import { useAppData } from '@/shared/mock-data';
import { ConnectRepositoryDialog } from './ConnectRepositoryDialog';
import { SourceUploadDialog } from './SourceUploadDialog';
/**
 * Dialog to create a project and continue into repo connect or upload.
 *
 * @param props - Dialog open state handlers
 * @returns Create project dialog
 */
export function CreateProjectDialog({ open, onOpenChange, }) {
    const { t } = useTranslation();
    const { createProject } = useAppData();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [path, setPath] = useState(null);
    const [newProjectId, setNewProjectId] = useState(null);
    const [subDialog, setSubDialog] = useState(null);
    /**
     * Reset local form state.
     */
    const reset = () => {
        setName('');
        setDescription('');
        setPath(null);
        setNewProjectId(null);
        setSubDialog(null);
    };
    /**
     * Create the project and open the follow-up source dialog.
     */
    const handleCreate = () => {
        if (!path)
            return;
        const project = createProject({ name, description, sourceType: path });
        setNewProjectId(project.id);
        setSubDialog(path === 'repo' ? 'repo' : 'upload');
    };
    return (<>
      <Dialog open={open} onOpenChange={(nextOpen) => {
            onOpenChange(nextOpen);
            if (!nextOpen)
                reset();
        }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderKanban className="h-4 w-4 text-brand" aria-hidden="true"/>
              {t('projects.createTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('projects.createDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pname">{t('projects.name')}</Label>
              <Input id="pname" value={name} onChange={(event) => setName(event.target.value)} placeholder={t('projects.namePlaceholder')} autoFocus/>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pdesc">
                {t('projects.description')}{' '}
                <span className="font-normal text-muted-foreground">
                  ({t('common.optional')})
                </span>
              </Label>
              <Textarea id="pdesc" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} placeholder={t('projects.descriptionPlaceholder')}/>
            </div>

            <div>
              <Label>{t('projects.sourceType')}</Label>
              <div className="mt-1.5 grid grid-cols-2 gap-3">
                <button type="button" onClick={() => setPath('upload')} className={cn('flex flex-col items-start gap-1.5 rounded-xl border p-4 text-left transition-colors', path === 'upload'
            ? 'border-brand bg-brand-muted/40 ring-1 ring-brand'
            : 'border-border hover:bg-muted')}>
                  <UploadCloud className={cn('h-5 w-5', path === 'upload' ? 'text-brand' : 'text-muted-foreground')} aria-hidden="true"/>
                  <span className="text-sm font-medium">
                    {t('projects.sourceUpload')}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('projects.sourceUploadHint')}
                  </span>
                </button>
                <button type="button" onClick={() => setPath('repo')} className={cn('flex flex-col items-start gap-1.5 rounded-xl border p-4 text-left transition-colors', path === 'repo'
            ? 'border-brand bg-brand-muted/40 ring-1 ring-brand'
            : 'border-border hover:bg-muted')}>
                  <GitBranch className={cn('h-5 w-5', path === 'repo' ? 'text-brand' : 'text-muted-foreground')} aria-hidden="true"/>
                  <span className="text-sm font-medium">
                    {t('projects.sourceRepo')}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t('projects.sourceRepoHint')}
                  </span>
                </button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => {
            onOpenChange(false);
            reset();
        }}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={!name.trim() || !path}>
              {path === 'repo'
            ? t('projects.continueConnect')
            : path === 'upload'
                ? t('projects.continueUpload')
                : t('common.next')}
              <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true"/>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {newProjectId && (<>
          <ConnectRepositoryDialog open={subDialog === 'repo'} onOpenChange={(nextOpen) => setSubDialog(nextOpen ? 'repo' : null)} projectId={newProjectId} onConnected={() => onOpenChange(false)}/>
          <SourceUploadDialog open={subDialog === 'upload'} onOpenChange={(nextOpen) => setSubDialog(nextOpen ? 'upload' : null)} projectId={newProjectId} onUploaded={() => onOpenChange(false)}/>
        </>)}
    </>);
}
export default CreateProjectDialog;
