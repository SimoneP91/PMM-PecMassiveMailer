import { describe, expect, it } from 'vitest';

import { compileTemplate, renderTemplate } from '../../../src/modules/templates/template-compiler';

function compiled(subject: string, html: string, inlineImages: { cid: string; part: string }[] = []) {
  const result = compileTemplate({ subject, html, inlineImages });
  if (!result.ok) {
    throw new Error(JSON.stringify(result.errors));
  }

  return result;
}

describe('compileTemplate', () => {
  it('collects placeholders from subject and body', () => {
    const { template, warnings } = compiled('Pratica {{n}}', '<p>{{name}}</p>{{{table}}}');

    expect(template.placeholders).toEqual([
      { name: 'n', raw: false },
      { name: 'name', raw: false },
      { name: 'table', raw: true },
    ]);
    expect(warnings).toEqual([]);
  });

  it('warns when there is no placeholder at all', () => {
    expect(compiled('Fisso', '<p>Uguale</p>').warnings.map((w) => w.code)).toEqual([
      'TEMPLATE_WITHOUT_PLACEHOLDERS',
    ]);
  });

  it('rejects raw placeholders in the subject and malformed braces', () => {
    const result = compileTemplate({ subject: '{{{x}}}', html: '<p>{{a}</p>', inlineImages: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => [e.path, e.code])).toEqual([
        ['template.subject', 'RAW_PLACEHOLDER_IN_SUBJECT'],
        ['template.html', 'MALFORMED_PLACEHOLDER'],
      ]);
    }
  });

  it('checks inline image declarations both ways', () => {
    const missing = compileTemplate({ subject: 's', html: '<img src="cid:logo">', inlineImages: [] });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors[0]?.code).toBe('UNDECLARED_INLINE_IMAGE');
    }

    const unused = compiled('s', '<p>{{x}}</p>', [{ cid: 'logo', part: 'logo' }]);
    expect(unused.warnings.map((w) => w.code)).toEqual(['UNUSED_INLINE_IMAGE']);
  });

  it('bundles HTML policy violations', () => {
    const result = compileTemplate({ subject: 's', html: '<script>1</script>', inlineImages: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({ path: 'template.html', code: 'FORBIDDEN_ELEMENT' });
    }
  });
});

describe('renderTemplate', () => {
  const { template } = compiled('Pratica {{n}}', '<p>Gentile {{name}},</p>{{{table}}}');

  it('renders a complete row', () => {
    const result = renderTemplate(
      template,
      new Map([
        ['n', '12'],
        ['name', 'A & B'],
        ['table', '<table><tr><td>1</td></tr></table>'],
        ['extra', 'x'],
      ]),
      'messages[0]',
    );

    expect(result).toEqual({
      ok: true,
      message: {
        subject: 'Pratica 12',
        html: '<p>Gentile A &amp; B,</p><table><tr><td>1</td></tr></table>',
        unusedVars: ['extra'],
      },
    });
  });

  it('lists every missing placeholder with its path', () => {
    const result = renderTemplate(template, new Map([['n', '1']]), 'messages[3]');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.path)).toEqual(['messages[3].vars.name', 'messages[3].vars.table']);
      expect(result.errors[0]?.code).toBe('MISSING_PLACEHOLDER');
    }
  });

  it('applies the HTML policy to raw values', () => {
    const result = renderTemplate(
      template,
      new Map([
        ['n', '1'],
        ['name', 'x'],
        ['table', '<p onclick="x">1</p><img src="https://t/p.gif">'],
      ]),
      'messages[0]',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(['HTML_VALUE_REJECTED', 'HTML_VALUE_REJECTED']);
      expect(result.errors[0]?.path).toBe('messages[0].vars.table');
    }
  });

  it('folds a subject value with line breaks and enforces the length', () => {
    const folded = renderTemplate(
      template,
      new Map([
        ['n', 'a\r\nb'],
        ['name', 'x'],
        ['table', ''],
      ]),
      'm',
    );
    expect(folded.ok && folded.message.subject).toBe('Pratica a b');

    const long = renderTemplate(
      template,
      new Map([
        ['n', 'x'.repeat(600)],
        ['name', 'x'],
        ['table', ''],
      ]),
      'm',
    );
    expect(long.ok).toBe(false);
  });
});
