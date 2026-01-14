import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import {
  estimateCostUsd,
  normalizeModel,
  renderTemplate,
  resolvePromptTemplate,
} from '../lib/promptRegistry.js';

function countTokens(text) {
  const s = typeof text === 'string' ? text : (text == null ? '' : String(text));
  return encodeCl100k(s).length;
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
    const varsJson = (body.varsJson && typeof body.varsJson === 'object') ? body.varsJson : ((body.json && typeof body.json === 'object') ? body.json : null);
    const varsByNode = (body.varsByNode && typeof body.varsByNode === 'object') ? body.varsByNode : null;
    const promptOverride = body.prompt ?? body.promptTextForTokenizing ?? body.prompt_text ?? null;
    const completion = body.completion ?? body.completionTextForTokenizing ?? body.completion_text ?? '';

    const { resolvedKey, entry } = resolvePromptTemplate({ key, workflow, nodeName });

    const promptSource = promptOverride != null ? 'override' : (entry ? 'template' : 'missing');
    const template = entry?.template ?? '';
    const prompt = promptOverride != null
      ? String(promptOverride)
      : (entry ? renderTemplate(template, { vars, varsJson, varsByNode }) : '');

    const promptTokensRaw = countTokens(prompt);
    const completionTokensRaw = countTokens(completion);

    const multiplier = Number(body.multiplier ?? body.allowanceMultiplier ?? entry?.defaultMultiplier ?? 1) || 1;
    const promptTokens = Math.max(0, Math.round(promptTokensRaw * multiplier));
    const completionTokens = Math.max(0, Math.round(completionTokensRaw * multiplier));

    const model = normalizeModel(body.model ?? entry?.model ?? 'gpt-5');
    const costUsd = estimateCostUsd({ model, promptTokens, completionTokens });

    return res.status(200).json({
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      promptChars: prompt.length,
      completionChars: typeof completion === 'string' ? completion.length : String(completion ?? '').length,
      // Diagnostics
      templateFound: Boolean(entry),
      resolvedKey,
      promptSource,
      model,
      multiplier,
      costUsd,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
