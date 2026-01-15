import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), '..'); // /home/legennd/N8N

const WORKFLOWS = [
  {
    file: 'Phase 1_ Workflow Setup & Initialization.json',
    workflowName: 'Phase 1: Workflow Setup & Initialization',
  },
  {
    file: 'Phase 2_ Content Scraping (new Logic).json',
    workflowName: 'Phase 2: Content Scraping',
  },
  {
    file: 'Phase 3_ Content Brief Generation — NLP-enhanced.json',
    workflowName: 'Phase 3: Content Brief Generation — NLP-enhanced',
  },
  {
    file: 'Phase 4_ Article Generation.json',
    workflowName: 'Phase 4: Article Generation',
  },
  {
    file: 'Link Research Agent.json',
    workflowName: 'Link Research Agent',
  },
];

function stripLeadingEquals(s) {
  const t = String(s ?? '');
  return t.startsWith('=') ? t.slice(1) : t;
}

function normalizeTemplateText(s) {
  // Keep text as-is, but remove n8n leading '=' and avoid accidental Windows newlines.
  return stripLeadingEquals(s).replace(/\r\n/g, '\n');
}

function buildTemplateForNode(node) {
  const p = node?.parameters ?? {};

  const parts = [];

  // Agent nodes can have systemMessage under options.systemMessage
  if (p?.options?.systemMessage) {
    parts.push(normalizeTemplateText(p.options.systemMessage));
  }

  // chainLlm nodes typically have messages.messageValues[].message
  const msgValues = p?.messages?.messageValues;
  if (Array.isArray(msgValues) && msgValues.length) {
    for (const mv of msgValues) {
      if (mv && typeof mv.message === 'string' && mv.message.trim()) {
        parts.push(normalizeTemplateText(mv.message));
      }
    }
  }

  // Main prompt text
  if (typeof p.text === 'string' && p.text.trim()) {
    parts.push(normalizeTemplateText(p.text));
  }

  const template = parts
    .map((x) => String(x).trimEnd())
    .filter(Boolean)
    .join('\n\n')
    .trim();

  return template;
}

function isPromptNode(node) {
  const t = String(node?.type ?? '');
  return (
    t === '@n8n/n8n-nodes-langchain.chainLlm' ||
    t === '@n8n/n8n-nodes-langchain.agent'
  );
}

function isStructuredOutputParserNode(node) {
  return String(node?.type ?? '') === '@n8n/n8n-nodes-langchain.outputParserStructured';
}

function findNodeByName(nodes, name) {
  const n = String(name ?? '').trim();
  if (!n) return null;
  return nodes.find((x) => String(x?.name ?? '').trim() === n) ?? null;
}

function findStructuredOutputParserForChain(parsed, chainNodeName) {
  const connections = parsed?.connections;
  if (!connections || typeof connections !== 'object') return null;

  // In n8n exports, output parser nodes connect to the chain via `ai_outputParser`.
  // Example:
  //  "Parse X": { "ai_outputParser": [[{ node: "Generate X", type: "ai_outputParser" }]] }
  for (const [fromNodeName, conn] of Object.entries(connections)) {
    const ai = conn?.ai_outputParser;
    if (!Array.isArray(ai)) continue;
    for (const branch of ai) {
      if (!Array.isArray(branch)) continue;
      for (const edge of branch) {
        if (edge?.node === chainNodeName && edge?.type === 'ai_outputParser') {
          return String(fromNodeName);
        }
      }
    }
  }

  return null;
}

function inferJsonSchemaFromExample(exampleValue) {
  if (exampleValue == null) return { type: 'string' };
  if (typeof exampleValue === 'string') return { type: 'string' };
  if (typeof exampleValue === 'number') return { type: 'number' };
  if (typeof exampleValue === 'boolean') return { type: 'boolean' };
  if (Array.isArray(exampleValue)) {
    const allStrings = exampleValue.every((v) => typeof v === 'string');
    const items = allStrings ? { type: 'string' } : {};
    return { type: 'array', items };
  }
  if (typeof exampleValue === 'object') {
    const props = {};
    const req = [];
    for (const [k, v] of Object.entries(exampleValue)) {
      props[k] = inferJsonSchemaFromExample(v);
      req.push(k);
    }
    return { type: 'object', properties: props, required: req, additionalProperties: false };
  }
  return { type: 'string' };
}

function buildLangchainSchemaInstanceFromExample(exampleObj) {
  // n8n's Structured Output Parser wraps into an `output` object.
  const inner = inferJsonSchemaFromExample(exampleObj);

  // Force the wrapped schema shape.
  const schema = {
    type: 'object',
    properties: {
      output: {
        type: 'object',
        properties: inner.properties ?? {},
        required: inner.required ?? [],
        additionalProperties: false,
      },
    },
    required: ['output'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  };

  return schema;
}

async function main() {
  const out = {};

  for (const wf of WORKFLOWS) {
    const filePath = path.join(ROOT, wf.file);
    let parsed;

    try {
      parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (e) {
      console.warn(`Skipping ${wf.file}: could not read/parse (${String(e)})`);
      continue;
    }

    const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];

    for (const node of nodes) {
      if (!isPromptNode(node)) continue;
      const nodeName = String(node?.name ?? '').trim();
      if (!nodeName) continue;

      const template = buildTemplateForNode(node);
      if (!template) continue;

      const key = `${wf.workflowName}::${nodeName}`;

      // Infer a conservative default multiplier from retry settings if present.
      // Note: n8n retries don't always happen; keep multiplier at 1 unless maxTries is clearly set.
      const maxTries = Number(node?.maxTries ?? 0) || 0;
      const retryOnFail = Boolean(node?.retryOnFail);
      const defaultMultiplier = retryOnFail && maxTries > 1 ? maxTries : 1.0;

      const entry = { template, defaultMultiplier };

      // If the chain uses a Structured Output Parser, store its schema so the service
      // can append the same format instructions LangChain injects at runtime.
      if (String(node?.type ?? '') === '@n8n/n8n-nodes-langchain.chainLlm' && Boolean(node?.parameters?.hasOutputParser)) {
        const parserNodeName = findStructuredOutputParserForChain(parsed, nodeName);
        if (parserNodeName) {
          const parserNode = findNodeByName(nodes, parserNodeName);
          if (parserNode && isStructuredOutputParserNode(parserNode)) {
            const raw = parserNode?.parameters?.jsonSchemaExample;
            if (typeof raw === 'string' && raw.trim()) {
              try {
                const exampleObj = JSON.parse(raw);
                entry.outputParser = {
                  type: 'langchain_structured_v1',
                  schema: buildLangchainSchemaInstanceFromExample(exampleObj),
                };
              } catch {
                // Ignore invalid schema examples
              }
            }
          }
        }
      }

      out[key] = entry;
    }
  }

  const keys = Object.keys(out).sort();

  const header = `// AUTO-GENERATED FILE. DO NOT EDIT BY HAND.\n// Generated by scripts/generatePromptTemplates.mjs\n\n`;
  const bodyLines = [];
  bodyLines.push('export const GENERATED_PROMPT_TEMPLATES = {');

  for (const key of keys) {
    const entry = out[key];
    const tpl = String(entry.template);

    // Use JSON.stringify for safe escaping.
    bodyLines.push(`  ${JSON.stringify(key)}: {`);
    bodyLines.push(`    template: ${JSON.stringify(tpl)},`);
    bodyLines.push(`    defaultMultiplier: ${JSON.stringify(entry.defaultMultiplier)},`);
    if (entry.outputParser) {
      bodyLines.push(`    outputParser: ${JSON.stringify(entry.outputParser)},`);
    }
    bodyLines.push('  },');
  }

  bodyLines.push('};\n');

  const outPath = path.join(process.cwd(), 'lib', 'promptTemplates.generated.js');
  await fs.writeFile(outPath, header + bodyLines.join('\n'), 'utf8');

  console.log(`Generated ${keys.length} prompt templates → ${outPath}`);
}

await main();
