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

## Deploy to Vercel (beginner-friendly)

This repo includes Vercel Serverless Functions under `api/`.

Important: Vercel will return 404 for `/` by default. Use these endpoints:

- `GET /health`
- `POST /count`

Those two are rewritten to `api/health` and `api/count` via `vercel.json`, so you don't need to remember `/api`.

### Step-by-step

1) Push this repo to GitHub.
2) Go to Vercel → **Add New…** → **Project** → Import the GitHub repo.
3) Configuration:
   - **Framework Preset**: Other
   - **Root Directory**: `.` (leave default)
   - **Build Command**: leave blank
   - **Output Directory**: leave blank
4) Click **Deploy**.

### Test after deploy

Replace `YOUR_DOMAIN` with your Vercel domain:

```bash
curl -s https://YOUR_DOMAIN/health
curl -s https://YOUR_DOMAIN/count \
  -H 'content-type: application/json' \
  -d '{"prompt":"hello","completion":"world"}'
```

## n8n integration

Set a workflow variable:

- `TOKENIZER_URL = https://YOUR_DOMAIN`

Your n8n HTTP nodes already call `{{$vars.TOKENIZER_URL}}/count`.

## Notes

- This does **not** require any n8n API keys.
- The closer your prompt/completion text matches what was actually sent to the model, the closer these counts will be.
