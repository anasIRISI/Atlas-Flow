// Public forms (Form Trigger, Wait node "On Form Submitted"): field schema, HTML rendering and server-side
// validation. Shared so the editor's live preview renders exactly the page the server sends.

export type FormFieldType =
  | 'text'
  | 'email'
  | 'number'
  | 'textarea'
  | 'password'
  | 'dropdown'
  | 'radio'
  | 'checkbox'
  | 'date'
  | 'file'
  | 'hiddenField';

export interface FormFieldOption {
  option: string;
}

/** One form element (n8n-compatible keys). */
export interface FormFieldDef {
  /** Stable id used by the editor (drag & drop); not needed by the server. */
  id?: string;
  fieldLabel: string;
  fieldType?: FormFieldType;
  requiredField?: boolean;
  placeholder?: string;
  helpText?: string;
  defaultValue?: string;
  /** dropdown / radio / checkbox choices. A checkbox without choices is a single yes/no box. */
  fieldOptions?: { values?: FormFieldOption[] };
  /** file: allow several files. */
  multipleFiles?: boolean;
  /** file: accepted types, e.g. ".pdf, .jpg, image/*". */
  acceptFileTypes?: string;
  /** hiddenField: key in the output (default: the label) and value (can be overridden by ?name=… in the URL). */
  fieldName?: string;
  fieldValue?: string;
}

export const FORM_FIELD_TYPES: { value: FormFieldType; label: string; icon: string }[] = [
  { value: 'text', label: 'Text', icon: 'type' },
  { value: 'email', label: 'Email', icon: 'at-sign' },
  { value: 'number', label: 'Number', icon: 'hash' },
  { value: 'textarea', label: 'Long text', icon: 'text-align-start' },
  { value: 'dropdown', label: 'Select (dropdown)', icon: 'chevron-down' },
  { value: 'radio', label: 'Radio buttons', icon: 'circle-dot' },
  { value: 'checkbox', label: 'Checkboxes', icon: 'square-check' },
  { value: 'date', label: 'Date', icon: 'calendar' },
  { value: 'file', label: 'File upload', icon: 'paperclip' },
  { value: 'hiddenField', label: 'Hidden field', icon: 'eye-off' },
  { value: 'password', label: 'Password', icon: 'key-round' },
];

export const FIELD_TYPES_WITH_OPTIONS: FormFieldType[] = ['dropdown', 'radio', 'checkbox'];

export type FormTheme = 'midnight' | 'daylight' | 'sunset';

export const FORM_THEMES: { value: FormTheme; label: string; swatch: [string, string] }[] = [
  { value: 'midnight', label: 'Midnight', swatch: ['#17171c', '#f0592a'] },
  { value: 'daylight', label: 'Daylight', swatch: ['#ffffff', '#4f46e5'] },
  { value: 'sunset', label: 'Sunset', swatch: ['#ff5e8a', '#7c5cff'] },
];

/** Name of the invisible anti-bot field: humans never fill it. */
export const FORM_HONEYPOT = 'website';

/** Name of the HTML input of field `index`. */
export const formFieldKey = (index: number) => `field-${index}`;

/** Key of the field in the submission ($json). */
export const formOutputName = (field: FormFieldDef) =>
  (field.fieldType === 'hiddenField' ? field.fieldName?.trim() || field.fieldLabel : field.fieldLabel).trim();

/** Binary property used for an uploaded file ("CV" → "CV", "Your photo" → "Your_photo"). */
export function formBinaryKey(field: FormFieldDef, index: number): string {
  const key = field.fieldLabel.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return key || `file_${index}`;
}

/** Accepts `{ values: [...] }` (n8n format) or a plain array; drops entries without a label. */
export function normalizeFormFields(value: unknown): FormFieldDef[] {
  const list = Array.isArray(value) ? value : (value as { values?: unknown } | null)?.values;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (f): f is FormFieldDef =>
      !!f && typeof f === 'object' && typeof (f as FormFieldDef).fieldLabel === 'string' && (f as FormFieldDef).fieldLabel.trim() !== '',
  );
}

export const isFormTheme = (v: unknown): v is FormTheme => FORM_THEMES.some((t) => t.value === v);

const optionsOf = (f: FormFieldDef) => (f.fieldOptions?.values ?? []).map((o) => String(o?.option ?? '')).filter((o) => o !== '');

// ── Rendering ────────────────────────────────────────────────────────────────

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const multiline = (text: string) => escapeHtml(text).replace(/\r?\n/g, '<br>');

const THEME_VARS: Record<FormTheme, string> = {
  midnight: `color-scheme:dark;--bg:#0e0e12;--bg-image:radial-gradient(1100px 560px at 50% -12%,#3a1d12 0%,rgba(14,14,18,0) 62%),#0e0e12;
--card:#17171c;--fg:#ededf2;--muted:#a3a3b2;--line:#30303a;--input:#1e1e25;--accent:#f0592a;--accent-fg:#fff;--ring:rgba(240,89,42,.28);
--choice-on:rgba(240,89,42,.09);--err:#ff8a87;--err-bg:rgba(255,90,87,.1);--ok:#3ddc97;--ok-bg:rgba(61,220,151,.12);
--shadow:0 24px 60px rgba(0,0,0,.45);--foot:#70707f;--banner:#3a2412;--banner-fg:#ffc59a`,
  daylight: `color-scheme:light;--bg:#f2f3f8;--bg-image:linear-gradient(180deg,#e9ebff 0%,#f2f3f8 340px);
--card:#fff;--fg:#1b1d26;--muted:#5c6174;--line:#dde0ea;--input:#fbfbfd;--accent:#4f46e5;--accent-fg:#fff;--ring:rgba(79,70,229,.18);
--choice-on:#f1f0ff;--err:#d0312d;--err-bg:#fdecec;--ok:#12a150;--ok-bg:#e4f7ec;
--shadow:0 18px 50px rgba(30,35,70,.12);--foot:#8a8fa3;--banner:#fff2e0;--banner-fg:#9a4a00`,
  sunset: `color-scheme:light;--bg:#ff6f7d;--bg-image:linear-gradient(140deg,#ff9a5b 0%,#ff5e8a 48%,#7c5cff 100%);
--card:rgba(255,255,255,.97);--fg:#27172b;--muted:#6f5c74;--line:#ecdcea;--input:#fff;--accent:#ff4f7b;--accent-fg:#fff;--ring:rgba(255,79,123,.2);
--choice-on:#fff0f4;--err:#d3304c;--err-bg:#fdeaee;--ok:#12a150;--ok-bg:#e4f7ec;
--shadow:0 30px 70px rgba(70,20,60,.35);--foot:rgba(255,255,255,.9);--banner:#fff2e0;--banner-fg:#9a4a00`,
};

const STYLE = `*{box-sizing:border-box}html{background:var(--bg-image);background-color:var(--bg);min-height:100%;-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100dvh;color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
display:flex;justify-content:center;align-items:flex-start;padding:16px 14px 28px}
@media(min-width:640px){body{align-items:center;padding:40px 24px}}
.wrap{width:100%;max-width:560px}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px 20px 26px;box-shadow:var(--shadow);animation:rise .35s ease-out}
@media(min-width:640px){.card{padding:36px 38px 34px}}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.banner{display:flex;gap:8px;align-items:center;background:var(--banner);color:var(--banner-fg);border-radius:10px;padding:8px 12px;font-size:13px;font-weight:600;margin:0 0 18px}
h1{font-size:25px;line-height:1.25;margin:0 0 8px;letter-spacing:-.015em}
.desc{color:var(--muted);margin:0}
form{margin:0}
.field{margin:22px 0 0;border:0;padding:0;min-width:0}
.lbl{display:block;font-weight:650;font-size:14.5px;margin:0 0 8px;padding:0}
.req{color:var(--accent);margin-left:2px}
input,textarea,select{width:100%;font:inherit;font-size:16px;color:var(--fg);background:var(--input);border:1.5px solid var(--line);border-radius:11px;
padding:12px 14px;min-height:50px;transition:border-color .15s,box-shadow .15s;-webkit-appearance:none;appearance:none}
textarea{min-height:128px;resize:vertical}
input[type=date]{min-width:0}
select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' fill='none' stroke='%23888' stroke-width='2' viewBox='0 0 24 24'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
background-repeat:no-repeat;background-position:right 12px center;padding-right:42px}
input::placeholder,textarea::placeholder{color:var(--muted);opacity:.75}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 4px var(--ring)}
.choices{display:grid;gap:9px}
.choice{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1.5px solid var(--line);border-radius:11px;background:var(--input);cursor:pointer;font-weight:500;min-height:50px;transition:border-color .15s,background .15s}
.choice input{width:20px;height:20px;min-height:0;margin:0;padding:0;flex:none;accent-color:var(--accent);-webkit-appearance:auto;appearance:auto;box-shadow:none}
.choice:has(input:checked){border-color:var(--accent);background:var(--choice-on)}
.choice:has(input:focus-visible){box-shadow:0 0 0 4px var(--ring)}
.file{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border:2px dashed var(--line);border-radius:13px;
padding:22px 16px;text-align:center;color:var(--muted);background:var(--input);cursor:pointer;transition:border-color .15s}
.file:hover,.file:focus-within{border-color:var(--accent)}
.file input{position:absolute;inset:0;opacity:0;cursor:pointer;min-height:0;height:100%}
.file strong{color:var(--fg);font-size:15px}.file small{font-size:12.5px}
.file.has-files{border-style:solid;border-color:var(--accent);color:var(--fg)}
.help{color:var(--muted);font-size:13.5px;margin:7px 0 0}
.err{color:var(--err);font-size:13.5px;margin:7px 0 0;font-weight:550}
.err:empty{display:none}
.invalid input,.invalid textarea,.invalid select,.invalid .choice,.invalid .file{border-color:var(--err)}
.form-error{background:var(--err-bg);color:var(--err);border-radius:11px;padding:11px 14px;margin:20px 0 0;font-size:14px;font-weight:550}
.form-error:empty{display:none}
.submit{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:28px;width:100%;min-height:54px;border:0;border-radius:13px;background:var(--accent);
color:var(--accent-fg);font:inherit;font-weight:700;font-size:16.5px;cursor:pointer;box-shadow:0 10px 24px -10px var(--accent);transition:transform .1s,filter .15s}
.submit:hover{filter:brightness(1.07)}.submit:active{transform:translateY(1px)}
.submit:focus-visible{outline:none;box-shadow:0 0 0 4px var(--ring)}
.submit.busy{opacity:.8;pointer-events:none}
.submit.busy::before{content:"";width:18px;height:18px;border-radius:50%;border:2.5px solid currentColor;border-right-color:transparent;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.hp{position:absolute!important;left:-10000px!important;width:1px;height:1px;overflow:hidden}
.foot{text-align:center;color:var(--foot);font-size:12.5px;margin:18px 0 0}
.done{text-align:center;padding:10px 0 4px}
.done .icon{width:76px;height:76px;border-radius:50%;margin:2px auto 18px;display:grid;place-items:center;background:var(--ok-bg);color:var(--ok);animation:pop .45s cubic-bezier(.2,1.6,.4,1)}
.done.bad .icon{background:var(--err-bg);color:var(--err)}
.done .icon svg{width:38px;height:38px}
.done h1{margin-bottom:10px}
@keyframes pop{from{transform:scale(.4);opacity:0}to{transform:scale(1);opacity:1}}
.toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:#111;color:#fff;padding:10px 16px;border-radius:10px;font-size:14px;box-shadow:0 10px 30px rgba(0,0,0,.3)}
.confetti{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:10}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;

const ICON_OK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const ICON_BAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 7v6M12 17h.01"/><circle cx="12" cy="12" r="10"/></svg>`;

// Progressive enhancement: submit with fetch to show field errors in place and celebrate with confetti.
// Without JavaScript the form posts normally and the server renders the same states.
const SCRIPT = `(function(){
function confetti(){if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)return;
var c=document.createElement('canvas');c.className='confetti';document.body.appendChild(c);var x=c.getContext('2d');if(!x)return;
var d=window.devicePixelRatio||1,W=0,H=0;function size(){W=c.width=innerWidth*d;H=c.height=innerHeight*d}size();addEventListener('resize',size);
var C=['#f0592a','#ffb547','#3ddc97','#4ea8ff','#c084fc','#ff5d8f'],P=[];
for(var i=0;i<170;i++)P.push({x:W/2+(Math.random()-.5)*W*.25,y:H*.38,vx:(Math.random()-.5)*18*d,vy:(-Math.random()*15-6)*d,s:(7+Math.random()*6)*d,r:Math.random()*6.3,vr:(Math.random()-.5)*.3,c:C[i%C.length],k:i%3});
var t0=performance.now();(function tick(t){var e=t-t0;x.clearRect(0,0,W,H);x.globalAlpha=Math.max(0,1-e/3800);
P.forEach(function(p){p.vy+=.38*d;p.vx*=.99;p.x+=p.vx;p.y+=p.vy;p.r+=p.vr;x.save();x.translate(p.x,p.y);x.rotate(p.r);x.fillStyle=p.c;
if(p.k===0)x.fillRect(-p.s/2,-p.s/4,p.s,p.s/2);else if(p.k===1){x.beginPath();x.arc(0,0,p.s/3,0,6.3);x.fill()}else x.fillRect(-p.s/4,-p.s/2,p.s/2,p.s);x.restore()});
if(e<3900)requestAnimationFrame(tick);else c.remove()})(t0)}
if(document.body.getAttribute('data-confetti'))setTimeout(confetti,150);
[].forEach.call(document.querySelectorAll('.file input[type=file]'),function(inp){inp.addEventListener('change',function(){
var box=inp.parentNode,out=box.querySelector('strong'),n=[].map.call(inp.files||[],function(f){return f.name});
out.textContent=n.length?n.join(', '):out.getAttribute('data-empty');box.classList.toggle('has-files',n.length>0)})});
var form=document.querySelector('form[data-ff]');if(!form)return;var mode=form.getAttribute('data-mode');
var box=document.querySelector('.form-error');
function toast(m){var t=document.createElement('div');t.className='toast';t.textContent=m;document.body.appendChild(t);setTimeout(function(){t.remove()},2600)}
function clear(){[].forEach.call(form.querySelectorAll('.invalid'),function(f){f.classList.remove('invalid')});
[].forEach.call(form.querySelectorAll('.err'),function(e){e.textContent=''});if(box)box.textContent=''}
function show(errors){var first=null;Object.keys(errors).forEach(function(k){var f=form.querySelector('[data-field="'+k+'"]');if(!f)return;
f.classList.add('invalid');var e=f.querySelector('.err');if(e)e.textContent=errors[k];if(!first)first=f});
if(first){first.scrollIntoView({behavior:'smooth',block:'center'});var i=first.querySelector('input,textarea,select');if(i)i.focus({preventScroll:true})}}
function success(b){var card=document.querySelector('.card');card.innerHTML='<div class="done"><div class="icon">${ICON_OK}</div><h1></h1><p class="desc"></p></div>';
card.querySelector('h1').textContent=b.title||'Thank you!';card.querySelector('.desc').textContent=b.message||'';window.scrollTo(0,0);confetti()}
form.addEventListener('submit',function(ev){
if(mode==='preview'){ev.preventDefault();toast('Preview only: open the form URL to submit it.');return}
if(!window.fetch||!window.FormData)return;ev.preventDefault();
var btn=form.querySelector('.submit');btn.classList.add('busy');btn.disabled=true;clear();
function done(){btn.classList.remove('busy');btn.disabled=false}
fetch(form.getAttribute('action'),{method:'POST',body:new FormData(form),headers:{Accept:'application/json'},credentials:'same-origin'})
.then(function(r){return r.json().catch(function(){return{ok:false,message:'Unexpected answer from the server (HTTP '+r.status+').'}})})
.then(function(b){done();if(b.ok){if(b.redirectUrl){location.href=b.redirectUrl;return}success(b);return}
if(b.errors)show(b.errors);if(box)box.textContent=b.message||'Please fix the highlighted fields.'},
function(){done();if(box)box.textContent='Could not reach the server. Check your connection and try again.'})})})();`;

function page(title: string, theme: FormTheme, inner: string, attribution: boolean, extraBodyAttrs = ''): string {
  return `<!doctype html>
<html lang="en" style="${THEME_VARS[theme].replace(/\n/g, '')}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">
<meta name="theme-color" content="${theme === 'midnight' ? '#0e0e12' : theme === 'daylight' ? '#f2f3f8' : '#ff5e8a'}">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body data-theme="${theme}"${extraBodyAttrs}><div class="wrap"><main class="card">${inner}</main>
${attribution ? '<p class="foot">Powered by FlowForge</p>' : ''}</div><script>${SCRIPT}</script></body></html>`;
}

export interface FormRenderOptions {
  title: string;
  description?: string;
  fields: FormFieldDef[];
  /** URL the form posts to. */
  action: string;
  theme?: FormTheme;
  buttonLabel?: string;
  /** Values to show again after a validation error, keyed by field key ("field-0"). */
  values?: Record<string, string | string[]>;
  /** Field errors, keyed by field key. */
  errors?: Record<string, string>;
  /** Message above the submit button (e.g. "Too many requests"). */
  formError?: string;
  /** Query string of the page: prefills hidden fields (and other fields by label). */
  query?: Record<string, string>;
  /** "Powered by FlowForge" footer (default true). */
  attribution?: boolean;
  /** test: banner telling it is a test form; preview: the editor's live preview (no submission). */
  mode?: 'production' | 'test' | 'waiting' | 'preview';
}

function renderField(f: FormFieldDef, index: number, o: FormRenderOptions): string {
  const key = formFieldKey(index);
  const type = f.fieldType ?? 'text';
  const submitted = o.values?.[key];
  const prefill = o.query?.[formOutputName(f)];
  const value = submitted ?? prefill ?? (type === 'hiddenField' ? (f.fieldValue ?? '') : (f.defaultValue ?? ''));
  const text = Array.isArray(value) ? String(value[0] ?? '') : String(value);
  const error = `<p class="err" id="${key}-err" role="alert">${escapeHtml(o.errors?.[key] ?? '')}</p>`;
  const help = f.helpText ? `<p class="help" id="${key}-help">${multiline(f.helpText)}</p>` : '';
  const req = f.requiredField ? '<span class="req" aria-hidden="true">*</span>' : '';
  const aria = ` aria-describedby="${f.helpText ? `${key}-help ` : ''}${key}-err"${f.requiredField ? ' aria-required="true"' : ''}`;
  const placeholder = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : '';
  const invalid = o.errors?.[key] ? ' invalid' : '';
  const label = `<label class="lbl" for="${key}">${escapeHtml(f.fieldLabel)}${req}</label>`;
  const wrap = (inner: string) => `<div class="field${invalid}" data-field="${key}">${inner}${help}${error}</div>`;

  switch (type) {
    case 'hiddenField':
      return `<input type="hidden" name="${key}" value="${escapeHtml(text)}">`;
    case 'textarea':
      return wrap(`${label}<textarea id="${key}" name="${key}" rows="5"${placeholder}${aria}>${escapeHtml(text)}</textarea>`);
    case 'dropdown': {
      const options = optionsOf(f)
        .map((opt) => `<option value="${escapeHtml(opt)}"${opt === text ? ' selected' : ''}>${escapeHtml(opt)}</option>`)
        .join('');
      return wrap(`${label}<select id="${key}" name="${key}"${aria}><option value="">${escapeHtml(f.placeholder || 'Choose…')}</option>${options}</select>`);
    }
    case 'radio':
    case 'checkbox': {
      const choices = optionsOf(f);
      if (type === 'checkbox' && choices.length === 0) {
        const checked = text === 'true' || text === 'on';
        return wrap(
          `<label class="choice"><input type="checkbox" id="${key}" name="${key}" value="true"${checked ? ' checked' : ''}${aria}><span>${escapeHtml(f.fieldLabel)}${req}</span></label>`,
        );
      }
      const selected = new Set(Array.isArray(value) ? value.map(String) : text ? [text] : []);
      const inputs = choices
        .map(
          (opt, i) =>
            `<label class="choice"><input type="${type}" name="${key}" value="${escapeHtml(opt)}"${i === 0 ? ` id="${key}"` : ''}${selected.has(opt) ? ' checked' : ''}><span>${escapeHtml(opt)}</span></label>`,
        )
        .join('');
      return `<fieldset class="field${invalid}" data-field="${key}"${aria}><legend class="lbl">${escapeHtml(f.fieldLabel)}${req}</legend><div class="choices">${inputs}</div>${help}${error}</fieldset>`;
    }
    case 'file': {
      const accept = f.acceptFileTypes?.trim() ? ` accept="${escapeHtml(f.acceptFileTypes.trim())}"` : '';
      const empty = f.multipleFiles ? 'Tap to choose files' : 'Tap to choose a file';
      return wrap(
        `${label}<div class="file"><input type="file" id="${key}" name="${key}"${f.multipleFiles ? ' multiple' : ''}${accept}${aria}>` +
          `<strong data-empty="${empty}">${empty}</strong><small>${escapeHtml(f.acceptFileTypes?.trim() || 'Any file type')}</small></div>`,
      );
    }
    default: {
      const htmlType = ['email', 'number', 'password', 'date'].includes(type) ? type : 'text';
      const extra = type === 'email' ? ' autocomplete="email" inputmode="email"' : type === 'number' ? ' inputmode="decimal" step="any"' : '';
      return wrap(`${label}<input id="${key}" name="${key}" type="${htmlType}" value="${escapeHtml(text)}"${placeholder}${extra}${aria}>`);
    }
  }
}

/** The public form page (mobile-first, works without JavaScript). */
export function renderFormPage(o: FormRenderOptions): string {
  const theme = o.theme && isFormTheme(o.theme) ? o.theme : 'midnight';
  const hasFile = o.fields.some((f) => f.fieldType === 'file');
  const banner =
    o.mode === 'test'
      ? '<div class="banner">🧪 Test form: submitting it runs the workflow in the editor.</div>'
      : o.mode === 'preview'
        ? '<div class="banner">👀 Live preview</div>'
        : '';
  const fields = o.fields.map((f, i) => renderField(f, i, o)).join('\n');
  const inner = `${banner}<h1>${escapeHtml(o.title || 'Form')}</h1>${o.description ? `<p class="desc">${multiline(o.description)}</p>` : ''}
<form method="post" action="${escapeHtml(o.action)}" enctype="${hasFile ? 'multipart/form-data' : 'application/x-www-form-urlencoded'}" novalidate data-ff data-mode="${o.mode ?? 'production'}">
${fields}
<div class="hp" aria-hidden="true"><label>Leave this empty<input type="text" name="${FORM_HONEYPOT}" tabindex="-1" autocomplete="off"></label></div>
<p class="form-error" role="alert">${escapeHtml(o.formError ?? '')}</p>
<button type="submit" class="submit"><span>${escapeHtml(o.buttonLabel || 'Submit')}</span></button></form>`;
  return page(o.title || 'Form', theme, inner, o.attribution !== false);
}

export interface FormMessageOptions {
  title: string;
  message: string;
  theme?: FormTheme;
  attribution?: boolean;
  /** Success page with confetti (default), or a notice / error page. */
  tone?: 'success' | 'notice' | 'error';
}

/** Success, "form closed" and error pages. */
export function renderFormMessage(o: FormMessageOptions): string {
  const theme = o.theme && isFormTheme(o.theme) ? o.theme : 'midnight';
  const tone = o.tone ?? 'success';
  const icon = tone === 'success' ? ICON_OK : ICON_BAD;
  const inner = `<div class="done${tone === 'success' ? '' : ' bad'}"><div class="icon">${icon}</div><h1>${escapeHtml(o.title)}</h1><p class="desc">${multiline(o.message)}</p></div>`;
  return page(o.title, theme, inner, o.attribution !== false, tone === 'success' ? ' data-confetti="1"' : '');
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface FormFileInfo {
  field: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface FormValidationResult {
  /** Submission keyed by field label (hidden fields: their name). Files: { filename, mimetype, size }. */
  values: Record<string, unknown>;
  /** Error message per field key ("field-0"). Empty when the submission is valid. */
  errors: Record<string, string>;
  /** What was typed, to fill the form again after an error. */
  raw: Record<string, string | string[]>;
  /** Accepted uploads per file field, with the binary property they go to. */
  files: Array<{ index: number; binaryKey: string; multiple: boolean; files: FormFileInfo[] }>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 10_000;
const MAX_LONG_TEXT = 50_000;

function accepts(pattern: string, file: FormFileInfo): boolean {
  const rules = pattern
    .split(',')
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  if (!rules.length) return true;
  const name = file.fileName.toLowerCase();
  const mime = file.mimeType.toLowerCase();
  return rules.some((rule) => {
    if (rule.startsWith('.')) return name.endsWith(rule);
    if (rule.endsWith('/*')) return mime.startsWith(rule.slice(0, -1));
    if (rule.includes('/')) return mime === rule;
    return name.endsWith(`.${rule}`);
  });
}

/** Server-side validation of a submission against the field schema. */
export function validateFormSubmission(fields: FormFieldDef[], body: Record<string, unknown>, uploads: FormFileInfo[] = []): FormValidationResult {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const raw: Record<string, string | string[]> = {};
  const files: FormValidationResult['files'] = [];

  fields.forEach((f, i) => {
    const key = formFieldKey(i);
    const type = f.fieldType ?? 'text';
    const name = formOutputName(f);
    const input = body[key];
    const list = (Array.isArray(input) ? input : input === undefined || input === null ? [] : [input]).map((v) => String(v));
    const text = (list[0] ?? '').trim();

    if (type === 'file') {
      const given = uploads.filter((u) => u.field === key && u.fileName);
      if (!given.length) {
        if (f.requiredField) errors[key] = 'Please choose a file';
        values[name] = f.multipleFiles ? [] : null;
        return;
      }
      if (!f.multipleFiles && given.length > 1) {
        errors[key] = 'Only one file is allowed';
        return;
      }
      const rejected = f.acceptFileTypes ? given.find((u) => !accepts(f.acceptFileTypes!, u)) : undefined;
      if (rejected) {
        errors[key] = `"${rejected.fileName}" is not an accepted file type (${f.acceptFileTypes})`;
        return;
      }
      const meta = given.map((u) => ({ filename: u.fileName, mimetype: u.mimeType, size: u.size }));
      values[name] = f.multipleFiles ? meta : meta[0];
      files.push({ index: i, binaryKey: formBinaryKey(f, i), multiple: !!f.multipleFiles, files: given });
      return;
    }

    if (type === 'hiddenField') {
      values[name] = list.length ? (list[0] ?? '') : (f.fieldValue ?? '');
      return;
    }

    const choices = optionsOf(f);
    if (type === 'checkbox' && choices.length > 0) {
      const picked = list.map((v) => v.trim()).filter(Boolean);
      raw[key] = picked;
      if (picked.some((p) => !choices.includes(p))) errors[key] = 'Choose among the listed options';
      else if (f.requiredField && picked.length === 0) errors[key] = 'Choose at least one option';
      values[name] = picked;
      return;
    }
    if (type === 'checkbox') {
      const checked = text === 'true' || text === 'on';
      raw[key] = checked ? 'true' : '';
      if (f.requiredField && !checked) errors[key] = 'This box must be checked';
      values[name] = checked;
      return;
    }

    raw[key] = text;
    if (!text) {
      if (f.requiredField) errors[key] = type === 'dropdown' || type === 'radio' ? 'Please choose an option' : 'This field is required';
      values[name] = type === 'number' ? null : '';
      return;
    }
    if (text.length > (type === 'textarea' ? MAX_LONG_TEXT : MAX_TEXT)) errors[key] = 'This answer is too long';
    else if (type === 'email' && !EMAIL.test(text)) errors[key] = 'Enter a valid email address, like name@example.com';
    else if (type === 'number' && !Number.isFinite(Number(text))) errors[key] = 'Enter a number';
    else if (type === 'date' && (!DATE.test(text) || Number.isNaN(Date.parse(text)))) errors[key] = 'Enter a valid date (YYYY-MM-DD)';
    else if ((type === 'dropdown' || type === 'radio') && choices.length && !choices.includes(text)) errors[key] = 'Choose one of the options';
    values[name] = type === 'number' ? Number(text) : text;
  });

  return { values, errors, raw, files };
}
