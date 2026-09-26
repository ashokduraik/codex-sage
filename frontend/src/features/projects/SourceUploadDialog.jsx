import { useState } from 'react';
import { UploadCloud, File, Loader2, AlertCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/shared/ui/dialog';
import { cn } from '@/shared/lib/utils';
import { useUploadSource } from './hooks/useUploadSource.js';

/**
 * Dialog that uploads a ZIP archive to the backend (HTTP progress only).
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   projectId: string,
 *   onUploaded?: (result: { sourceVersionId: string, jobId: string }) => void,
 * }} props Dialog props.
 * @returns {import('react').ReactElement}
 */
export function SourceUploadDialog({ open, onOpenChange, projectId, onUploaded }) {
  const { t } = useTranslation();
  const upload = useUploadSource();
  const [file, setFile] = useState(null);
  const [rejectMsg, setRejectMsg] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [submitError, setSubmitError] = useState(null);

  /**
   * Clears local dialog state.
   */
  function reset() {
    setFile(null);
    setRejectMsg(null);
    setSubmitError(null);
    setDragOver(false);
    setIdempotencyKey(crypto.randomUUID());
    upload.reset();
    upload.resetProgress();
  }

  /**
   * Accepts a ZIP file or shows the folder-unsupported / type message.
   * @param {File | null | undefined} nextFile Candidate file.
   */
  function selectFile(nextFile) {
    setRejectMsg(null);
    setSubmitError(null);
    upload.reset();
    upload.resetProgress();
    if (!nextFile) {
      setFile(null);
      return;
    }
    const fileName = nextFile.name.toLowerCase();
    if (!fileName.endsWith('.zip') && nextFile.type !== 'application/zip' && nextFile.type !== 'application/x-zip-compressed') {
      setFile(null);
      setRejectMsg(t('sources.folderUnsupported'));
      return;
    }
    setFile(nextFile);
    setIdempotencyKey(crypto.randomUUID());
  }

  /**
   * @param {import('react').DragEvent<HTMLDivElement>} event Drop event.
   */
  function onDrop(event) {
    event.preventDefault();
    setDragOver(false);
    const dropped = event.dataTransfer.files?.[0];
    selectFile(dropped);
  }

  /**
   * Submits the selected ZIP.
   */
  async function startUpload() {
    if (!file) {
      return;
    }
    try {
      const result = await upload.mutateAsync({
        projectId,
        file,
        idempotencyKey,
      });
      onUploaded?.({
        sourceVersionId: result.sourceVersionId,
        jobId: result.jobId,
      });
      onOpenChange(false);
      reset();
    } catch (error) {
      setSubmitError(error instanceof Error ? error : new Error(String(error)));
      if (error instanceof ApiError && error.code === 'IDEMPOTENCY_IN_FLIGHT') {
        return;
      }
      setIdempotencyKey(crypto.randomUUID());
    }
  }

  const uploading = upload.isPending;
  const apiError = submitError instanceof ApiError ? submitError : upload.error instanceof ApiError ? upload.error : null;
  const alertMessage =
    rejectMsg ||
    (apiError?.code === 'IDEMPOTENCY_IN_FLIGHT' ? t('sources.stillProcessing') : apiError?.message) ||
    (submitError instanceof Error ? submitError.message : null);
  const percent =
    upload.progress.total > 0 ? Math.min(100, Math.round((upload.progress.loaded / upload.progress.total) * 100)) : uploading ? null : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          reset();
        }
      }}
    >
      <DialogContent className="w-[calc(100vw-1.5rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UploadCloud className="h-4 w-4 text-brand" aria-hidden="true" />
            {t('sources.uploadDialogTitle')}
          </DialogTitle>
          <DialogDescription>{t('sources.uploadDialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={cn(
              'flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition-colors',
              dragOver ? 'border-brand bg-brand-muted/30' : 'border-border bg-muted/30',
            )}
          >
            <UploadCloud className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="mt-2 text-sm font-medium">{t('sources.dragDropZip')}</p>
            <p className="text-xs text-muted-foreground">{t('sources.orChooseBelow')}</p>
          </div>

          <label>
            <input
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              className="hidden"
              disabled={uploading}
              onChange={(event) => {
                selectFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <span className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-muted">
              <File className="h-4 w-4" aria-hidden="true" />
              {t('sources.selectZip')}
            </span>
          </label>

          <p className="text-xs text-muted-foreground">{t('sources.folderUnsupported')}</p>

          {file && (
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
              <span className="truncate">{file.name}</span>
              <span className="text-muted-foreground">
                {file.size > 1024 * 1024
                  ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
                  : file.size > 1024
                    ? `${(file.size / 1024).toFixed(0)} KB`
                    : `${file.size} B`}
              </span>
            </div>
          )}

          {uploading && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-brand" aria-hidden="true" />
                  {t('sources.uploadingBytes')}
                </span>
                <span className="font-medium">{percent == null ? '…' : `${percent}%`}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-brand transition-all" style={{ width: `${percent ?? 30}%` }} />
              </div>
            </div>
          )}

          {alertMessage && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <div>
                <p>{alertMessage}</p>
                {apiError?.correlationId && <p className="mt-1 text-xs text-muted-foreground">{apiError.correlationId}</p>}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:gap-0">
          <Button
            variant="outline"
            disabled={uploading}
            onClick={() => {
              onOpenChange(false);
              reset();
            }}
          >
            <X className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void startUpload()} disabled={!file || uploading} aria-busy={uploading}>
            {uploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {uploading ? t('sources.processing') : t('sources.startProcessing')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default SourceUploadDialog;
