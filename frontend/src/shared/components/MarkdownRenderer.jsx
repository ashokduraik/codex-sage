import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/shared/lib/utils';
/**
 * Fenced code block with a language label and copy button.
 * @param props - Code block props.
 * @returns Styled code block UI.
 */
function CodeBlock({ children, className }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const lang = className?.replace('language-', '') || 'code';
  const text = String(children).replace(/\n$/, '');
  /**
   * Copy the code text to the clipboard and briefly show confirmation.
   */
  function copy() {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="group relative my-3 overflow-hidden rounded-lg border border-border bg-[hsl(215_28%_8%)]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-white/50">{lang}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-white/60 hover:bg-white/10 hover:text-white/90"
        >
          {copied ? <Check className="h-3 w-3" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
      <pre className="scrollbar-thin overflow-x-auto p-3.5 text-[13px] leading-relaxed">
        <code className="font-mono text-white/90">{text}</code>
      </pre>
    </div>
  );
}
/**
 * Render GFM markdown with Codex Sage prose styles and copyable code blocks.
 * @param props - Renderer props.
 * @returns Markdown content UI.
 */
export default function MarkdownRenderer({ content, className }) {
  return (
    <div className={cn('prose-sage text-[15px] leading-relaxed text-foreground/90', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ node: _node, ...props }) => <h1 className="font-display text-xl font-medium mt-5 mb-2 text-foreground" {...props} />,
          h2: ({ node: _node, ...props }) => <h2 className="font-display text-lg font-medium mt-5 mb-2 text-foreground" {...props} />,
          h3: ({ node: _node, ...props }) => <h3 className="text-base font-semibold mt-4 mb-1.5 text-foreground" {...props} />,
          p: ({ node: _node, ...props }) => <p className="my-2.5" {...props} />,
          ul: ({ node: _node, ...props }) => <ul className="my-2.5 list-disc pl-5 space-y-1 marker:text-muted-foreground" {...props} />,
          ol: ({ node: _node, ...props }) => <ol className="my-2.5 list-decimal pl-5 space-y-1 marker:text-muted-foreground" {...props} />,
          li: ({ node: _node, ...props }) => <li className="pl-0.5" {...props} />,
          a: ({ node: _node, ...props }) => (
            <a className="text-brand underline underline-offset-2 hover:text-brand/80" target="_blank" rel="noreferrer" {...props} />
          ),
          blockquote: ({ node: _node, ...props }) => (
            <blockquote className="my-3 border-l-2 border-brand/40 bg-brand-muted/40 px-4 py-2 italic text-foreground/70 rounded-r" {...props} />
          ),
          hr: () => <hr className="my-4 border-border" />,
          pre: ({ children }) => <>{children}</>,
          code: ({ className: codeClassName, children }) => {
            const match = /language-(\w+)/.exec(codeClassName || '');
            if (match) {
              return <CodeBlock className={codeClassName}>{children}</CodeBlock>;
            }
            return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground/90">{children}</code>;
          },
          table: ({ node: _node, ...props }) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-sm" {...props} />
            </div>
          ),
          thead: ({ node: _node, ...props }) => <thead className="bg-muted" {...props} />,
          th: ({ node: _node, ...props }) => <th className="border-b border-border px-3 py-2 text-left font-semibold" {...props} />,
          td: ({ node: _node, ...props }) => <td className="border-b border-border px-3 py-2 align-top" {...props} />,
        }}
      >
        {content || ''}
      </ReactMarkdown>
    </div>
  );
}
