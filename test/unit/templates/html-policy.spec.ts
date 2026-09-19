import { describe, expect, it } from 'vitest';

import { checkHtmlPolicy } from '../../../src/modules/templates/html-policy';

const codes = (html: string, mode: 'document' | 'fragment' = 'document'): string[] =>
  checkHtmlPolicy(html, mode, 'template.html').errors.map((error) => error.code);

describe('checkHtmlPolicy', () => {
  it('accepts a typical PEC template', () => {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>x</title>
      <style>p { color: #333 } table { border-collapse: collapse }</style></head>
      <body style="font-family: Arial"><!--[if mso]>x<![endif]-->
      <table width="100%" cellpadding="4"><tr><td align="left" colspan="2"><p>Gentile {{customerName}},</p></td></tr></table>
      <a href="https://portale.example/pratiche/{{practiceNumber}}" target="_blank">Vai</a>
      <a href="mailto:info@example.it">scrivi</a> <img src="cid:logo" alt="logo" width="120">
      <p><strong>b</strong><em>i</em><br><hr><ul><li>x</li></ul></p></body></html>`;

    const result = checkHtmlPolicy(html, 'document', 'template.html');

    expect(result.errors).toEqual([]);
    expect([...result.cidReferences]).toEqual(['logo']);
  });

  it.each([
    ['<script>alert(1)</script>', 'FORBIDDEN_ELEMENT'],
    ['<iframe src="https://x"></iframe>', 'FORBIDDEN_ELEMENT'],
    ['<form action="/x"><input></form>', 'FORBIDDEN_ELEMENT'],
    ['<object data="x"></object>', 'FORBIDDEN_ELEMENT'],
    ['<link rel="stylesheet" href="https://x/a.css">', 'FORBIDDEN_ELEMENT'],
    ['<p onclick="x()">a</p>', 'FORBIDDEN_ATTRIBUTE'],
    ['<p onmouseover="x()">a</p>', 'FORBIDDEN_ATTRIBUTE'],
    ['<td background="https://x/y.png">a</td>', 'FORBIDDEN_ATTRIBUTE'],
    ['<p data-track="1">a</p>', 'FORBIDDEN_ATTRIBUTE'],
    ['<a href="javascript:alert(1)">x</a>', 'FORBIDDEN_URL'],
    ['<a href="data:text/html,x">x</a>', 'FORBIDDEN_URL'],
    ['<a href="{{link}}">x</a>', 'FORBIDDEN_URL'],
    ['<img src="https://tracker.example/pixel.gif">', 'EXTERNAL_IMAGE'],
    ['<img src="data:image/png;base64,AAAA">', 'EXTERNAL_IMAGE'],
    ['<p style="background: url(https://x/y.png)">a</p>', 'FORBIDDEN_CSS'],
    ['<p style="width: expression(alert(1))">a</p>', 'FORBIDDEN_CSS'],
    ['<style>@import url(https://x/a.css);</style>', 'FORBIDDEN_CSS'],
    ['<style>p { behavior: url(x.htc) }</style>', 'FORBIDDEN_CSS'],
    ['<p title="{{{raw}}}">a</p>', 'RAW_PLACEHOLDER_IN_ATTRIBUTE'],
    ['<{{tag}}>x</{{tag}}>', 'PLACEHOLDER_IN_MARKUP'],
    ['<p title={{x}}>a</p>', 'PLACEHOLDER_IN_MARKUP'],
    ['<p title=a{{x}}>a</p>', 'PLACEHOLDER_IN_MARKUP'],
    ['<p {{attr}}="1">a</p>', 'PLACEHOLDER_IN_MARKUP'],
    ['<style>p { color: {{c}} }</style>', 'PLACEHOLDER_IN_STYLE'],
    ['<!-- {{x}} --><p>a</p>', 'PLACEHOLDER_IN_COMMENT'],
  ])('rejects %s with %s', (html, code) => {
    expect(codes(html)).toContain(code);
  });

  it('accepts placeholders in text and in quoted attribute values', () => {
    expect(codes('<p>Totale = {{amount}} &lt; {{max}}</p>')).toEqual([]);
    expect(codes('<p>a < b {{x}}</p>')).toEqual([]);
    expect(codes(`<a href="https://x/{{id}}" title='{{t}}'>x</a>`)).toEqual([]);
    expect(codes('<style>p{color:red}</style><p>{{x}}</p>')).toEqual([]);
  });

  it('is case-insensitive on tags, attributes and schemes', () => {
    expect(codes('<SCRIPT>1</SCRIPT>')).toContain('FORBIDDEN_ELEMENT');
    expect(codes('<p ONCLICK="1">a</p>')).toContain('FORBIDDEN_ATTRIBUTE');
    expect(codes('<a href="JavaScript:1">a</a>')).toContain('FORBIDDEN_URL');
    expect(codes('<a href="  HTTPS://x">a</a>')).toEqual([]);
  });

  it('reports every problem, not just the first', () => {
    expect(codes('<script>1</script><p onclick="x">a</p><img src="https://x">')).toEqual([
      'FORBIDDEN_ELEMENT',
      'FORBIDDEN_ATTRIBUTE',
      'EXTERNAL_IMAGE',
    ]);
  });

  it('in fragment mode refuses document-level elements', () => {
    expect(codes('<table><tr><td>1</td></tr></table>', 'fragment')).toEqual([]);
    expect(codes('<html><body>x</body></html>', 'fragment')).toEqual([
      'FORBIDDEN_ELEMENT',
      'FORBIDDEN_ELEMENT',
    ]);
    expect(codes('<style>p{}</style>', 'fragment')).toEqual(['FORBIDDEN_ELEMENT']);
  });
});
