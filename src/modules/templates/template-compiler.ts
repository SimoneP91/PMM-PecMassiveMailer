import type { FieldError } from '../../common/errors/app-error';
import { checkHtmlPolicy } from './html-policy';
import {
  escapeHtml,
  parsePlaceholders,
  renderPlaceholders,
  toHeaderText,
  type Placeholder,
  type PlaceholderValues,
} from './placeholders';

export const MAX_RENDERED_SUBJECT_LENGTH = 500;

export interface TemplateInput {
  readonly subject: string;
  readonly html: string;
  readonly inlineImages: readonly { readonly cid: string; readonly part: string }[];
}

export interface CompiledTemplate {
  readonly subject: string;
  readonly html: string;
  /** Every placeholder a message must provide a value for, raw ones included. */
  readonly placeholders: readonly Placeholder[];
  readonly inlineImages: readonly { readonly cid: string; readonly part: string }[];
}

export interface Warning {
  readonly code: string;
  readonly detail?: string;
}

export type CompileResult =
  | { readonly ok: true; readonly template: CompiledTemplate; readonly warnings: readonly Warning[] }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

/**
 * Validates a template once per batch: placeholder syntax, HTML policy,
 * inline image references. What comes out is what every row renders against.
 */
export function compileTemplate(input: TemplateInput): CompileResult {
  const errors: FieldError[] = [];
  const warnings: Warning[] = [];

  const subject = parsePlaceholders(input.subject);
  for (const at of subject.malformedAt) {
    errors.push({
      path: 'template.subject',
      code: 'MALFORMED_PLACEHOLDER',
      detail: `unbalanced braces at offset ${String(at)}`,
    });
  }
  for (const placeholder of subject.placeholders) {
    if (placeholder.raw) {
      errors.push({
        path: 'template.subject',
        code: 'RAW_PLACEHOLDER_IN_SUBJECT',
        detail: `{{{${placeholder.name}}}} is not allowed in the subject, use {{${placeholder.name}}}`,
      });
    }
  }

  const body = parsePlaceholders(input.html);
  for (const at of body.malformedAt) {
    errors.push({
      path: 'template.html',
      code: 'MALFORMED_PLACEHOLDER',
      detail: `unbalanced braces at offset ${String(at)}`,
    });
  }

  const policy = checkHtmlPolicy(input.html, 'document', 'template.html');
  errors.push(...policy.errors);

  const declaredCids = new Set(input.inlineImages.map((image) => image.cid));
  for (const cid of policy.cidReferences) {
    if (!declaredCids.has(cid)) {
      errors.push({
        path: 'template.html',
        code: 'UNDECLARED_INLINE_IMAGE',
        detail: `<img src="cid:${cid}"> has no matching entry in template.inlineImages`,
      });
    }
  }
  input.inlineImages.forEach((image, i) => {
    if (!policy.cidReferences.has(image.cid)) {
      warnings.push({
        code: 'UNUSED_INLINE_IMAGE',
        detail: `template.inlineImages[${String(i)}] (cid:${image.cid}) is not referenced by the template`,
      });
    }
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const placeholders = mergePlaceholders(subject.placeholders, body.placeholders);
  if (placeholders.length === 0) {
    warnings.push({
      code: 'TEMPLATE_WITHOUT_PLACEHOLDERS',
      detail: 'every message will carry the same subject and body',
    });
  }

  return {
    ok: true,
    template: { subject: input.subject, html: input.html, placeholders, inlineImages: input.inlineImages },
    warnings,
  };
}

function mergePlaceholders(...lists: readonly (readonly Placeholder[])[]): Placeholder[] {
  const merged = new Map<string, Placeholder>();
  for (const list of lists) {
    for (const placeholder of list) {
      const existing = merged.get(placeholder.name);
      if (existing === undefined || (placeholder.raw && !existing.raw)) {
        merged.set(placeholder.name, placeholder);
      }
    }
  }

  return [...merged.values()];
}

export interface RenderedMessage {
  readonly subject: string;
  readonly html: string;
  readonly unusedVars: readonly string[];
}

export type RenderResult =
  | { readonly ok: true; readonly message: RenderedMessage }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

/**
 * @param path prefix for errors, e.g. "messages[12]"
 */
export function renderTemplate(
  template: CompiledTemplate,
  values: PlaceholderValues,
  path: string,
): RenderResult {
  const errors: FieldError[] = [];

  for (const placeholder of template.placeholders) {
    const value = values.get(placeholder.name);
    if (value === undefined) {
      errors.push({
        path: `${path}.vars.${placeholder.name}`,
        code: 'MISSING_PLACEHOLDER',
        detail: `${placeholder.name} is required by the template`,
      });
      continue;
    }
    if (placeholder.raw) {
      const policy = checkHtmlPolicy(value, 'fragment', `${path}.vars.${placeholder.name}`);
      for (const error of policy.errors) {
        errors.push({
          ...error,
          code: 'HTML_VALUE_REJECTED',
          detail: `{{{${placeholder.name}}}}: ${error.detail}`,
        });
      }
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const subject = toHeaderText(renderPlaceholders(template.subject, values, toHeaderText));
  if (subject.length === 0 || subject.length > MAX_RENDERED_SUBJECT_LENGTH) {
    return {
      ok: false,
      errors: [
        {
          path: `${path}.vars`,
          code: 'SUBJECT_LENGTH',
          detail: `rendered subject must be 1-${String(MAX_RENDERED_SUBJECT_LENGTH)} characters`,
        },
      ],
    };
  }

  const used = new Set(template.placeholders.map((placeholder) => placeholder.name));
  const unusedVars = [...values.keys()].filter((name) => !used.has(name));

  return {
    ok: true,
    message: { subject, html: renderPlaceholders(template.html, values, escapeHtml), unusedVars },
  };
}
