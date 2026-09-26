/**
 * Bounded source preview drawer.
 */
import { useTranslation } from 'react-i18next';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/shared/ui/sheet';
import { useSourcePreview } from './hooks/useSourcePreview.js';

/**
 * @param {{
 *   projectId: string,
 *   target: { path: string, startLine?: number, endLine?: number } | null,
 *   onClose: () => void,
 * }} props Drawer props.
 * @returns {import('react').ReactElement}
 */
export default function SourcePreviewDrawer({ projectId, target, onClose }) {
  const { t } = useTranslation();
  const previewQuery = useSourcePreview(projectId, target);
  const metadata = previewQuery.data?.metadata;
  const slice = previewQuery.data?.slice;
  const open = Boolean(target?.path);

  return (
    <Sheet open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col overflow-hidden sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="truncate font-mono text-base">{target?.path || t('preview.title')}</SheetTitle>
          <SheetDescription>
            {slice ? t('preview.lineRange', { start: slice.startLine, end: slice.endLine }) : t('preview.subtitle')}
          </SheetDescription>
        </SheetHeader>
        {metadata?.excludedFromGraph ? (
          <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
            {t('preview.excluded')}
          </p>
        ) : null}
        {slice?.truncated ? (
          <p className="mt-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground" role="status">
            {t('preview.truncated')}
          </p>
        ) : null}
        {previewQuery.isLoading ? (
          <p className="mt-4 text-sm text-muted-foreground" aria-busy="true">
            {t('preview.loading')}
          </p>
        ) : null}
        {previewQuery.isError ? (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {previewQuery.error?.message || t('preview.error')}
          </p>
        ) : null}
        {metadata && metadata.previewAvailable === false ? <p className="mt-4 text-sm text-muted-foreground">{t('preview.binary')}</p> : null}
        {slice?.content != null ? (
          <pre className="mt-4 min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-5">
            {slice.content}
          </pre>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
