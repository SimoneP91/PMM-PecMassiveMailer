import { isComment, isDirective, isTag, isText, type ChildNode, type Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';

import type { FieldError } from '../../common/field-error';

/**
 * What the HTML of a PEC may contain. A closed list: an element or attribute
 * not in it is a rejection, never something to strip. The message has legal
 * value and must go out exactly as the sender wrote it, or not at all.
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

/**
 * @param path where errors point to, e.g. "html"
 */
export function checkHtmlPolicy(html: string, path: string): HtmlPolicyResult {
  const errors: FieldError[] = [];
  const cidReferences = new Set<string>();
  const document = parseDocument(html, { lowerCaseTags: true, lowerCaseAttributeNames: true });

  const visit = (nodes: readonly ChildNode[]): void => {
    for (const node of nodes) {
      if (isTag(node)) {
        checkElement(node, path, errors, cidReferences);
        visit(node.children);
      } else if (isText(node) || isComment(node)) {
        // Text and comments (Outlook conditional comments included) carry no behaviour.
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

function checkElement(
  element: Element,
  path: string,
  errors: FieldError[],
  cidReferences: Set<string>,
): void {
  const name = element.name;
  const allowed = CONTENT_ELEMENTS.has(name) || DOCUMENT_ELEMENTS.has(name);
  if (!allowed) {
    errors.push({ path, code: 'FORBIDDEN_ELEMENT', detail: `<${name}> is not allowed` });

    return;
  }

  if (name === 'style') {
    const css = element.children.map((child) => (isText(child) ? child.data : '')).join('');
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
