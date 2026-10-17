/**
 * Incremental markdown for in-flight assistant answers — incomplete fences stay as plain pre.
 */
import { MarkdownRenderer } from '@/shared/components';

/**
 * True when content has an unclosed fenced code block (odd count of ``` lines).
 * @param {string} content Markdown draft.
 * @returns {boolean}
 */
export function hasOpenCodeFence(content) {
  if (typeof content !== 'string' || !content) {
    return false;
  }
  const matches = content.match(/^```/gm);
  return Boolean(matches && matches.length % 2 === 1);
}

/**
 * Renders streaming markdown safely for partial input.
 * @param {{ content: string, className?: string }} props Content props.
 * @returns {import('react').ReactElement}
 */
export function StreamingMarkdown({ content, className }) {
  const text = typeof content === 'string' ? content : '';
  if (hasOpenCodeFence(text)) {
    return (
      <pre
        className={`scrollbar-thin overflow-x-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 font-mono text-[13px] leading-relaxed text-foreground/90 ${className || ''}`}
      >
        {text}
      </pre>
    );
  }
  return <MarkdownRenderer content={text} className={className} />;
}

export default StreamingMarkdown;
