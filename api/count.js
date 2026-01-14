import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base';

function countTokens(text) {
  const s = typeof text === 'string' ? text : (text == null ? '' : String(text));
  return encodeCl100k(s).length;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { prompt, completion } = req.body ?? {};
    const promptTokens = countTokens(prompt);
    const completionTokens = countTokens(completion);
    return res.status(200).json({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
