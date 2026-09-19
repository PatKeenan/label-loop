import MarkdownToJsx, { type MarkdownToJSX } from 'markdown-to-jsx/react'

/**
 * Caller text as markdown, SAFELY (ADR-0078). A chat reply is usually markdown already, and
 * shown raw it reads as asterisks and hashes; shown as HTML it would run whatever the caller's
 * agent — or its user — typed. So the renderer is `markdown-to-jsx`, which builds React
 * elements rather than an HTML string, with the three doors a payload could walk through shut:
 *
 * - **Raw HTML is not parsed.** `<img onerror=…>` and `<script>` in the text render AS TEXT.
 * - **Link URLs are http(s) and mailto only.** Anything else — `javascript:`, `data:`, a
 *   relative path — loses its href and renders as plain words.
 * - **Images are not fetched.** A remote image is a tracking beacon the caller controls, and
 *   the plan renders no non-text output; an image shows its alt text.
 */

const SAFE_URL = /^(https?:|mailto:)/i

/** Exported for the test: the one decision about which URLs survive. */
export const safeUrl = (value: string, tag: string, attribute: string): string | null => {
  if (tag === 'img' || attribute === 'src') return null
  return SAFE_URL.test(value.trim()) ? value : null
}

/** Headings in someone else's text are emphasis, not page structure: one size, bold. */
const Heading = ({ children }: { children?: React.ReactNode }) => (
  <p className="m-0 font-semibold">{children}</p>
)

const OPTIONS: MarkdownToJSX.Options = {
  disableParsingRawHTML: true,
  ignoreHTMLBlocks: true,
  tagfilter: true,
  sanitizer: safeUrl,
  wrapper: ({ children }: { children?: React.ReactNode }) => (
    <div className="flex flex-col gap-[var(--gap-inline)] text-body leading-[var(--leading-body)] break-words">
      {children}
    </div>
  ),
  forceWrapper: true,
  // Always paragraphs, never bare inline content: the wrapper is a flex column, and one-line
  // text with **bold** in it would otherwise become three stacked items.
  forceBlock: true,
  overrides: {
    h1: Heading,
    h2: Heading,
    h3: Heading,
    h4: Heading,
    h5: Heading,
    h6: Heading,
    p: { props: { className: 'm-0' } },
    ul: { props: { className: 'm-0 list-disc pl-[var(--space-5)]' } },
    ol: { props: { className: 'm-0 list-decimal pl-[var(--space-5)]' } },
    code: { props: { className: 'font-mono text-data' } },
    pre: {
      props: {
        className:
          'm-0 overflow-x-auto rounded-md border px-[var(--pad-field-x)] py-[var(--pad-field-y)] font-mono text-data',
      },
    },
    blockquote: {
      props: { className: 'm-0 border-l-2 pl-[var(--space-4)] text-muted-foreground' },
    },
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) =>
      href === undefined || href === '' ? (
        <span>{children}</span>
      ) : (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="underline underline-offset-2"
        >
          {children}
        </a>
      ),
    img: ({ alt }: { alt?: string }) => (alt ? <span>[{alt}]</span> : null),
  },
}

export const Markdown = ({ text }: { text: string }) => (
  <MarkdownToJsx options={OPTIONS}>{text}</MarkdownToJsx>
)
