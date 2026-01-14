# n8n Tokenizer Service

This is a tiny HTTP service that counts tokens using `cl100k_base` (via `gpt-tokenizer`).

## Run locally

```bash
cd tokenizer-service
npm install
npm start
```

- Health check: `GET http://localhost:8787/health`
- Count endpoint: `POST http://localhost:8787/count`

Example:

```bash
curl -s http://localhost:8787/count \
  -H 'content-type: application/json' \
  -d '{"prompt":"hello","completion":"world"}'
```

## Notes

- This does **not** require any n8n API keys.
- The closer your prompt/completion text matches what was actually sent to the model, the closer these counts will be.
