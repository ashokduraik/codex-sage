import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
/**
 * Chat composer with auto-growing textarea and send/stop controls.
 *
 * @param props - Composer callbacks and UI state
 * @returns Composer footer
 */
export function Composer({ onSend, onStop, isGenerating = false, disabled = false, placeholder, queued = false, contextWarning = false }) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const textareaRef = useRef(null);
  const resolvedPlaceholder = placeholder ?? t('chat.askPlaceholder');
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [value]);
  /**
   * Submit the current draft when non-empty and not blocked.
   */
  const submit = () => {
    if (!value.trim() || isGenerating || disabled) return;
    onSend(value.trim());
    setValue('');
  };
  return (
    <div className="border-t border-border bg-background px-4 py-3 sm:px-6">
      <div className="mx-auto max-w-3xl">
        {contextWarning && (
          <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            {t('chat.contextWarning')}
          </div>
        )}
        {queued && (
          <div className="mb-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs text-blue-700">{t('chat.queuedNotice')}</div>
        )}
        <div
          className={cn(
            'flex items-end gap-2 rounded-xl border border-border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/30',
            disabled && 'opacity-60',
          )}
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={resolvedPlaceholder}
            rows={1}
            disabled={disabled}
            className="max-h-[200px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground scrollbar-thin"
          />
          {isGenerating ? (
            <button
              type="button"
              onClick={onStop}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted"
              title={t('chat.stop')}
              aria-label={t('chat.stop')}
            >
              <Square className="h-4 w-4 fill-current" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!value.trim() || disabled}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-foreground transition-opacity hover:bg-brand/90 disabled:opacity-40"
              title={t('chat.send')}
              aria-label={t('chat.send')}
            >
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-center text-[11px] text-muted-foreground">{t('chat.composerHint')}</p>
      </div>
    </div>
  );
}
export default Composer;
