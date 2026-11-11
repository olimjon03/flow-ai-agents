# Flow AI

AI Content Creator platform.

The Next.js dashboard and the original prototype both use the same Python draft API.

## Project structure

| Directory | Purpose |
| --- | --- |
| `frontend/` | Next.js dashboard and original HTML/CSS/JS prototype |
| `backend/` | Server-side AI integration and application APIs |
| `docs/` | Product and technical notes |
| `assets/` | Shared project assets |
| `scripts/` | Development utilities |

## Run locally

Requirements: Node.js 22.13 or newer, npm, and Python 3.

In one terminal at the repository root, start the Python backend in sample mode.

```sh
python3 backend/server.py
```

In a second terminal at the repository root, start the dashboard.

```sh
cd frontend
npm ci
npm run dev
```

- Dashboard: [http://localhost:3000](http://localhost:3000)
- Original prototype: [http://localhost:8000](http://localhost:8000)
- Python draft endpoint: `http://127.0.0.1:8000/api/generate`

In **Create Content**, enter a brief, choose a social post or short video script, generate, edit, and copy the draft. Sample mode uses local templates and needs no credentials. The draft panel labels each successful response with the mode reported by Python.

If the Python endpoint changes, copy `frontend/.env.example` to `frontend/.env.local`, edit `FLOW_API_URL`, and restart Next.js. The value is the full backend endpoint URL, including `/api/generate`.

## How the dashboard works

The browser submits a draft request to the same-origin Next.js route at `/api/generate`. The route validates the input and forwards the request to Python using the server-only `FLOW_API_URL` setting. Python chooses the generation mode at startup. The OpenAI key belongs only in the Python environment.

The App Router handles navigation and page layouts. Interactive components handle form state, draft editing, copying, and the mobile menu. AI Agents, Projects, Storyboard, Media Library, Publishing, and Analytics have their own routes with empty states. Settings explains the local configuration. Draft edits stay in the page session.

The original prototype is served by Python from its original files. Python serves only its three public static files from `frontend/`, which also contains the new dashboard source and local configuration.

## Checks

Run these from `frontend/` after `npm ci`.

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

If Turbopack cannot bind its internal build port in a restricted environment, run `npm run build -- --webpack`.

The browser tests launch their own sample backend on port 8100 and dashboard on port 3100. They exercise the actual sample endpoint and simulate OpenAI responses. To use a locally installed Google Chrome instead of downloading Chromium, run `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e`.

## Draft API

Send JSON with a brief of up to 1,000 characters and a format of `post` or `video`.

```sh
curl http://localhost:8000/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"brief":"Talabalar uchun vaqtni rejalash","format":"post"}'
```

A successful response contains a `draft` string and a `mode` of `sample` or `openai`. Invalid requests return a 4xx response with an `error` string. OpenAI request failures return 502.

## Generate with OpenAI

Stop the sample server, then run the following in macOS zsh from the project root. The prompt hides your input. Use an OpenAI API key from a project with access to the model.

```zsh
read -rs 'flow_api_key?OpenAI API key: '
OPENAI_API_KEY="$flow_api_key" python3 backend/server.py --openai
unset flow_api_key
```

If both modes should run side by side, add `--port 8001` to the OpenAI command and point `FLOW_API_URL` to port 8001. The server uses `gpt-5.4-mini` by default. Set `OPENAI_MODEL` in the server environment to override it. In OpenAI mode the backend sends the brief to the [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create). Keep the key in the backend environment. Run `python3 backend/server.py` for sample mode.

See [the MVP brief](docs/mvp.md) for the first workflow.
