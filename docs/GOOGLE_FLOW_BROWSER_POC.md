# Phase 7.6A — Manual Chrome connection experiment

## Decision

**GO for a user-opened Chrome window, manual sign-in, manual downloads and local MP4 import. NO-GO for a Flow AI agent navigating the authenticated site, discovering projects, generating clips or downloading them.** The public sources reviewed on November 12, 2026 document user actions and the in-product Agent. They do not establish permission for the proposed third-party browser automation or a Flow-credit API. The absence of a documented permission leaves automation unclear. The experiment implements only the manual path. Account access and entitlement were not tested.

- Google's US Terms of Service, effective July 30, 2026, prohibit bypassing protective measures and automated access that violates site machine-readable instructions. Check the version for your region. The prohibited-use policy also restricts compromising service security. [Google Terms of Service](https://policies.google.com/terms) · [Generative AI Prohibited Use Policy](https://policies.google.com/terms/generative-ai/use-policy)
- Google Account Help explains that Google may block insecure sign-ins and that Workspace password-only third-party access is unsupported. Google's OAuth policy independently prohibits developer-controlled embedded user agents for Google OAuth. This experiment does not initiate OAuth authorization and offers no credential, cookie or MFA interface. The user checks the origin and signs in through Chrome. If Google denies access or challenges a sign-in, follow Google's own UI and stop if access remains denied. [Google Account Help](https://support.google.com/accounts/answer/6010255?hl=en) · [Google OAuth secure-browser policy](https://developers.google.com/identity/protocols/oauth2/policies#secure-browser)
- The Google Flow Agent is built into Flow. Leave **Confirm before generating** set to **Always** and personally review each model, output count and credit charge. Google's documented download path is the asset menu. The local launcher starts a separate Chrome user-data directory without DevTools or browser control. An isolated profile is a local storage boundary. [Flow Agent settings](https://support.google.com/flow/answer/17093911?hl=en) · [Flow downloads](https://support.google.com/flow/answer/16935308?hl=en#zippy=%2Cdownload-your-videos-from-google-flow) · [Chromium profiles](https://www.chromium.org/developers/creating-and-using-profiles/) · [Chrome debugging security](https://developer.chrome.com/blog/remote-debugging-port)

## Local setup

Use a terminal on the machine with Chrome and FFmpeg/ffprobe installed. The terminal commands are disabled by default. There is no web route to launch Chrome or browse the local file system. The dedicated profile lives at `~/.flow-ai-google-flow-browser` and remains under your control. Chrome may retain its own sign-in session there. Flow AI does not read it. The launcher reports `login_required` as a manual checkpoint because it does not observe Chrome's authentication state.

```bash
PYTHONPATH=backend FLOW_GOOGLE_FLOW_BROWSER_POC=1 \
  python -m flow_api.studio.flow_browser launch --confirm-open
```

Use Chrome's own controls to download an existing clip into a dedicated directory such as `~/Downloads/FlowAI`. To test without accessing Google, put a locally generated six-second 9:16 moving MP4 in that directory. Keep the original clip and its watermark. Transcoding does not establish preservation of invisible SynthID.

```bash
PYTHONPATH=backend FLOW_GOOGLE_FLOW_BROWSER_POC=1 \
  python -m flow_api.studio.flow_browser watch "$HOME/Downloads/FlowAI"
```

The watcher reads only the selected directory's regular MP4 files. It ignores unfinished Chrome files, waits for stable file metadata across scans, snapshots up to 32 MiB, checks the MP4 signature and runs ffprobe. It reports a SHA-256 and duration for eligible six-second portrait clips. Duplicate detection is local to the watcher session and never submits an import. Stop it with Ctrl+C.

Start the existing Studio backend on `127.0.0.1` with `--no-proxy-headers` and `FLOW_GOOGLE_FLOW_MANUAL=1`. Prepare a finished vertical project with six-second scenes. Use the existing Studio file picker or explicitly import from the terminal. The project ID is in the Studio project response, and `GET /api/studio/projects/<project-id>` on the local backend returns `finalAssetId`, `scenes[].id`, `scenes[].index` and clip asset IDs. Review the target scene visually. Scene confirmation uses its one-based display number.

```bash
PYTHONPATH=backend FLOW_GOOGLE_FLOW_BROWSER_POC=1 \
  python -m flow_api.studio.flow_browser import "$HOME/Downloads/FlowAI/clip.mp4" \
  --project PROJECT_ID --scene SCENE_ID --export FINAL_ASSET_ID \
  --confirm-scene 1 --sha256 WATCHER_SHA256
```

For a scene with an existing imported clip, also pass `--replace-asset CURRENT_CLIP_ID`. The command checks file bytes against the supplied digest, talks only to loopback, and confirms the exact persisted operation and active result. The existing import pipeline checks motion, validates the staged export and keeps previous approvals and archives. Review and approve the new MP4 in Studio. Ctrl+C requests cancellation only for the returned operation ID. If the upload response was lost before the ID arrived, check Studio before retrying. The terminal does not approve or publish the result.
