import { isComment, isDirective, isTag, isText, type ChildNode, type Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';

import type { FieldError } from '../../common/errors/app-error';

/**
 * What a template may contain. A closed list: an element or attribute not in
 * it is a rejection, never something to strip. The message has legal value
 * and must go out exactly as the client wrote it, or not at all.
 *
 * The list is what e-mail clients render anyway (no script, no forms, no
 * frames), plus the presentational attributes that PEC templates written for
 * Outlook still rely on.
 */
const DOCUMENT_ELEMENTS = new Set(['html', 'head', 'body', 'title', 'meta', 'style']);

const CONTENT_ELEMENTS = new Set([
  'p',
  'br',
  'hr',
  'div',
  'span',
  'a',
  'img',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'strike',
  'small',
  'sub',
  'sup',
  'font',
  'center',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'caption',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'col',
  'colgroup',
  'blockquote',
  'pre',
  'code',
  'address',
  'abbr',
  'cite',
  'q',
]);

const GLOBAL_ATTRIBUTES = new Set([
  'id',
  'class',
  'style',
  'title',
  'lang',
  'dir',
  'align',
  'valign',
  'width',
  'height',
  'border',
  'bgcolor',
  'color',
  'cellpadding',
  'cellspacing',
  'colspan',
  'rowspan',
  'nowrap',
  'face',
  'size',
  'type',
  'start',
  'role',
  'xmlns',
]);

const ELEMENT_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(['href', 'target', 'rel', 'name']),
  img: new Set(['src', 'alt']),
  meta: new Set(['charset', 'content', 'http-equiv', 'name']),
  html: new Set(['xmlns:v', 'xmlns:o']),
};

const SAFE_HREF = /^(https?:|mailto:|#)/i;
const SAFE_IMG_SRC = /^cid:[A-Za-z0-9._-]{1,64}$/;

// CSS that fetches or executes: remote images (tracking), IE expressions, behaviors.
const FORBIDDEN_CSS = /url\s*\(|expression\s*\(|@import|behavior\s*:|javascript\s*:|-moz-binding/i;

export interface HtmlPolicyResult {
  readonly ok: boolean;
  readonly errors: readonly FieldError[];
  /** Every cid referenced by an <img src="cid:..."> */
  readonly cidReferences: ReadonlySet<string>;
}

export type HtmlPolicyMode = 'document' | 'fragment';

/**
 * @param mode 'document' for a template (html/head/body allowed), 'fragment'
 *   for the value of a raw placeholder (content elements only)
 * @param path where errors point to, e.g. "template.html" or "messages[3].vars.invoiceTable"
 */
export function checkHtmlPolicy(html: string, mode: HtmlPolicyMode, path: string): HtmlPolicyResult {
  const errors: FieldError[] = [];
  const cidReferences = new Set<string>();
  checkPlaceholderPositions(html, path, errors);
  const document = parseDocument(html, { lowerCaseTags: true, lowerCaseAttributeNames: true });

  const visit = (nodes: readonly ChildNode[]): void => {
    for (const node of nodes) {
      if (isTag(node)) {
        checkElement(node, mode, path, errors, cidReferences);
        visit(node.children);
      } else if (isText(node)) {
        // Text carries no behaviour; placeholder values land here escaped.
      } else if (isComment(node)) {
        // Comments (Outlook conditional comments included) are harmless as long
        // as no value can be inserted in them: a value could close the comment.
        if (node.data.includes('{{')) {
          errors.push({
            path,
            code: 'PLACEHOLDER_IN_COMMENT',
            detail: 'placeholders are not allowed inside comments',
          });
        }
      } else if (isDirective(node)) {
        if (!/^!doctype\s/i.test(node.data)) {
          errors.push({ path, code: 'FORBIDDEN_DIRECTIVE', detail: `<${node.data}> is not allowed` });
        }
      } else {
        errors.push({ path, code: 'FORBIDDEN_NODE', detail: `${node.type} nodes are not allowed` });
      }
    }
  };
  visit(document.children);

  return { ok: errors.length === 0, errors, cidReferences };
}

/**
 * Escaping protects a value only where HTML escaping means something: in text
 * and in a QUOTED attribute value. A placeholder inside the markup of a tag -
 * as its name, as an attribute name or as an unquoted attribute value - would
 * let a value add attributes or elements, so it is refused.
 *
 * A small scanner rather than the DOM: the parser does not say whether an
 * attribute value was quoted. It enters "tag" state only on a "<" that starts
 * a tag the way browsers see it (letter, "/", "!" or "?"), so "a < b" in text
 * stays text.
 */
function checkPlaceholderPositions(html: string, path: string, errors: FieldError[]): void {
  let state: 'text' | 'tag' | 'double' | 'single' | 'comment' = 'text';
  let flagged = false;

  for (let i = 0; i < html.length && !flagged; i += 1) {
    const char = html[i] ?? '';
    switch (state) {
      case 'text':
        if (char === '<') {
          if (html.startsWith('<!--', i)) {
            state = 'comment';
            i += 3;
          } else if (/[A-Za-z/!?]/.test(html[i + 1] ?? '')) {
            state = 'tag';
          }
        }
        break;
      case 'comment':
        if (html.startsWith('-->', i)) {
          state = 'text';
          i += 2;
        }
        break;
      case 'tag':
        if (char === '"') {
          state = 'double';
        } else if (char === "'") {
          state = 'single';
        } else if (char === '>') {
          state = 'text';
        } else if (char === '{' && html[i + 1] === '{') {
          errors.push({
            path,
            code: 'PLACEHOLDER_IN_MARKUP',
            detail: `offset ${String(i)}: a placeholder can only appear in text or inside a quoted attribute value`,
          });
          flagged = true;
        }
        break;
      case 'double':
        if (char === '"') {
          state = 'tag';
        }
        break;
      case 'single':
        if (char === "'") {
          state = 'tag';
        }
        break;
    }
  }
}

function checkElement(
  element: Element,
  mode: HtmlPolicyMode,
  path: string,
  errors: FieldError[],
  cidReferences: Set<string>,
): void {
  const name = element.name;
  const allowed = CONTENT_ELEMENTS.has(name) || (mode === 'document' && DOCUMENT_ELEMENTS.has(name));
  if (!allowed) {
    errors.push({ path, code: 'FORBIDDEN_ELEMENT', detail: `<${name}> is not allowed` });

    return;
  }

  if (name === 'style') {
    const css = element.children.map((child) => (isText(child) ? child.data : '')).join('');
    if (css.includes('{{')) {
      errors.push({
        path,
        code: 'PLACEHOLDER_IN_STYLE',
        detail: 'placeholders are not allowed inside <style>: CSS ignores HTML escaping',
      });
    }
    if (FORBIDDEN_CSS.test(css)) {
      errors.push({
        path,
        code: 'FORBIDDEN_CSS',
        detail: '<style> must not use url(), @import, expression() or behavior',
      });
    }
  }

  const specific = ELEMENT_ATTRIBUTES[name];
  for (const [attribute, value] of Object.entries(element.attribs)) {
    if (attribute.startsWith('on')) {
      errors.push({
        path,
        code: 'FORBIDDEN_ATTRIBUTE',
        detail: `<${name} ${attribute}> event handlers are not allowed`,
      });
      continue;
    }
    if (!GLOBAL_ATTRIBUTES.has(attribute) && specific?.has(attribute) !== true) {
      errors.push({ path, code: 'FORBIDDEN_ATTRIBUTE', detail: `<${name} ${attribute}> is not allowed` });
      continue;
    }
    if (value.includes('{{{')) {
      errors.push({
        path,
        code: 'RAW_PLACEHOLDER_IN_ATTRIBUTE',
        detail: `<${name} ${attribute}>: {{{...}}} is only allowed in text, use {{...}}`,
      });
      continue;
    }
    if (attribute === 'style' && FORBIDDEN_CSS.test(value)) {
      errors.push({
        path,
        code: 'FORBIDDEN_CSS',
        detail: `<${name} style> must not use url(), expression() or behavior`,
      });
      continue;
    }
    if (name === 'a' && attribute === 'href' && !SAFE_HREF.test(value.trim())) {
      errors.push({
        path,
        code: 'FORBIDDEN_URL',
        detail: `<a href> must start with https://, http://, mailto: or #`,
      });
      continue;
    }
    if (name === 'img' && attribute === 'src') {
      const source = value.trim();
      if (!SAFE_IMG_SRC.test(source)) {
        errors.push({
          path,
          code: 'EXTERNAL_IMAGE',
          detail: '<img src> must reference an inline image (cid:...); remote images are not allowed',
        });
        continue;
      }
      cidReferences.add(source.slice('cid:'.length));
    }
  }
}
