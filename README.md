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

Requirements: Node.js 22.13 or newer, npm, and Python 3.11 or newer.

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

In a third terminal at the repository root, start the FastAPI office service.

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
python -m uvicorn flow_api.app:app --app-dir backend --host 127.0.0.1 --port 8001
```

- Dashboard: [http://localhost:3000](http://localhost:3000)
- Original prototype: [http://localhost:8000](http://localhost:8000)
- FastAPI office health: [http://localhost:8001/health](http://localhost:8001/health)
- Python draft endpoint: `http://127.0.0.1:8000/api/generate`

In **Create Content**, enter a brief, choose a social post or short video script, generate, edit, and copy the draft. Sample mode uses local templates and needs no credentials. The draft panel labels each successful response with the mode reported by Python.

If the Python endpoint changes, copy `frontend/.env.example` to `frontend/.env.local`, edit `FLOW_API_URL`, and restart Next.js. The draft value is the full endpoint URL, including `/api/generate`. Set `FLOW_OFFICE_API_URL` to the FastAPI origin if the office port changes.

## How the dashboard works

The browser submits a draft request to the same-origin Next.js route at `/api/generate`. The route validates the input and forwards the request to Python using the server-only `FLOW_API_URL` setting. Python chooses the generation mode at startup. The OpenAI key belongs only in the Python environment.

The App Router handles navigation and page layouts. Interactive components handle form state, draft editing, copying, and the mobile menu. AI Agents, Projects, Storyboard, Media Library, Publishing, and Analytics have their own routes with empty states. Settings explains the local configuration. Draft edits stay in the page session.

The original prototype is served by Python from its original files. Python serves only its three public static files from `frontend/`, which also contains the new dashboard source and local configuration.

## AI Office

Open [AI Office](http://localhost:3000/ai-office) from the sidebar. On desktop, the elevated orthographic camera fits all 12 workstations on startup. Drag the floor to pan, scroll or use the zoom buttons, and use Reset camera to restore the full floor. Click a desk or its keyboard-accessible nameplate to view the task, progress and recent activity. Switch to 2D from the workstation header. Narrow screens, devices reporting 2 GB of memory or less, and WebGL initialization or context failures use the 2D view. The scene uses shared geometry and materials, capped pixel density, and no post-processing. Reduced-motion mode disables avatar animation.

With FastAPI running, wait for **Live backend · Simulated agents**, then select **Start demo task**. One local workflow at a time moves through Research, Create, Review and Deliver. The backend assigns tasks, publishes progress and keeps the latest 80 activity entries. The 3D view and the 2D fallback use the same confirmed snapshots. This simulation has zero provider requests, tokens and cost.

Next.js proxies `POST /api/office/tasks` and `GET /api/office/events` to FastAPI. The SSE stream sends complete `office.snapshot` events, so a new connection receives the current state immediately. The server coalesces updates for slow clients. The browser shows the last confirmed simulation as disconnected if the stream breaks and reconnects automatically. Before any confirmed event, the office displays the offline demo preview with illustrative usage and disables task start.

The office service keeps state in memory and uses one Uvicorn worker. Restarting it clears the run and activity. Use it on localhost. Persistence and authentication are future integration work. The original draft server remains available independently. If you run its optional OpenAI mode alongside the office, use a different port, such as 8002, and update `FLOW_API_URL`.

## Run the content agents

Open **AI Office → Agent workflow**. Enter a topic, language, style, and duration in seconds (15–600). Select **Run in mock mode** to get a deterministic script and review. The three agents run in order and report status and progress over SSE. **Cancel run** stops the current local workflow. Script and review appear under the office as they become available.

### Enable real OpenAI mode on macOS zsh

Create an API key for an OpenAI project with model access and API billing. Stop the FastAPI office process with **Ctrl+C**. From the repository root, activate the virtual environment and start only the office service in OpenAI mode.

```zsh
source .venv/bin/activate
read -rs 'flow_office_key?OpenAI API key: '
FLOW_OFFICE_PROVIDER=openai FLOW_OFFICE_MAX_COST_USD=0.05 OPENAI_API_KEY="$flow_office_key" \
  python -m uvicorn flow_api.app:app --app-dir backend --host 127.0.0.1 --port 8001
unset flow_office_key
```

Open AI Office after the backend reconnects. In **Agent workflow**, fill the brief, check **Allow paid OpenAI requests for this run**, then select **Run with OpenAI**. The existing **Start demo task** button continues to launch the 12-agent simulation. Restart the service with `FLOW_OFFICE_PROVIDER=mock` to return to mock mode.

The adapter uses GPT-5.4 mini through the [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create), with a 25-second deadline per request and at most one retry for timeouts, transport errors, HTTP 429, and HTTP 5xx. The per-run estimated cost cap defaults to $0.05 and accepts $0.001–$1.00. Each attempt reserves an estimate before sending, including retries, and reconciles it against usage returned by OpenAI. Attempts with unknown usage keep their reservation. Provider charges can differ from the estimate, including for a request already accepted when cancellation occurs. See [model rates](https://developers.openai.com/api/docs/models/gpt-5.4-mini#pricing).

Research produces model-generated notes and flags claims that need verification. The workflow makes text requests without browsing or publishing tools. The app keeps only the current run and its outputs in memory.

## Media Studio

Install FFmpeg on macOS with [Homebrew](https://formulae.brew.sh/formula/ffmpeg).

```sh
brew install ffmpeg
ffmpeg -version
ffmpeg -encoders | rg 'libx264|aac'
```

Start the dashboard and FastAPI office service with the local startup commands above. If FFmpeg is installed outside your shell path, set `FLOW_FFMPEG_BIN` to its executable before starting FastAPI. Studio uses its local mock providers in every office provider mode.

1. Open **Media Studio** and create a project with a topic, 30 seconds, and 9:16. Choose **360p test** for a quick vertical 360×640 export or **1080p full** for 1080×1920. The 16:9 presets reverse those dimensions.
2. Select **Start mock workflow**. Review the script, scene descriptions and prompts, then select **Approve script and storyboard**. The Image and Voice agents run in parallel. Video waits for images, and Editor waits for clips and narration media. Open **AI Office** to see the existing workstations update over SSE.
3. Play the scene clips, audio and final MP4 in Studio. Studio provides browser subtitles and embeds a selectable subtitle track in the downloaded H.264/AAC MP4. Approve the result or reject it with feedback. **Regenerate stage** reruns the chosen stage and dependent stages.
4. Restart FastAPI and return to Studio to reopen the saved project.

SQLite metadata and generated media are under `.flow-media/` at the repository root by default. Git ignores this directory. Set `FLOW_MEDIA_ROOT` before launching FastAPI to store data elsewhere. Keep the same location when restarting. Use one FastAPI worker. The app marks interrupted runs failed after a restart so the relevant stage can be regenerated.

Mock images are original procedural graphics. Clips hold each image for its scene duration. Audio uses original placeholder tones, including the optional background track. The Uzbek male default is a preference for a future voice provider. Subtitles carry the script narration as timed text. Studio accepts generated files only and bounds JSON requests at 4 KiB. Approval records a decision locally.

Image, Voice, and Video provider protocols define where future adapters can be integrated. Future adapters can return local assets with the existing IDs and metadata contract and enforce their own consent and cost limits before making external calls.

## Checks

Run the backend tests from the repository root with the virtual environment active.

```sh
PYTHONPATH=backend python -m unittest discover -s backend/tests -v
```

Run these from `frontend/` after `npm ci`, with the Python virtual environment still active.

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

If Turbopack cannot bind its internal build port in a restricted environment, run `npm run build -- --webpack`.

The browser tests launch the sample draft server on port 8100, FastAPI on 8101, and the dashboard on 3100. They exercise the actual sample endpoint and simulate OpenAI responses. If the development server is already running, build first and use `PLAYWRIGHT_USE_BUILD=1 npm run test:e2e` to test the production build on its own port. To use a locally installed Google Chrome instead of downloading Chromium, run `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e`.

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
