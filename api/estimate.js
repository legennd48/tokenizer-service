import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base';
import {
  appendOutputParserInstructions,
  estimateCostUsd,
  getReasoningMultiplier,
  normalizeModel,
  renderTemplate,
  resolvePromptTemplate,
} from '../lib/promptRegistry.js';

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

function unwrapBody(reqBody) {
  let body = reqBody ?? {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (body && typeof body === 'object' && body.body && typeof body.body === 'object') {
    body = body.body;
  }
  return body;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = unwrapBody(req.body);

    const key = body.key ?? body.promptKey ?? null;
    const workflow = body.workflow ?? body.workflowName ?? null;
    const nodeName = body.nodeName ?? body.llmNodeName ?? null;

    const vars = (body.vars && typeof body.vars === 'object') ? body.vars : {};
    let varsJson = (body.varsJson && typeof body.varsJson === 'object') ? body.varsJson : ((body.json && typeof body.json === 'object') ? body.json : null);
    const varsByNode = (body.varsByNode && typeof body.varsByNode === 'object') ? body.varsByNode : null;
    const promptOverride = body.prompt ?? body.promptTextForTokenizing ?? body.prompt_text ?? null;
    const completion = body.completion ?? body.completionTextForTokenizing ?? body.completion_text ?? '';

    const { resolvedKey, entry } = resolvePromptTemplate({ key, workflow, nodeName });

    if ((!varsJson || (typeof varsJson === 'object' && varsJson && Object.keys(varsJson).length === 0)) && Object.keys(vars).length > 0) {
      // Many extracted templates use $json.*. If callers only send `vars`, treat it as $json for rendering.
      varsJson = vars;
    }

    const promptSource = promptOverride != null ? 'override' : (entry ? 'template' : 'missing');
    const template = entry?.template ?? '';
    let prompt = promptOverride != null
      ? String(promptOverride)
      : (entry ? renderTemplate(template, { vars, varsJson, varsByNode }) : '');

    // If the template was extracted from an n8n chain that uses Structured Output Parser,
    // append the same format instructions block n8n/LangChain injects.
    if (promptOverride == null && entry?.outputParser) {
      prompt = appendOutputParserInstructions(prompt, entry.outputParser);
    }

    const model = normalizeModel(body.model ?? entry?.model ?? 'gpt-5');

    const promptTokensRaw = countTokens(prompt, model);
    const completionTokensVisible = countTokens(completion, model);

    const multiplier = Number(body.multiplier ?? body.allowanceMultiplier ?? entry?.defaultMultiplier ?? 1) || 1;
    const reasoningMultiplier = Number(body.reasoningMultiplier ?? body.completionMultiplier ?? getReasoningMultiplier(model)) || 1;

    const promptTokens = Math.max(0, Math.round(promptTokensRaw * multiplier));
    const completionTokens = Math.max(0, Math.round(completionTokensVisible * multiplier * reasoningMultiplier));
    const costUsd = estimateCostUsd({ model, promptTokens, completionTokens });

    return res.status(200).json({
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      completionTokensVisible,
      promptChars: prompt.length,
      completionChars: typeof completion === 'string' ? completion.length : String(completion ?? '').length,
      // Diagnostics
      templateFound: Boolean(entry),
      resolvedKey,
      promptSource,
      model,
      multiplier,
      reasoningMultiplier,
      costUsd,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
