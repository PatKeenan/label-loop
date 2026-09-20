import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown, safeUrl } from './markdown.tsx'

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />)

describe('Markdown — caller text, rendered safely (ADR-0078)', () => {
  test('renders the markdown a chat reply is written in', () => {
    const out = html('**bold** and `code`\n\n- one\n- two')
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('<code')
    expect(out).toContain('<li>one</li>')
  })

  test('one line with inline marks is ONE paragraph, not stacked pieces', () => {
    const out = html('I was charged **twice** for March.')
    expect(out).toContain('<p class="m-0">I was charged <strong>twice</strong> for March.</p>')
  })

  test('raw HTML stays TEXT — no element, no handler', () => {
    const out = html('<img src=x onerror="alert(1)"> hi <script>alert(2)</script>')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<script')
    expect(out).toContain('&lt;img src=x onerror=')
    expect(out).toContain('&lt;script&gt;')
  })

  test('an HTML block stays text too', () => {
    const out = html('<div onclick="steal()">block</div>')
    expect(out).not.toContain('onclick="steal()"')
    expect(out).toContain('&lt;div onclick=')
  })

  test('a javascript: link is not a link; an https one is, opened safely', () => {
    const out = html('[bad](javascript:alert(1)) and [good](https://example.com)')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('<span>bad</span>')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('rel="noopener noreferrer nofollow"')
  })

  test('an image is never fetched — only its alt text shows', () => {
    const out = html('![beacon](https://evil.example/pixel.gif)')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('evil.example')
    expect(out).toContain('[beacon]')
  })

  test('safeUrl keeps http(s) and mailto, and nothing else', () => {
    expect(safeUrl('https://a.example', 'a', 'href')).toBe('https://a.example')
    expect(safeUrl('mailto:x@example.com', 'a', 'href')).toBe('mailto:x@example.com')
    for (const url of ['javascript:alert(1)', ' JavaScript:x', 'data:text/html,x', '/relative']) {
      expect(safeUrl(url, 'a', 'href')).toBeNull()
    }
    expect(safeUrl('https://a.example/x.png', 'img', 'src')).toBeNull()
  })
})
