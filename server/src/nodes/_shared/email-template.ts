import { escapeHtml } from '@flowforge/shared';

/** Content of the "Designed Template" email format. */
export interface EmailTemplate {
  title: string;
  message: string;
  buttonText?: string;
  buttonUrl?: string;
  footer?: string;
  /** Accent colour (#rgb or #rrggbb). */
  color?: string;
}

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const DEFAULT_COLOR = '#f0592a';

const safeColor = (c?: string) => (c && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim()) ? c.trim() : DEFAULT_COLOR);
const safeUrl = (u?: string) => (u && /^(https?:\/\/|mailto:)/i.test(u.trim()) ? u.trim() : undefined);

/** Escapes text, then turns URLs into links and **text** into bold. */
function inline(text: string, color: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#14161f;">$1</strong>')
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, `<a href="$1" target="_blank" style="color:${color};text-decoration:underline;">$1</a>`);
}

/**
 * Responsive HTML email: table layout and inline styles (Gmail, Outlook, Apple Mail, mobile).
 * The card is 600 px wide on desktop and full width on phones.
 */
export function renderEmailHtml(t: EmailTemplate): string {
  const color = safeColor(t.color);
  const url = safeUrl(t.buttonUrl);
  const paragraphs = t.message
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .filter((p) => p.trim())
    .map((p) => `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:#3b4050;">${inline(p.trim(), color).replace(/\r?\n/g, '<br>')}</p>`)
    .join('\n');
  const button =
    url && t.buttonText?.trim()
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 6px;"><tr>
<td align="center" bgcolor="${color}" style="border-radius:10px;background-color:${color};">
<a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:16px;font-weight:700;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(t.buttonText.trim())}</a>
</td></tr></table>`
      : '';
  const footer = t.footer?.trim()
    ? `<tr><td align="center" style="padding:22px 16px 6px;font-family:${FONT};font-size:12.5px;line-height:1.6;color:#8a8fa0;">${inline(t.footer.trim(), '#8a8fa0').replace(/\r?\n/g, '<br>')}</td></tr>`
    : '';
  const preheader = escapeHtml(t.message.replace(/\s+/g, ' ').trim().slice(0, 140));
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(t.title)}</title>
<style>
@media only screen and (max-width:620px){.ff-card{padding:28px 22px!important}.ff-title{font-size:22px!important}.ff-outer{padding:16px 8px!important}}
</style>
</head>
<body style="margin:0;padding:0;background-color:#f2f3f7;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2f3f7;">
<tr><td align="center" class="ff-outer" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
<tr><td style="height:6px;line-height:6px;font-size:0;background-color:${color};border-radius:14px 14px 0 0;">&nbsp;</td></tr>
<tr><td class="ff-card" style="background-color:#ffffff;border-radius:0 0 14px 14px;padding:40px 44px 36px;">
<h1 class="ff-title" style="margin:0 0 18px;font-family:${FONT};font-size:26px;line-height:1.3;font-weight:700;color:#14161f;">${escapeHtml(t.title)}</h1>
${paragraphs}
${button}
</td></tr>
${footer}
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Plain-text version sent alongside the HTML (spam filters and text-only clients). */
export function renderEmailText(t: EmailTemplate): string {
  const url = safeUrl(t.buttonUrl);
  return [
    t.title.trim(),
    '',
    t.message.trim().replace(/\*\*(.+?)\*\*/g, '$1'),
    ...(url && t.buttonText?.trim() ? ['', `${t.buttonText.trim()}: ${url}`] : []),
    ...(t.footer?.trim() ? ['', '--', t.footer.trim()] : []),
  ].join('\n');
}
