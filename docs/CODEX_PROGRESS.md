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
