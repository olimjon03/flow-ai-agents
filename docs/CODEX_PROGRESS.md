# Codex progress

## Phase 7.1 — DeepSeek storyboard

Media Studio generates five ordered six-second scenes for new 30-second scripts. Each scene includes a visual prompt and voiceover. Other mock durations and saved projects keep their existing format.

Start the mock workflow and review the script. With the server configured for Deploy and a 30-second project, the approval screen offers an unchecked option to allow a paid DeepSeek storyboard. The approval request must explicitly include `allowPaid: true`. Mock approval remains the default even on a Deploy-enabled server.

The paid path sends the approved script to the existing Deploy adapter and validates five ordered scenes before replacing the preview. It uses the existing per-run budget, request deadline, retry, cancellation, and AI Office usage accounting. Invalid output stops the job and preserves the preview so approval can be retried. The existing local media generation and FFmpeg export follow successful approval.
