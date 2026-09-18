import { describe, expect, it } from 'vitest';

import {
  escapeHtml,
  parsePlaceholders,
  renderPlaceholders,
  toHeaderText,
} from '../../../src/modules/templates/placeholders';

describe('parsePlaceholders', () => {
  it('finds text and raw placeholders once each, tolerating spaces', () => {
    const { placeholders, malformedAt } = parsePlaceholders('{{a}} {{ b }} {{{c}}} {{a}} {{{ c }}}');

    expect(placeholders).toEqual([
      { name: 'a', raw: false },
      { name: 'b', raw: false },
      { name: 'c', raw: true },
    ]);
    expect(malformedAt).toEqual([]);
  });

  it('treats a name used both ways as raw', () => {
    expect(parsePlaceholders('{{x}} {{{x}}}').placeholders).toEqual([{ name: 'x', raw: true }]);
  });

  it('reports unbalanced or invalid braces', () => {
    expect(parsePlaceholders('{{a} {{1bad}} }}').malformedAt.length).toBeGreaterThan(0);
    expect(parsePlaceholders('{{a-b}}').malformedAt.length).toBeGreaterThan(0);
  });
});

describe('renderPlaceholders', () => {
  const values = new Map([
    ['name', 'Rossi <a href="x">y</a>'],
    ['table', '<table></table>'],
    ['trick', '{{name}}'],
  ]);

  it('escapes text values and inserts raw values as they are', () => {
    expect(renderPlaceholders('<p>{{name}}</p>{{{table}}}', values, escapeHtml)).toBe(
      '<p>Rossi &lt;a href=&quot;x&quot;&gt;y&lt;/a&gt;</p><table></table>',
    );
  });

  it('is single pass: a value containing a placeholder is not expanded', () => {
    expect(renderPlaceholders('{{trick}}', values, escapeHtml)).toBe('{{name}}');
    expect(renderPlaceholders('{{{trick}}}', values, escapeHtml)).toBe('{{name}}');
  });

  it('leaves an unknown placeholder untouched (the compiler rejects it first)', () => {
    expect(renderPlaceholders('{{nope}}', values, escapeHtml)).toBe('{{nope}}');
  });
});

describe('toHeaderText', () => {
  it('folds line breaks so a subject cannot inject headers', () => {
    expect(toHeaderText('a\r\nBcc: x@y\n b ')).toBe('a Bcc: x@y b');
  });
});
