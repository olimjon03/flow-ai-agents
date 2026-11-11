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

## Run the frontend

From the project root, run the local static server with Python 3.

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory frontend
```

Open [http://localhost:8000](http://localhost:8000). Enter a brief, select a format, and generate a sample draft. Edit the text in the draft panel and use the copy button to copy the edited version. The prototype runs in the browser and uses local templates.

## First milestone

The local web prototype supports sample social posts and short video scripts. The next milestone is to connect an AI provider through the backend once the provider and API are chosen.

See [the MVP brief](docs/mvp.md) for the first workflow.
