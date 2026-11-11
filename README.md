# Flow AI

AI Content Creator platform.

Start with the frontend using Codex. Do not add production credentials.

## Project structure

| Directory | Purpose |
| --- | --- |
| `frontend/` | Web application |
| `backend/` | Server-side AI integration and application APIs |
| `docs/` | Product and technical notes |
| `assets/` | Shared project assets |
| `scripts/` | Development utilities |

## Run locally

From the project root, run the local development server with Python 3. It serves the frontend and API on the same port.

```sh
python3 backend/server.py
```

Open [http://localhost:8000](http://localhost:8000). Enter a brief, select a format, and generate a sample draft. Edit the text in the draft panel and use the copy button to copy the edited version. The backend serves sample drafts from templates. The sample mode requires no API key.

## Draft API

Send JSON with a brief of up to 1,000 characters and a format of `post` or `video`.

```sh
curl http://localhost:8000/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"brief":"Talabalar uchun vaqtni rejalash","format":"post"}'
```

A successful response contains a `draft` string. Invalid requests return a 4xx response with an `error` string. The next milestone is connecting the selected AI provider to this endpoint.

See [the MVP brief](docs/mvp.md) for the first workflow.
