import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base';
import { appendOutputParserInstructions, normalizeModel, renderTemplate, resolvePromptTemplate } from '../lib/promptRegistry.js';

function shouldUseO200k(model) {
  const m = normalizeModel(model);
  return (
    m === 'chatgpt-4o-latest' ||
    m.startsWith('gpt-4o') ||
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4')
  );
}

function countTokens(text, model) {
  const s = typeof text === 'string' ? text : (text == null ? '' : String(text));
  return shouldUseO200k(model) ? encodeO200k(s).length : encodeCl100k(s).length;
}

function hasOutputParserInstructions(prompt) {
  const p = typeof prompt === 'string' ? prompt : String(prompt ?? '');
  // Our canonical injected block begins with this exact phrase.
  return p.includes('Return a JSON object with the following JSON Schema:');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    let body = req.body ?? {};

    // Be tolerant of clients that send JSON as a string.
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }

    // Be tolerant of wrappers like { body: {...} }
    if (body && typeof body === 'object' && body.body && typeof body.body === 'object') {
      body = body.body;
    }

    const promptOverride = body.prompt ?? body.promptTextForTokenizing ?? body.prompt_text ?? null;
    const completion = body.completion ?? body.completionTextForTokenizing ?? body.completion_text ?? '';

    const key = body.key ?? body.promptKey ?? null;
    const workflow = body.workflow ?? body.workflowName ?? null;
    const nodeName = body.nodeName ?? body.llmNodeName ?? null;
    const vars = (body.vars && typeof body.vars === 'object') ? body.vars : {};
    let varsJson = (body.varsJson && typeof body.varsJson === 'object') ? body.varsJson : ((body.json && typeof body.json === 'object') ? body.json : null);
    const varsByNode = (body.varsByNode && typeof body.varsByNode === 'object') ? body.varsByNode : null;

    if ((!varsJson || (typeof varsJson === 'object' && varsJson && Object.keys(varsJson).length === 0)) && Object.keys(vars).length > 0) {
      // Many extracted templates use $json.*. If callers only send `vars`, treat it as $json for rendering.
      varsJson = vars;
    }

    const { resolvedKey, entry } = resolvePromptTemplate({ key, workflow, nodeName });
    const model = normalizeModel(body.model ?? entry?.model ?? 'gpt-5');
    const promptSource = promptOverride != null ? 'override' : (entry ? 'template' : 'missing');
    let prompt = promptOverride != null
      ? String(promptOverride)
      : (entry ? renderTemplate(entry.template, { vars, varsJson, varsByNode }) : '');

    // Mirror /estimate: append Structured Output Parser format instructions whenever we
    // know the schema, unless explicitly disabled or already present.
    if (entry?.outputParser && body.appendOutputParser !== false && !hasOutputParserInstructions(prompt)) {
      prompt = appendOutputParserInstructions(prompt, entry.outputParser);
    }

    const promptTokens = countTokens(prompt, model);
    const completionTokens = countTokens(completion, model);
    return res.status(200).json({
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      promptChars: typeof prompt === 'string' ? prompt.length : String(prompt ?? '').length,
      completionChars: typeof completion === 'string' ? completion.length : String(completion ?? '').length,
      // Diagnostics
      templateFound: Boolean(entry),
      resolvedKey,
      promptSource,
      model,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
