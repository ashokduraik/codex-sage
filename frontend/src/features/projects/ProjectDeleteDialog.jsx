import { Button } from '@/shared/ui/button';
import { Loader2, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDeleteProject } from './hooks/useProjectMutations.js';
import { useProjectDeletionPreview } from './hooks/useProjectDeletionPreview.js';
import { correlationFromUnknown, isForbiddenApiError, messageFromUnknown, retryAfterFromUnknown } from '@/shared/api';
import {
  AlertDialog,
  AlertDialogTitle,
  AlertDialogCancel,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogContent,
  AlertDialogDescription,
} from '@/shared/ui/alert-dialog';

/**
 * Consequence-explaining delete confirmation dialog.
 *
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   projectId: string,
 *   projectName: string,
 *   onDeleted?: () => void,
 * }} props Dialog props.
 * @returns Delete confirmation dialog.
 */
export function ProjectDeleteDialog({ open, onOpenChange, projectId, projectName, onDeleted }) {
  const { t } = useTranslation();
  const previewQuery = useProjectDeletionPreview(projectId, { enabled: open });
  const deleteMutation = useDeleteProject();

  const previewError = previewQuery.isError ? messageFromUnknown(previewQuery.error, t('projects.deletePreviewFailed')) : '';
  const deleteError = deleteMutation.isError
    ? isForbiddenApiError(deleteMutation.error)
      ? t('projects.forbidden')
      : messageFromUnknown(deleteMutation.error, t('projects.detailFailed'))
    : '';
  const correlationId = correlationFromUnknown(deleteMutation.error || previewQuery.error);
  const retryAfter = retryAfterFromUnknown(deleteMutation.error);
  const canConfirm = previewQuery.isSuccess && !previewQuery.isError && !deleteMutation.isPending;

  /**
   * Confirms soft-delete when the preview succeeded.
   */
  const handleConfirm = () => {
    if (!canConfirm) {
      return;
    }
    deleteMutation.mutate(projectId, {
      onSuccess: () => {
        onOpenChange(false);
        onDeleted?.();
      },
    });
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          deleteMutation.reset();
        }
        onOpenChange(nextOpen);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('projects.deleteTitle', { name: projectName })}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-muted-foreground">
              {previewQuery.isLoading ? (
                <p className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {t('projects.deletePreviewLoading')}
                </p>
              ) : null}

              {previewQuery.isError ? (
                <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-foreground">
                  <p>{previewError}</p>
                </div>
              ) : null}

              {previewQuery.isSuccess ? (
                <>
                  <div>
                    <p className="font-medium text-foreground">{t('projects.deleteCountsHeading')}</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      <li>
                        {t('projects.countSourceVersions', {
                          count: previewQuery.data.counts.sourceVersions,
                        })}
                      </li>
                      <li>{t('projects.countFiles', { count: previewQuery.data.counts.files })}</li>
                      <li>
                        {t('projects.countConversations', {
                          count: previewQuery.data.counts.conversations,
                        })}
                      </li>
                      <li>{t('projects.countJobs', { count: previewQuery.data.counts.jobs })}</li>
                    </ul>
                  </div>
                  <div>
                    <p className="font-medium text-foreground">{t('projects.deleteConsequencesHeading')}</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {previewQuery.data.consequences.map((row) => (
                        <li key={`${row.resource}-${row.effect}`}>{consequenceLabel(row, t)}</li>
                      ))}
                    </ul>
                  </div>
                </>
              ) : null}

              {deleteMutation.isError ? (
                <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-foreground">
                  <p>{deleteError}</p>
                  {typeof retryAfter === 'number' ? <p className="mt-1">{t('projects.retryAfter', { seconds: retryAfter })}</p> : null}
                  {correlationId ? <p className="mt-1 text-xs">{t('projects.correlationReference', { reference: correlationId })}</p> : null}
                </div>
              ) : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteMutation.isPending}>{t('projects.deleteCancel')}</AlertDialogCancel>
          <Button variant="destructive" disabled={!canConfirm} aria-busy={deleteMutation.isPending} onClick={handleConfirm}>
            {deleteMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            {t('projects.deleteConfirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  /**
   * Builds an i18n key for a deletion consequence row.
   * @param {{ resource: string, effect: string, retentionDays: number | null }} consequence Row.
   * @param {(key: string, options?: object) => string} t Translator.
   * @returns {string}
   */
  function consequenceLabel(consequence, t) {
    const specificKey = `projects.consequence_${consequence.resource}_${consequence.effect}`;
    const specific = t(specificKey, { days: consequence.retentionDays ?? '' });
    if (specific !== specificKey) {
      return specific;
    }
    return t('projects.consequence_generic', {
      resource: consequence.resource,
      effect: consequence.effect,
    });
  }
}

export default ProjectDeleteDialog;
