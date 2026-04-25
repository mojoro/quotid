# Deprecated architecture artifacts

These are design-phase artifacts kept as evidence of the design process. They do NOT reflect the current shipped system.

**Contents:**
- `c4-context.md`, `c4-containers.md`, `c4-deployment.md`, `c4-dynamic-call-flow.md` — early-design Mermaid C4 diagrams superseded by `../likec4/quotid.c4` before any code was shipped.
- `SESSION_HANDOFF.md` — session-to-session execution log used during the build, including the divergence audit between design intent and shipped reality. Its operational content has been distilled into the repo-root `CLAUDE.md`.

For the current shipped system:
- `/CLAUDE.md` (repo root) — operational ground truth, auto-loaded by Claude Code
- `../likec4/quotid.c4` — C4 (context, containers, deployment, dynamic views)
- `../pipecat-pipeline.md` — voice pipeline detail
- `../temporal-workflow.md` — workflow + activities
- `../transcription-interface.md` — Modal/WhisperX seam (deferred)
- `../api/` — OpenAPI 3.1 specs + Server Actions
