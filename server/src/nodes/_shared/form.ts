import {
  FORM_HONEYPOT,
  isFormTheme,
  renderFormMessage,
  renderFormPage,
  validateFormSubmission,
  type BinaryRef,
  type FormFieldDef,
  type FormFileInfo,
  type FormRenderOptions,
  type FormTheme,
  type FormValidationResult,
} from '@flowforge/shared';
import type { WebhookResponse } from '../../engine/types.js';

/** Answers of public forms: JSON when the page submits with fetch(), HTML otherwise (no JavaScript). */
export const wantsJson = (headers: Record<string, string | undefined>) => /application\/json/i.test(headers.accept ?? '');

const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

export function formPageResponse(status: number, options: FormRenderOptions): WebhookResponse {
  return { statusCode: status, headers: HTML, body: renderFormPage(options) };
}

export interface FormSuccess {
  title: string;
  message: string;
  redirectUrl?: string;
  theme?: FormTheme;
  attribution?: boolean;
}

export function formSuccessResponse(json: boolean, s: FormSuccess): WebhookResponse {
  const redirect = s.redirectUrl && /^https?:\/\//i.test(s.redirectUrl) ? s.redirectUrl : undefined;
  if (json) return { statusCode: 200, body: { ok: true, title: s.title, message: s.message, ...(redirect ? { redirectUrl: redirect } : {}) } };
  if (redirect) return { statusCode: 303, redirect };
  return { statusCode: 200, headers: HTML, body: renderFormMessage({ title: s.title, message: s.message, theme: s.theme, attribution: s.attribution }) };
}

export function formErrorResponse(json: boolean, status: number, title: string, message: string, theme?: FormTheme): WebhookResponse {
  if (json) return { statusCode: status, body: { ok: false, message: `${title}. ${message}` } };
  return { statusCode: status, headers: HTML, body: renderFormMessage({ title, message, theme, tone: 'error' }) };
}

export const INVALID_MESSAGE = 'Please fix the highlighted fields.';

/** 400 with the error of each field (JSON) or the form shown again with the errors (HTML). */
export function formInvalidResponse(json: boolean, page: FormRenderOptions, result: FormValidationResult): WebhookResponse {
  if (json) return { statusCode: 400, body: { ok: false, message: INVALID_MESSAGE, errors: result.errors } };
  return formPageResponse(400, { ...page, values: result.raw, errors: result.errors, formError: INVALID_MESSAGE });
}

export const isBot = (body: unknown) => {
  const value = (body as Record<string, unknown> | null)?.[FORM_HONEYPOT];
  return value !== undefined && String(Array.isArray(value) ? value.join('') : value).trim() !== '';
};

export const themeOf = (value: unknown): FormTheme => (isFormTheme(value) ? value : 'midnight');

/** Query parameters as strings (prefill of hidden fields). */
export const queryStrings = (query: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(query).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : Array.isArray(v) && typeof v[0] === 'string' ? [[k, v[0]]] : [])));

export interface Upload {
  field: string;
  fileName: string;
  mimeType: string;
  data: Buffer;
}

/** Validates a submission; accepted files are stored and returned as the item's binary data. */
export async function processSubmission(
  fields: FormFieldDef[],
  body: unknown,
  uploads: Upload[],
  store: (data: Buffer, fileName?: string, mimeType?: string) => Promise<BinaryRef>,
): Promise<{ result: FormValidationResult; binary: Record<string, BinaryRef> }> {
  const data = new Map<FormFileInfo, Buffer>();
  const infos = uploads.map((u) => {
    const info: FormFileInfo = { field: u.field, fileName: u.fileName, mimeType: u.mimeType, size: u.data.length };
    data.set(info, u.data);
    return info;
  });
  const result = validateFormSubmission(fields, body && typeof body === 'object' ? (body as Record<string, unknown>) : {}, infos);
  const binary: Record<string, BinaryRef> = {};
  if (Object.keys(result.errors).length) return { result, binary };
  for (const group of result.files) {
    for (const [n, file] of group.files.entries()) {
      const key = group.multiple ? `${group.binaryKey}_${n}` : group.binaryKey;
      binary[key] = await store(data.get(file)!, file.fileName, file.mimeType || 'application/octet-stream');
    }
  }
  return { result, binary };
}
