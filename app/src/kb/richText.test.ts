// Rich Ingestion converter + paste-interpreter tests (SPEC-0040 RICHIN-1/2/3). Pure unit tests
// (turndown bundles its own DOM, so no DOM env needed). Each asserts a requirement class.
import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, interpretPaste } from './richText';

describe('htmlToMarkdown (RICHIN-1: semantic structure → Markdown, drop chrome)', () => {
  it('preserves headings', () => {
    expect(htmlToMarkdown('<h1>Title</h1><h2>Sub</h2>')).toBe('# Title\n\n## Sub');
  });

  it('preserves unordered + ordered lists', () => {
    expect(htmlToMarkdown('<ul><li>a</li><li>b</li></ul>')).toMatch(/-\s+a/);
    expect(htmlToMarkdown('<ul><li>a</li><li>b</li></ul>')).toMatch(/-\s+b/);
    expect(htmlToMarkdown('<ol><li>one</li><li>two</li></ol>')).toMatch(/1\.\s+one/);
  });

  it('preserves blockquotes and fenced code', () => {
    expect(htmlToMarkdown('<blockquote><p>quoted</p></blockquote>')).toContain('> quoted');
    const code = htmlToMarkdown('<pre><code>const x = 1;</code></pre>');
    expect(code).toContain('```');
    expect(code).toContain('const x = 1;');
  });

  it('preserves GFM tables and strikethrough', () => {
    const table = htmlToMarkdown('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
    expect(table).toContain('| A | B |');
    expect(table).toContain('| 1 | 2 |');
    expect(htmlToMarkdown('<p><del>gone</del></p>')).toMatch(/~+gone~+/);
  });

  it('preserves links, images-by-reference, and inline emphasis', () => {
    expect(htmlToMarkdown('<a href="http://x.test">link</a>')).toContain('[link](http://x.test)');
    expect(htmlToMarkdown('<img src="http://x.test/i.png" alt="alt">')).toContain('![alt](http://x.test/i.png)');
    expect(htmlToMarkdown('<p><strong>bold</strong> and <em>italic</em></p>')).toBe('**bold** and *italic*');
  });

  it('drops visual-only chrome (script/style content is not knowledge)', () => {
    const md = htmlToMarkdown('<style>.x{color:red}</style><script>alert(1)</script><p>kept</p>');
    expect(md).toBe('kept');
    expect(md).not.toContain('alert');
    expect(md).not.toContain('color:red');
  });

  it('returns empty for empty/whitespace input', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('   ')).toBe('');
  });
});

describe('interpretPaste (RICHIN-1/2/3: rich vs plain, sidecar-only-when-it-differs)', () => {
  it('a rich paste yields Markdown + keeps the original HTML for the sidecar', () => {
    const r = interpretPaste({ html: '<h1>Hi</h1><ul><li>a</li></ul>', plain: 'Hi\na' });
    expect(r.rich).toBe(true);
    expect(r.markdown).toContain('# Hi');
    expect(r.markdown).toMatch(/-\s+a/);
    expect(r.html).toBe('<h1>Hi</h1><ul><li>a</li></ul>');
  });

  it('a plain paste (no HTML flavor) keeps no sidecar', () => {
    const r = interpretPaste({ plain: 'just text' });
    expect(r.rich).toBe(false);
    expect(r.markdown).toBe('just text');
    expect(r.html).toBeNull();
  });

  it('plainOnly forces the plain path even when HTML is present (RICHIN-3 escape hatch)', () => {
    const r = interpretPaste({ html: '<strong>x</strong>', plain: 'x' }, { plainOnly: true });
    expect(r.rich).toBe(false);
    expect(r.markdown).toBe('x');
    expect(r.html).toBeNull();
  });

  it('HTML that adds no structure (collapses to the plain text) keeps no sidecar (RICHIN-2)', () => {
    const r = interpretPaste({ html: '<div>hello world</div>', plain: 'hello world' });
    expect(r.rich).toBe(false);
    expect(r.html).toBeNull();
  });
});
