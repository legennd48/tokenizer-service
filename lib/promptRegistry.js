// Prompt registry for token/cost estimation.
// Keys should be stable across n8n imports: prefer `workflow::nodeName`.

import { GENERATED_PROMPT_TEMPLATES } from './promptTemplates.generated.js';

export const PROMPT_TEMPLATES = {
  ...GENERATED_PROMPT_TEMPLATES,
  // Phase 1
  'Phase 1: Workflow Setup & Initialization::Generate Type Suggestions': {
    model: 'gpt-5',
    template: "You are helping a content team choose the best content *type* for a keyword by analyzing the user's search intent.\n\nKeyword: {{ $json.Keywords }}\nLanguage: {{ $json.lang }}\n\nTop SERP results (sample):\n{{ $json.serpSample }}\n\nGoal:\nMake it easy for a client to decide what kind of content to create for this keyword, based on the likely intent(s) behind the search.\n\nTask (do these in order):\n1) Infer the **PRIMARY search intent** (1 clear sentence): what the user most likely wants when typing the keyword.\n2) Infer 2–4 **SECONDARY intents** (short bullets): other common motivations/questions for the same keyword.\n3) Based on (1) and (2), suggest **3 to 6 plausible content types** a client might choose.\n   - Each content type must be a short free-text phrase the client can copy into a Google Sheet (aim: 2–6 words).\n   - Keep suggestions aligned with these example categories, but do NOT force exact labels:\n     Instructionele content, Informatieve content, Vergelijkende content, Commerciële content, Educatieve content.\n\nLanguage rules (strict):\n- Use the same language as the keyword.\n- If Language is \"nl\", write EVERYTHING (including headings/labels like \"Primary intent\") in Dutch.\n\nGrounding rules:\n- Base your intent analysis primarily on the keyword and the SERP sample provided.\n- If SERP sample is empty/insufficient, infer intent from the keyword only and say it is inferred.\n- Do NOT invent facts about the client, brand, or product.\n\nReturn ONLY JSON (no markdown, no extra text):\n{\n  \"typeSuggestion\": \"Primary intent: ...\\nSecondary intents:\\n- ...\\n- ...\\n\\nCopy/paste ONE of these content types into the sheet:\\n1) ...\\n2) ...\\n3) ...\"\n}",
    // Allowance for typical retry/loop overhead (optional; caller can override).
    defaultMultiplier: 1.0,
  },
};

export function resolvePromptTemplate({ key, workflow, nodeName }) {
  if (key && PROMPT_TEMPLATES[key]) return { resolvedKey: key, entry: PROMPT_TEMPLATES[key] };

  if (workflow && nodeName) {
    const wk = `${workflow}::${nodeName}`;
    if (PROMPT_TEMPLATES[wk]) return { resolvedKey: wk, entry: PROMPT_TEMPLATES[wk] };
  }

  if (nodeName) {
    // Fallback: try nodeName-only keys if you decide to use them.
    if (PROMPT_TEMPLATES[nodeName]) return { resolvedKey: nodeName, entry: PROMPT_TEMPLATES[nodeName] };

    // If caller only knows the LLM node name, try a safe unique suffix match against `workflow::nodeName` keys.
    // If multiple workflows have the same nodeName (common: "Basic LLM Chain"), we do NOT guess.
    const suffix = `::${nodeName}`;
    const matches = Object.keys(PROMPT_TEMPLATES).filter((k) => k.endsWith(suffix));
    if (matches.length === 1) return { resolvedKey: matches[0], entry: PROMPT_TEMPLATES[matches[0]] };
  }

  return { resolvedKey: key || (workflow && nodeName ? `${workflow}::${nodeName}` : null), entry: null };
}

function safeVarName(expr) {
  const s = String(expr || '').trim();
  // Support patterns like `$json.Keywords` or `Keywords`
  if (s.startsWith('$json.')) return s.slice('$json.'.length).trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return s;

  // Very small safety net for expressions like `$json.Keywords || ''`
  const m = s.match(/\$json\.([A-Za-z_][A-Za-z0-9_]*)/);
  if (m) return m[1];
  return null;
}

function deepGet(root, pathExpr) {
  if (!root || typeof root !== 'object') return undefined;
  const expr = String(pathExpr || '').trim();
  if (!expr) return undefined;

  // Convert bracket indexes into dot form: data[0].Keywords => data.0.Keywords
  const normalized = expr.replace(/\[(\d+)\]/g, '.$1');
  const parts = normalized.split('.').filter(Boolean);

  let cur = root;
  for (const part of parts) {
    if (cur == null) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function unescapeDelimiter(s) {
  return String(s ?? '')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r');
}

function asString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function splitOr(expr) {
  // Very small parser for `a || b || c` (good enough for our known prompts)
  return String(expr).split(/\s*\|\|\s*/g).map((x) => x.trim()).filter(Boolean);
}

function evalExpr(rawExpr, ctx) {
  const expr0 = String(rawExpr ?? '').trim();
  if (!expr0) return '';

  // Support `a || b` fallback
  const orParts = expr0.includes('||') ? splitOr(expr0) : [expr0];
  for (const expr of orParts) {
    const val = evalExprSingle(expr, ctx);
    if (val != null && String(val) !== '') return val;
  }
  return '';
}

function evalExprSingle(expr, ctx) {
  let s = String(expr ?? '').trim();

  // Handle simple string literals
  const lit = s.match(/^['"]([\s\S]*)['"]$/);
  if (lit) return lit[1];

  // Handle `.trim()`
  if (s.endsWith('.trim()')) {
    const inner = s.slice(0, -'.trim()'.length);
    return asString(evalExpr(inner, ctx)).trim();
  }

  // Handle `.toJsonString()` (n8n helper)
  if (s.endsWith('.toJsonString()')) {
    const inner = s.slice(0, -'.toJsonString()'.length);
    return asString(evalExpr(inner, ctx));
  }

  // $json root
  if (s === '$json') return ctx?.json ?? {};

  // $json.<path> with optional joins/maps
  // Examples:
  // - $json.search_results.join('\n')
  // - $json.data.map(item => item.title).join(', ')
  // - $json.data[0].Keywords
  const joinMatch = s.match(/^\$json(\.[A-Za-z0-9_$.\[\]]+)(?:\.map\(item\s*=>\s*item\.([A-Za-z0-9_]+)\))?\.join\((['"])([\s\S]*?)\3\)$/);
  if (joinMatch) {
    const pathExpr = joinMatch[1].slice(1); // remove leading '.'
    const mapField = joinMatch[2] || null;
    const delim = unescapeDelimiter(joinMatch[4]);
    const base = deepGet(ctx?.json ?? {}, pathExpr);
    if (!Array.isArray(base)) return '';
    const arr = mapField ? base.map((item) => (item && typeof item === 'object' ? item[mapField] : undefined)) : base;
    return arr.map(asString).filter(Boolean).join(delim);
  }

  if (s.startsWith('$json.')) {
    const v = deepGet(ctx?.json ?? {}, s.slice('$json.'.length));
    return v;
  }

  // Node references: $('Node Name').first().json.foo
  const nodeMatch = s.match(/^\$\('([^']+)'\)\.(?:first\(\)|first|item)\.json(?:\.(.+))?$/);
  if (nodeMatch) {
    const nodeName = nodeMatch[1];
    const pathExpr = nodeMatch[2] || '';
    const nodeJson = (ctx?.nodes && typeof ctx.nodes === 'object') ? ctx.nodes[nodeName] : undefined;
    if (!pathExpr) return nodeJson;
    return deepGet(nodeJson ?? {}, pathExpr);
  }

  // Plain variable name fallback
  const varName = safeVarName(s);
  if (varName) {
    if (ctx?.vars && Object.prototype.hasOwnProperty.call(ctx.vars, varName)) return ctx.vars[varName];
    if (ctx?.json && Object.prototype.hasOwnProperty.call(ctx.json, varName)) return ctx.json[varName];
  }

  return '';
}

export function renderTemplate(template, varsOrContext = {}) {
  const tpl = String(template ?? '');

  // Backward compat:
  // - renderTemplate(template, vars)
  // - renderTemplate(template, { vars, varsJson, varsByNode })
  const isCtx = varsOrContext && typeof varsOrContext === 'object' && (
    Object.prototype.hasOwnProperty.call(varsOrContext, 'varsJson') ||
    Object.prototype.hasOwnProperty.call(varsOrContext, 'varsByNode') ||
    Object.prototype.hasOwnProperty.call(varsOrContext, 'vars')
  );

  const ctx = isCtx
    ? {
        vars: (varsOrContext.vars && typeof varsOrContext.vars === 'object') ? varsOrContext.vars : {},
        json: (varsOrContext.varsJson && typeof varsOrContext.varsJson === 'object') ? varsOrContext.varsJson : {},
        nodes: (varsOrContext.varsByNode && typeof varsOrContext.varsByNode === 'object') ? varsOrContext.varsByNode : {},
      }
    : { vars: (varsOrContext && typeof varsOrContext === 'object') ? varsOrContext : {}, json: {}, nodes: {} };

  return tpl.replace(/\{\{([^}]+)\}\}/g, (_match, inner) => {
    const v = evalExpr(inner, ctx);
    return asString(v);
  });
}

export const MODEL_PRICING_PER_1M = {
  'gpt-5.2': { input: 1.75, output: 14.0 },
  'gpt-5.1': { input: 1.25, output: 10.0 },
  'gpt-5': { input: 1.25, output: 10.0 },
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4.1': { input: 2.0, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'o1': { input: 15.0, output: 60.0 },
  'o3': { input: 2.0, output: 8.0 },
  'o4-mini': { input: 1.1, output: 4.4 },
  'chatgpt-4o-latest': { input: 5.0, output: 15.0 },
};

export function normalizeModel(model) {
  const m = String(model || '').trim();
  if (!m) return '';
  return m.includes('/') ? m.split('/').pop() : m;
}

export function estimateCostUsd({ model, promptTokens, completionTokens }) {
  const normalized = normalizeModel(model);
  let rate = MODEL_PRICING_PER_1M[normalized];
  if (!rate) {
    const baseModel = normalized.replace(/-[0-9]{4}-[0-9]{2}-[0-9]{2}.*/, '');
    rate = MODEL_PRICING_PER_1M[baseModel];
  }
  rate = rate || { input: 0, output: 0 };
  const cost = ((promptTokens / 1_000_000) * rate.input) + ((completionTokens / 1_000_000) * rate.output);
  return Number.isFinite(cost) ? Number(cost.toFixed(6)) : 0;
}
