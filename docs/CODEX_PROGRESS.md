# Codex progress

## Phase 7.1 — DeepSeek storyboard

Media Studio generates five ordered six-second scenes for new 30-second scripts. Each scene includes a visual prompt and voiceover. Other mock durations and saved projects keep their existing format.

Start the mock workflow and review the script. With the server configured for Deploy and a 30-second project, the approval screen offers an unchecked option to allow a paid DeepSeek storyboard. The approval request must explicitly include `allowPaid: true`. Mock approval remains the default even on a Deploy-enabled server.

The paid path sends the approved script to the existing Deploy adapter and validates five ordered scenes before replacing the preview. It uses the existing per-run budget, request deadline, retry, cancellation, and AI Office usage accounting. Invalid output stops the job and preserves the preview so approval can be retried. The existing local media generation and FFmpeg export follow successful approval.

## Phase 7.2B — Hive Flux Schnell images

Mock images remain the default. The optional Hive adapter uses the V3 Flux Schnell endpoint and the existing validated PNG publication path. Enable locally only after provider verification by setting `FLOW_STUDIO_IMAGE_PROVIDER=hive` and supplying `HIVE_API_KEY` in the FastAPI process environment. Keep the key server-side and separate from Deploy credentials. Only vertical projects offer Hive consent.

The unchecked Hive consent applies to that approval or explicit Image regeneration only. DeepSeek consent covers the storyboard separately. An interrupted Hive job keeps completed scenes and explicit paid Image regeneration resumes missing scenes. A fresh generation request for an ambiguous scene may incur another charge, so check the provider account before authorizing a retry.

Flow AI uses a conservative per-attempt estimate of $0.003 for one four-step image, based on the earlier Hive Flux Schnell listing. Five images reserve $0.015. The per-run image cap defaults to $0.03 via `FLOW_STUDIO_IMAGE_MAX_COST_USD` and the overall Office cap via `FLOW_OFFICE_MAX_COST_USD` applies as well. An overall $0.01 cap is insufficient for five images. The estimate is reserved and persisted before the POST, including when the outcome is unknown. It can therefore exceed the amount billed.

The adapter uses a 45-second generation deadline and 15 seconds per download attempt. It never automatically repeats a generation POST. One transient download retry uses the same URL. Downloads require an allowlisted HTTPS host and are limited to 16 MiB, followed by PNG decoding and pixel limits. Redirects are rejected. Avoid verbose HTTP client logging of signed download URLs.

Unverified account-specific details include Hive V3 entitlement, acceptance of the requested 576×1024 size, actual billing, any additional result CDN hosts, and idempotency or status lookup support. The current public pricing page redirects to Deploy and does not confirm the legacy Flux rate. No live or paid requests were made. See the [Hive V3 image contract](https://docs.thehive.ai/docs/image-generation-models) and [public pricing](https://deploy.com/pricing).

### PR #11 review follow-up

Replacement work for a project with an existing export writes to a leased project-local staging directory. Active asset references change in one SQLite update after successful export. On failure, cancellation or restart the previous export stays available. Startup removes unreferenced batches whose leases have been released. Run Studio as a single local service with one worker.

Before combined DeepSeek and Hive approval, the estimate includes the maximum configured Deploy attempts and five Hive images. Each request still reserves against the live Office budget. An uncertain Hive attempt remains visible after cancellation or restart and requires a separate acknowledgement before another paid image submission. HTTPX request logging redacts Hive CDN query strings.

Run both FastAPI and the Next.js dashboard bound to loopback. Do not publish or reverse-proxy the paid Studio routes until caller authentication is available. The localhost checks are scoped to this development setup. Hive entitlement, portrait dimensions, CDN coverage, actual billing, and idempotency remain unverified.

## Phase 7.3 — Daily Video Settings foundation

Open **Settings → Daily Video Settings** with the local FastAPI server running. Defaults are enabled, one run per day, 06:00 and Asia/Seoul. The schedule starts inactive. Save changes, run the dry run, and explicitly activate the mock schedule. Changing settings clears activation and dry-run confirmation. Pause stops scheduled dispatch; a running job can be cancelled in Media Studio. Generate Now queues a mock job independently of scheduling, using the same local-day quota.

The single FastAPI worker stores settings and job admissions in the Studio SQLite database. Manual submissions carry an idempotency key. Scheduled admissions are serialized with manual admissions and fill available slots after the configured local time. Queued jobs resume after restart within their admission day and expire at the next local day. An interrupted export is recorded as failed and consumes its slot. The service does not backfill missed dates. Timezone changes are deferred to the active timezone’s next midnight. Before that boundary, the current local-day quota stays in force. Afterward, UTC admissions in any overlap count toward the new local day. The change clears activation and requires a fresh dry run.

Four isolated mock profile descriptors rotate across admitted jobs. Their paths are configuration labels. The scheduler does not create or open Chrome profiles, sign into accounts, request Google Flow, or use paid providers. Daily runs produce local mock previews and keep final approval pending. The existing manual Studio script review stays in place. No publishing integration is connected.

Manual MP4 import is a separate design. Accept a bounded local upload for a selected scene, verify the container and video stream with FFmpeg, normalize the clip to the scene duration and project aspect, then publish it as a project-scoped video asset. Reuse the existing staged replacement workflow so importing a clip generates a new export pending explicit approval. The current video provider remains injectable, with the existing FFmpeg still-image clip implementation as the default.

### PR #12 audit follow-up

Daily Video writes require a loopback peer, a trusted localhost authority, and a matching Origin when supplied. The Next.js proxy checks its incoming authority and browser Origin as well. Run the local FastAPI service with `--host 127.0.0.1 --no-proxy-headers` to keep ASGI peer and scheme information tied to the direct connection. Do not expose these endpoints through a public reverse proxy.

Final approval and rejection require the reviewed export's immutable asset ID. A conditional SQLite update rejects stale decisions, and successful approval records `approvedAssetId`. Replacements start with no approval for the new asset while the previous approved asset remains available during staging or failure. Any future publisher must require both approved status and `approvedAssetId == finalAssetId` for the exact asset it sends. Legacy approvals without that binding must be reviewed again before publishing.

## Phase 7.4 — Manual moving video clips

Create a vertical Studio export first. In its storyboard, choose **Import MP4 for scene**. The browser streams a local MP4 to the localhost-only Studio endpoint with the selected scene ID and current export ID. The server limits uploads to 32 MiB, validates the MP4 signature, probes the container, and accepts one H.264 or HEVC video stream with bounded duration, dimensions and frame rate. Install both FFmpeg and ffprobe. `FLOW_FFMPEG_BIN` and `FLOW_FFPROBE_BIN` can select their executables. The upload uses server-owned temporary paths. External MOV track references are disabled.

FFmpeg letterboxes or pillarboxes the clip to 9:16, trims long clips or holds the last frame of short clips, and strips imported audio and metadata. The Studio soundtrack and subtitles remain in the export. The manual provider uses the existing video-provider method shape. The replacement batch activates only when the full export succeeds. The previous approved export stays active if import, normalization or export fails. The new version requires a fresh approval. Video and image regeneration reuse manual clips for the same scene IDs. The app asks for confirmation before replacing an imported clip or discarding imports. The last approved MP4 remains downloadable while the next export is produced and reviewed. Once a newer export is approved, the previous approved asset is marked archived and remains available by its asset URL. Archived exports consume local disk space and have no automatic retention limit.

Only one upload per media root can stream at a time. Startup uses the same lock to remove abandoned upload directories older than 24 hours. Before activating a replacement, the backend checks the expected H.264 video, AAC audio, subtitle stream, dimensions and duration with ffprobe, and decodes the video and audio to check for errors.

### Google Flow feasibility

- **Download path.** Google documents downloading generated clips from the asset menu. Users can download a video file themselves and import it here. The Flow Help pages reviewed document an interactive UI and do not establish an authorized Flow browser automation contract. Google separately documents a [Gemini API video generation](https://aistudio.google.com/docs/video), which would be a separate provider and billing decision. [Google Flow downloads](https://support.google.com/flow/answer/16935308?hl=en)
- **Terms and authentication.** Any future browser-assisted workflow needs an explicit authorization review against Google's terms, applicable service rules, and current machine-readable instructions. Interactive sign-in, MFA and consent stay with the user. Avoid storing, exporting or reusing session credentials. UI selectors, loading states and download completion would need authorized validation. [Google Terms](https://policies.google.com/terms) · [Generative AI Additional Terms](https://policies.google.com/terms/generative-ai)
- **Isolation and credits.** Chrome can isolate sessions using separate user-data directories. The four inert mock descriptors now also have distinct download directories. Rotation selects only a mock descriptor; it never launches Chrome or switches real accounts. Flow credits are account-scoped, so browser profiles do not create additional quota. A future approved provider should stop on account quota exhaustion and require explicit spend authorization. [Chromium profile isolation](https://www.chromium.org/developers/creating-and-using-profiles/) · [Google Flow credits](https://support.google.com/flow/answer/16526234?hl=en)

No Google sessions or Flow requests were used. Scheduled jobs still use mock providers.
