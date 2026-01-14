import express from 'express';
import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base';

const app = express();
app.use(express.json({ limit: '5mb' }));

function countTokens(text) {
  const s = typeof text === 'string' ? text : (text == null ? '' : String(text));
  // cl100k_base is the closest widely-available tokenizer for OpenAI chat models.
  // This still may differ from provider billing for some newer models, but will
  // be far closer than chars/4 as long as prompt text is correct.
  return encodeCl100k(s).length;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/count', (req, res) => {
  const { prompt, completion } = req.body ?? {};

  const promptTokens = countTokens(prompt);
  const completionTokens = countTokens(completion);

  res.json({
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  });
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Tokenizer service listening on :${port}`);
});
