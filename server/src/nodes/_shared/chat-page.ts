import { escapeHtml, type Item } from '@flowforge/shared';

// Hosted chat page of the Chat Trigger (/chat/:id): one self-contained HTML file, no external resource.

export interface ChatPageOptions {
  title: string;
  subtitle: string;
  /** Greeting bubbles shown before the first message (one per line). */
  initialMessages: string[];
  placeholder: string;
  /** Hex color of the header, the send button and the visitor's bubbles. */
  accent: string;
  attribution: boolean;
  /** URL the page posts messages to (the page's own path). */
  action: string;
  mode: 'test' | 'production';
}

export const MAX_CHAT_INPUT_CHARS = 8000;

const SAFE_COLOR = /^#[0-9a-f]{6}$/i;

/** Keys looked up (in this order) in the last node's output to find the reply text. */
const REPLY_KEYS = ['output', 'text', 'reply', 'response', 'answer', 'message', 'content'];

function replyOf(json: Record<string, unknown>): string {
  for (const key of REPLY_KEYS) {
    const value = json[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  }
  const keys = Object.keys(json);
  if (keys.length === 1 && typeof json[keys[0]!] === 'string') return String(json[keys[0]!]);
  return keys.length ? JSON.stringify(json, null, 2) : '';
}

/** Text sent back to the chat: the reply field of every item of the last node, one paragraph per item. */
export function chatReply(items: Item[]): string {
  const texts = items.map((item) => replyOf(item.json as Record<string, unknown>)).filter((t) => t.trim());
  return texts.join('\n\n') || 'The workflow finished without a reply.';
}

/** Session ids come from the browser: keep only harmless ones. */
export function cleanSessionId(value: unknown): string | undefined {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[\w.-]{1,100}$/.test(id) ? id : undefined;
}

const CSS = `
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0d0f14;color:#e8eaf0;font-size:16px;line-height:1.45;-webkit-text-size-adjust:100%}
.app{display:flex;flex-direction:column;height:100vh;height:100dvh;max-width:760px;margin:0 auto;background:#12151c}
@media(min-width:800px){body{padding:24px 0}.app{height:calc(100dvh - 48px);border:1px solid #232836;border-radius:18px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.45)}}
header{display:flex;align-items:center;gap:12px;padding:14px 16px;padding-top:calc(14px + env(safe-area-inset-top));background:var(--accent);color:#fff}
header .avatar{flex:none;width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.2);display:grid;place-items:center;font-size:20px}
header h1{font-size:16.5px;margin:0;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
header p{margin:0;font-size:12.5px;opacity:.88;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
header .grow{flex:1;min-width:0}
header button{flex:none;background:rgba(255,255,255,.18);border:0;color:#fff;border-radius:9px;padding:8px 11px;font-size:13px;cursor:pointer}
header button:hover{background:rgba(255,255,255,.28)}
.banner{background:#3a2d0c;color:#ffd98a;font-size:12.5px;padding:6px 16px;text-align:center}
#log{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:9px;scroll-behavior:smooth}
.msg{max-width:84%;padding:10px 13px;border-radius:16px;white-space:pre-wrap;overflow-wrap:anywhere;animation:in .18s ease-out}
.msg.bot{align-self:flex-start;background:#1e2330;border-bottom-left-radius:5px}
.msg.user{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:5px}
.msg.error{align-self:flex-start;background:#3b1820;color:#ffb3bd;border:1px solid #6b2a36}
.msg code{background:rgba(0,0,0,.3);border-radius:5px;padding:1px 5px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em}
.msg a{color:inherit;text-decoration:underline}
.msg .retry{display:block;margin-top:8px;background:transparent;border:1px solid currentColor;color:inherit;border-radius:8px;padding:5px 10px;font-size:13px;cursor:pointer}
.typing{display:inline-flex;gap:4px;align-items:center;height:20px}
.typing i{width:7px;height:7px;border-radius:50%;background:#8b93a7;animation:dot 1.1s infinite}
.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}
@keyframes dot{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
form{display:flex;gap:8px;align-items:flex-end;padding:10px 12px;padding-bottom:calc(10px + env(safe-area-inset-bottom));border-top:1px solid #232836;background:#12151c}
textarea{flex:1;resize:none;min-height:44px;max-height:140px;padding:11px 13px;border-radius:14px;border:1px solid #2b3142;background:#0d0f14;color:inherit;font:inherit;outline:none}
textarea:focus{border-color:var(--accent)}
form button{flex:none;width:44px;height:44px;border-radius:50%;border:0;background:var(--accent);color:#fff;cursor:pointer;display:grid;place-items:center}
form button:disabled{opacity:.45;cursor:default}
footer{font-size:11px;color:#6d7488;text-align:center;padding:0 0 8px;background:#12151c}
`;

// Runs in the visitor's browser. Text is always inserted through textContent / escaped before formatting.
const SCRIPT = `
(function(){
var cfg=JSON.parse(document.getElementById('cfg').textContent);
var KEY='ff-chat:'+location.pathname;
var log=document.getElementById('log'),form=document.getElementById('f'),input=document.getElementById('q'),send=document.getElementById('send');
function uid(){var a=new Uint8Array(16);(window.crypto||window.msCrypto).getRandomValues(a);var s='';for(var i=0;i<a.length;i++)s+=('0'+a[i].toString(16)).slice(-2);return s}
var state;try{state=JSON.parse(localStorage.getItem(KEY)||'null')}catch(e){state=null}
if(!state||!state.sessionId||!Array.isArray(state.messages))state={sessionId:uid(),messages:[]};
function save(){try{localStorage.setItem(KEY,JSON.stringify({sessionId:state.sessionId,messages:state.messages.slice(-100)}))}catch(e){}}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function rich(s){return esc(s).replace(/\`([^\`\\n]+)\`/g,'<code>$1</code>').replace(/\\*\\*([^*\\n]+)\\*\\*/g,'<b>$1</b>').replace(/(https?:\\/\\/[^\\s<]+[^\\s<.,;:!?)\\]])/g,'<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')}
function bubble(role,text){var d=document.createElement('div');d.className='msg '+role;if(role==='bot')d.innerHTML=rich(text);else d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;return d}
function draw(){log.innerHTML='';for(var i=0;i<cfg.initialMessages.length;i++)bubble('bot',cfg.initialMessages[i]);for(var j=0;j<state.messages.length;j++)bubble(state.messages[j].role,state.messages[j].text)}
function grow(){input.style.height='auto';input.style.height=Math.min(input.scrollHeight,140)+'px'}
var busy=false;
function ask(text,keep){
  if(busy)return;busy=true;send.disabled=true;
  if(!keep){state.messages.push({role:'user',text:text});save();bubble('user',text)}
  var wait=bubble('bot','');wait.innerHTML='<span class="typing" aria-label="Typing"><i></i><i></i><i></i></span>';
  fetch(cfg.action,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({action:'sendMessage',sessionId:state.sessionId,chatInput:text})})
  .then(function(r){return r.json().catch(function(){return {}}).then(function(b){return {ok:r.ok,body:b}})})
  .then(function(r){
    wait.remove();
    if(!r.ok)throw new Error(r.body&&r.body.message||'Something went wrong. Please try again.');
    var out=String(r.body.output==null?'':r.body.output);
    state.messages.push({role:'bot',text:out});save();bubble('bot',out);
  })
  .catch(function(e){
    wait.remove();
    var b=bubble('error',e&&e.message&&e.message!=='Failed to fetch'?e.message:'No connection to the server. Check your network and try again.');
    var again=document.createElement('button');again.type='button';again.className='retry';again.textContent='Try again';
    again.onclick=function(){b.remove();ask(text,true)};b.appendChild(again);log.scrollTop=log.scrollHeight;
  })
  .then(function(){busy=false;send.disabled=false;input.focus()});
}
form.addEventListener('submit',function(e){e.preventDefault();var t=input.value.trim();if(!t||busy)return;input.value='';grow();ask(t)});
input.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();form.requestSubmit?form.requestSubmit():send.click()}});
input.addEventListener('input',grow);
document.getElementById('new').addEventListener('click',function(){if(busy)return;state={sessionId:uid(),messages:[]};save();draw();input.focus()});
draw();
})();
`;

export function renderChatPage(o: ChatPageOptions): string {
  const accent = SAFE_COLOR.test(o.accent) ? o.accent : '#f0592a';
  const config = JSON.stringify({ action: o.action, initialMessages: o.initialMessages }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="robots" content="noindex">
<title>${escapeHtml(o.title)}</title>
<style>:root{--accent:${accent}}${CSS}</style>
</head>
<body>
<div class="app">
<header>
<div class="avatar" aria-hidden="true">💬</div>
<div class="grow"><h1>${escapeHtml(o.title)}</h1>${o.subtitle ? `<p>${escapeHtml(o.subtitle)}</p>` : ''}</div>
<button type="button" id="new" title="Start a new conversation">New chat</button>
</header>
${o.mode === 'test' ? '<div class="banner">Test mode: this page answers one message per "Listen for test event".</div>' : ''}
<div id="log" role="log" aria-live="polite"></div>
<form id="f" autocomplete="off">
<textarea id="q" rows="1" maxlength="${MAX_CHAT_INPUT_CHARS}" placeholder="${escapeHtml(o.placeholder)}" aria-label="Message" required></textarea>
<button id="send" type="submit" aria-label="Send"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg></button>
</form>
${o.attribution ? '<footer>Powered by FlowForge</footer>' : ''}
</div>
<script type="application/json" id="cfg">${config}</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}
