// Offline fallback: when Gemini cannot be used, pick the closest ready-made template. Deterministic (no randomness,
// no network): keyword overlap with a small synonym map + TF-IDF cosine over the template texts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeRegistry } from '../../nodes/registry.js';
import { BUILT_IN_TEMPLATES, type RawConnection, type RawNode, type RawWorkflow } from './templates.js';

/** Under this score the template matches the prompt badly (chosen from the sample prompts of the test table). */
export const WEAK_SCORE = 0.3;

export interface TemplateCandidate {
  id: string;
  name: string;
  description: string;
  /** Text the scorer reads: name, description, node names / types / keywords. */
  text: string;
  workflow: RawWorkflow;
}

export interface RankedTemplate {
  template: TemplateCandidate;
  score: number;
  weak: boolean;
}

// ── tokens ──────────────────────────────────────────────────────────────────

const STOP = new Set(
  (
    'a an the and or of to in on at for with by from into onto is are be it its this that these those my me i we you your our their ' +
    'please can could would should want need make build create workflow automation automate flow when then if so as do does ' +
    'le la les un une des du de et ou en au aux par pour avec sur dans mon ma mes moi je tu il nous vous est que qui ce cet cette ' +
    'quand puis si fais faire cree creer veux voudrais besoin'
  ).split(' '),
);

/** concept → words (already lower-case, no accents). French words are included on purpose. */
const SYNONYMS: Record<string, string> = {};
function group(concept: string, words: string) {
  SYNONYMS[concept] = concept;
  for (const w of words.split(' ')) SYNONYMS[w] = concept;
}
group('email', 'mail gmail smtp inbox courriel mel outlook e-mail');
group('weather', 'forecast temperature meteo rain climate sunny wind');
group('chat', 'chatbot bot assistant conversation converse talk faq support');
group('form', 'survey contact questionnaire formulaire registration signup submission submit');
group('schedule', 'every daily morning hourly weekly cron periodic recurring timer chaque quotidien matin jour tous minute');
group('alert', 'notify notification warn warning alarm alerte notifier');
group('monitor', 'uptime down outage check status watch panne surveiller surveillance ping availability');
group('website', 'site web webpage page url domain');
group('send', 'post push deliver envoie envoyer envoi');
group('rss', 'feed atom news blog article actualite');
group('respond', 'response reply answer repondre reponse return');
group('webhook', 'hook endpoint callback');
group('http', 'request api fetch download rest');
group('ai', 'gemini llm gpt intelligence');
group('code', 'javascript script');

const stripAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

function canonical(word: string): string {
  const direct = SYNONYMS[word];
  if (direct) return direct;
  let stem = word;
  if (stem.length > 5 && stem.endsWith('ing')) stem = stem.slice(0, -3);
  else if (stem.length > 3 && stem.endsWith('s') && !stem.endsWith('ss')) stem = stem.slice(0, -1);
  return SYNONYMS[stem] ?? stem;
}

export function tokenize(text: string): string[] {
  return stripAccents(text.replace(/([a-z])([A-Z])/g, '$1 $2'))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(canonical);
}

// ── scoring ─────────────────────────────────────────────────────────────────

function counts(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Scores every template for the prompt, best first (ties: by id, so the order is always the same). */
export function rankTemplates(prompt: string, templates: TemplateCandidate[]): RankedTemplate[] {
  const docs = templates.map((t) => counts(tokenize(t.text)));
  const n = templates.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const term of d.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const idf = (term: string) => Math.log((n + 1) / ((df.get(term) ?? 0) + 1)) + 1;

  const query = counts(tokenize(prompt));
  const weight = (c: Map<string, number>) => new Map([...c].map(([t, f]) => [t, (1 + Math.log(f)) * idf(t)]));
  const q = weight(query);
  const qNorm = Math.sqrt([...q.values()].reduce((s, v) => s + v * v, 0));
  const qTotal = [...query.keys()].reduce((s, t) => s + idf(t), 0);

  return templates
    .map((template, i) => {
      const d = weight(docs[i]!);
      const dNorm = Math.sqrt([...d.values()].reduce((s, v) => s + v * v, 0));
      let dot = 0;
      let matched = 0;
      for (const [term, w] of q) {
        const dw = d.get(term);
        if (dw !== undefined) {
          dot += w * dw;
          matched += idf(term);
        }
      }
      const cosine = qNorm && dNorm ? dot / (qNorm * dNorm) : 0;
      const overlap = qTotal ? matched / qTotal : 0;
      const score = Math.round((0.5 * overlap + 0.5 * cosine) * 1000) / 1000;
      return { template, score, weak: score < WEAK_SCORE };
    })
    .sort((a, b) => b.score - a.score || a.template.id.localeCompare(b.template.id));
}

// ── templates ───────────────────────────────────────────────────────────────

interface ExampleFile {
  name?: unknown;
  meta?: { description?: unknown };
  nodes?: { name?: unknown; type?: unknown; parameters?: unknown; onError?: unknown }[];
  connections?: Record<string, Record<string, { node?: unknown; type?: unknown; index?: unknown }[][]>>;
}

/** An example file (FlowForge / n8n JSON) in the shape the validator reads. Sticky notes are left out. */
export function exampleToRaw(file: ExampleFile): RawWorkflow | undefined {
  if (!Array.isArray(file.nodes)) return undefined;
  const nodes: RawNode[] = [];
  for (const n of file.nodes) {
    if (typeof n?.name !== 'string' || typeof n.type !== 'string' || n.type === 'flowforge.stickyNote') continue;
    const onError = n.onError === 'stopWorkflow' || n.onError === 'continueRegularOutput' || n.onError === 'continueErrorOutput' ? n.onError : undefined;
    nodes.push({ name: n.name, type: n.type, parameters: typeof n.parameters === 'object' && n.parameters ? (n.parameters as Record<string, unknown>) : {}, ...(onError ? { onError } : {}) });
  }
  const names = new Set(nodes.map((n) => n.name));
  const connections: RawConnection[] = [];
  for (const [from, byType] of Object.entries(file.connections ?? {})) {
    for (const [type, lists] of Object.entries(byType ?? {})) {
      if (!['main', 'ai_languageModel', 'ai_memory', 'ai_tool'].includes(type) || !Array.isArray(lists)) continue;
      lists.forEach((targets, fromOutput) => {
        for (const t of Array.isArray(targets) ? targets : []) {
          if (typeof t?.node !== 'string' || !names.has(from) || !names.has(t.node)) continue;
          connections.push({ from, to: t.node, type: type as RawConnection['type'], ...(type === 'main' ? { fromOutput, toInput: typeof t.index === 'number' ? t.index : 0 } : {}) });
        }
      });
    }
  }
  return { name: typeof file.name === 'string' ? file.name : 'Workflow', nodes, connections };
}

function nodeWords(raw: RawWorkflow, registry: NodeRegistry): string {
  return raw.nodes
    .map((n) => {
      const type = registry.get(n.type)?.description;
      return `${n.name} ${n.type.slice(n.type.indexOf('.') + 1)} ${type?.displayName ?? ''} ${(type?.keywords ?? []).join(' ')}`;
    })
    .join(' ');
}

/** Files of `examples/` + the built-in templates. Unreadable files are skipped. */
export function loadTemplates(examplesDir: string, registry: NodeRegistry): TemplateCandidate[] {
  const out: TemplateCandidate[] = [];
  if (existsSync(examplesDir)) {
    for (const file of readdirSync(examplesDir).filter((f) => f.endsWith('.json')).sort()) {
      try {
        const data = JSON.parse(readFileSync(join(examplesDir, file), 'utf8')) as ExampleFile;
        const workflow = exampleToRaw(data);
        if (!workflow || workflow.nodes.length === 0) continue;
        const description = typeof data.meta?.description === 'string' ? data.meta.description : '';
        out.push({ id: file.slice(0, -5), name: workflow.name, description, text: `${workflow.name} ${workflow.name} ${description} ${nodeWords(workflow, registry)}`, workflow });
      } catch {
        // a broken example file must never break the builder
      }
    }
  }
  for (const t of BUILT_IN_TEMPLATES) {
    out.push({ id: t.id, name: t.name, description: t.description, text: `${t.name} ${t.name} ${t.description} ${t.keywords} ${nodeWords(t.workflow, registry)}`, workflow: t.workflow });
  }
  return out;
}
