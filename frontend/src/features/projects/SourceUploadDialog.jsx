import { useCallback, useState, } from 'react';
import { UploadCloud, File, Folder, Loader2, Check, AlertCircle, X, } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, } from '@/shared/ui/dialog';
import { useAppData, NOISE_PATTERNS } from '@/shared/mock-data';
import { cn } from '@/shared/lib/utils';
/**
 * Format a byte size for the file preview list.
 *
 * @param bytes - File size in bytes
 * @returns Human-readable size label
 */
function formatFileSize(bytes) {
    if (bytes > 1024 * 1024)
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes > 1024)
        return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
}
/**
 * Dialog to upload a folder or ZIP as a project source.
 *
 * @param props - Dialog props including project id
 * @returns Source upload dialog
 */
export function SourceUploadDialog({ open, onOpenChange, projectId, onUploaded, }) {
    const { t } = useTranslation();
    const { addUpload } = useAppData();
    const [files, setFiles] = useState([]);
    const [excluded, setExcluded] = useState(0);
    const [folders, setFolders] = useState(0);
    const [stage, setStage] = useState('pick');
    const [progress, setProgress] = useState(0);
    const [processed, setProcessed] = useState(0);
    const [failed, setFailed] = useState(0);
    const [dragOver, setDragOver] = useState(false);
    const [rejectMsg, setRejectMsg] = useState(null);
    /**
     * Reset dialog state to the file-pick stage.
     */
    const reset = () => {
        setFiles([]);
        setExcluded(0);
        setFolders(0);
        setStage('pick');
        setProgress(0);
        setProcessed(0);
        setFailed(0);
        setRejectMsg(null);
    };
    /**
     * Analyze selected files, excluding noise path segments.
     *
     * @param fileList - Files chosen by the user
     */
    const analyze = useCallback((fileList) => {
        const arr = Array.from(fileList);
        let folderCount = 0;
        let excludedCount = 0;
        const kept = [];
        let hasNoise = false;
        arr.forEach((file) => {
            const path = file.webkitRelativePath || file.name;
            const parts = path.split('/');
            const hasNoiseSeg = parts.some((seg) => NOISE_PATTERNS.includes(seg));
            if (hasNoiseSeg) {
                excludedCount++;
                hasNoise = true;
                return;
            }
            if (parts.length > 1)
                folderCount++;
            kept.push(file);
        });
        const onlyFile = arr[0];
        if (arr.length === 1 && onlyFile?.name.endsWith('.zip') && hasNoise) {
            setRejectMsg(t('sources.zipNoiseReject'));
            return;
        }
        setFiles(kept);
        setExcluded(excludedCount);
        setFolders(folderCount);
        setStage('preview');
    }, [t]);
    /**
     * Handle drag-and-drop of files or folders.
     *
     * @param event - Drop event
     */
    const onDrop = (event) => {
        event.preventDefault();
        setDragOver(false);
        const items = event.dataTransfer.items;
        if (items) {
            const collect = [];
            for (let index = 0; index < items.length; index++) {
                const item = items[index];
                if (!item || item.kind !== 'file')
                    continue;
                const entry = item.webkitGetAsEntry?.();
                if (entry?.isDirectory) {
                    entry.file?.((file) => collect.push(file));
                }
                else {
                    const file = item.getAsFile();
                    if (file)
                        collect.push(file);
                }
            }
            analyze(collect);
        }
        else {
            analyze(event.dataTransfer.files);
        }
    };
    /**
     * Handle folder input selection.
     *
     * @param event - Change event from the folder file input
     */
    const handleFolderInput = (event) => {
        const list = event.target.files;
        if (list && list.length)
            analyze(list);
    };
    /**
     * Handle multi-file / ZIP input selection.
     *
     * @param event - Change event from the file input
     */
    const handleFileInput = (event) => {
        const list = event.target.files;
        if (list && list.length)
            analyze(list);
    };
    /**
     * Simulate upload progress and attach the upload to the project.
     */
    const startUpload = async () => {
        setStage('uploading');
        setProgress(0);
        setProcessed(0);
        setFailed(0);
        const total = files.length || 1;
        for (let index = 0; index < total; index++) {
            await new Promise((resolve) => setTimeout(resolve, 8));
            setProcessed(index + 1);
            setProgress(Math.round(((index + 1) / total) * 100));
            if (index === Math.floor(total * 0.9))
                setFailed(0);
        }
        setStage('done');
        const sizeMb = (files.reduce((sum, file) => sum + (file.size || 0), 0) /
            (1024 * 1024)).toFixed(1);
        addUpload(projectId, {
            name: folders > 0
                ? t('sources.folderUploadName')
                : files[0]?.name || 'upload.zip',
            size: `${sizeMb || '12.4'} MB`,
            files: files.length,
            uploadedAt: new Date().toISOString(),
            status: 'completed',
        });
    };
    return (<Dialog open={open} onOpenChange={(nextOpen) => {
            onOpenChange(nextOpen);
            if (!nextOpen)
                reset();
        }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UploadCloud className="h-4 w-4 text-brand" aria-hidden="true"/>
            {t('sources.uploadDialogTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('sources.uploadDialogDescription')}
          </DialogDescription>
        </DialogHeader>

        {stage === 'pick' && (<div className="space-y-3">
            <div onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
            }} onDragLeave={() => setDragOver(false)} onDrop={onDrop} className={cn('flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-colors', dragOver
                ? 'border-brand bg-brand-muted/30'
                : 'border-border bg-muted/30')}>
              <UploadCloud className="h-8 w-8 text-muted-foreground" aria-hidden="true"/>
              <p className="mt-2 text-sm font-medium">
                {t('sources.dragDropHint')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('sources.orChooseBelow')}
              </p>
            </div>
            {rejectMsg && (<div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true"/>
                {rejectMsg}
              </div>)}
            <div className="flex flex-wrap gap-2">
              <label>
                <input type="file" multiple className="hidden" onChange={handleFolderInput} {...{
            webkitdirectory: '',
            directory: '',
        }}/>
                <span className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-muted">
                  <Folder className="h-4 w-4" aria-hidden="true"/>
                  {t('sources.selectFolder')}
                </span>
              </label>
              <label>
                <input type="file" multiple className="hidden" onChange={handleFileInput}/>
                <span className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-muted">
                  <File className="h-4 w-4" aria-hidden="true"/>
                  {t('sources.selectFiles')}
                </span>
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('sources.autoExcludes', {
                patterns: NOISE_PATTERNS.join(', '),
            })}
            </p>
          </div>)}

        {stage === 'preview' && (<div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="text-lg font-semibold text-foreground">
                  {files.length}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t('sources.fileCount')}
                </div>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="text-lg font-semibold text-foreground">
                  {folders}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t('sources.folderCount')}
                </div>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="text-lg font-semibold text-foreground">
                  {excluded}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t('sources.excludedCount')}
                </div>
              </div>
            </div>
            <div className="max-h-32 overflow-y-auto rounded-lg border border-border p-2 scrollbar-thin">
              {files.slice(0, 8).map((file, index) => (<div key={`${file.name}-${index}`} className="flex items-center justify-between py-0.5 text-xs">
                  <span className="truncate text-muted-foreground">
                    {file.webkitRelativePath || file.name}
                  </span>
                  <span className="text-muted-foreground">
                    {formatFileSize(file.size)}
                  </span>
                </div>))}
              {files.length > 8 && (<div className="py-0.5 text-xs text-muted-foreground">
                  {t('sources.moreFiles', { count: files.length - 8 })}
                </div>)}
            </div>
            {excluded > 0 && (<p className="text-xs text-muted-foreground">
                {t('sources.excludedNote', { count: excluded })}
              </p>)}
          </div>)}

        {stage === 'uploading' && (<div className="space-y-3 py-2">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-brand" aria-hidden="true"/>
                {t('sources.uploadingProcessing')}
              </span>
              <span className="font-medium">{progress}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-brand transition-all" style={{ width: `${progress}%` }}/>
            </div>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{t('sources.filesProcessed', { count: processed })}</span>
              <span>{t('sources.filesFailed', { count: failed })}</span>
            </div>
          </div>)}

        {stage === 'done' && (<div className="flex flex-col items-center py-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
              <Check className="h-6 w-6" aria-hidden="true"/>
            </div>
            <p className="mt-3 font-medium">{t('sources.uploadComplete')}</p>
            <p className="text-sm text-muted-foreground">
              {t('sources.uploadCompleteBody', { count: files.length })}
            </p>
          </div>)}

        <DialogFooter className="gap-2 sm:gap-0">
          {stage === 'pick' && (<Button variant="outline" onClick={() => {
                onOpenChange(false);
                reset();
            }}>
              {t('common.cancel')}
            </Button>)}
          {stage === 'preview' && (<>
              <Button variant="outline" onClick={reset}>
                <X className="mr-2 h-4 w-4" aria-hidden="true"/>
                {t('sources.resetSelection')}
              </Button>
              <Button onClick={() => void startUpload()}>
                {t('sources.startProcessing')}
              </Button>
            </>)}
          {stage === 'uploading' && (<Button disabled aria-busy>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true"/>
              {t('sources.processing')}
            </Button>)}
          {stage === 'done' && (<Button onClick={() => {
                onUploaded?.();
                onOpenChange(false);
                reset();
            }}>
              {t('common.close')}
            </Button>)}
        </DialogFooter>
      </DialogContent>
    </Dialog>);
}
export default SourceUploadDialog;
