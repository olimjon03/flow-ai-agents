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

A successful response contains a `draft` string and a `mode` of `sample` or `openai`. Invalid requests return a 4xx response with an `error` string. OpenAI request failures return 502.

## Generate with OpenAI

Stop the sample server, then run the following in macOS zsh from the project root. The prompt hides your input. Use an OpenAI API key from a project with access to the model.

```zsh
read -rs 'flow_api_key?OpenAI API key: '
OPENAI_API_KEY="$flow_api_key" python3 backend/server.py --openai
unset flow_api_key
```

The server uses `gpt-5.4-mini` by default. Set `OPENAI_MODEL` in the server environment to override it. In OpenAI mode the backend sends the brief to the [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create). Keep the key in the backend environment. Run `python3 backend/server.py` for sample mode.

See [the MVP brief](docs/mvp.md) for the first workflow.
