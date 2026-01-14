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

    const prompt = body.prompt ?? body.promptTextForTokenizing ?? body.prompt_text ?? '';
    const completion = body.completion ?? body.completionTextForTokenizing ?? body.completion_text ?? '';
    const promptTokens = countTokens(prompt);
    const completionTokens = countTokens(completion);
    return res.status(200).json({
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      promptChars: typeof prompt === 'string' ? prompt.length : String(prompt ?? '').length,
      completionChars: typeof completion === 'string' ? completion.length : String(completion ?? '').length,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
