# Quotid — LikeC4 architecture

Architecture-as-code using [LikeC4](https://likec4.dev). One `.c4` source, four views:

| View | Level | Purpose |
|---|---|---|
| `index` | C1 — Context | System boundary + external SaaS |
| `containers` | C2 — Container | Internals of Quotid |
| `production` | Supplementary — Deployment | Physical topology on Oracle Cloud VM |
| `callFlow` | Supplementary — Dynamic (graph) | End-to-end trace of a nightly journaling call |
| `callSequence` | Supplementary — Dynamic (sequence) | Same flow as a UML sequence diagram, with responses |

Not yet defined: **C3 — Component** (internals of a single container, e.g. Pipecat's pipeline classes), and **C4 — Code** (UML class diagrams zoomed into one component). Skip until they're actually needed for a design conversation.

## Preview interactively

From the repo root (no install required):

```bash
npx likec4 serve docs/architecture/likec4
```

Opens a live-reload web UI on `http://localhost:5173`. Drag boxes to re-arrange; layout is saved per-view. Zoom, pan, click to drill into elements.

## Build static HTML for hosting

```bash
npx likec4 build docs/architecture/likec4 -o docs/architecture/dist
```

Produces a static bundle in `docs/architecture/dist` that you can serve from any web server (or a subpath of your main site) as an interactive architecture viewer.

## Export PNGs for slides or embeds

```bash
npx likec4 export png docs/architecture/likec4 -o docs/architecture/assets
```

One PNG per view. Useful for README embeds and interview decks.

## Regenerate the Mermaid versions

If you want Mermaid output for GitHub's inline renderer (which LikeC4's HTML bundle won't reach):

```bash
npx likec4 codegen mermaid docs/architecture/likec4
```

## Pinning the CLI

If you want reproducibility across machines, install locally:

```bash
npm install --save-dev --prefix docs/architecture/likec4 likec4
```

Then swap `npx likec4` for `pnpm exec likec4` (or `npm exec likec4`) in the commands above.

## File organization

Everything lives in `quotid.c4` as a single file for now. When the model grows, split along natural seams:

- `specification.c4` — element and relationship kinds
- `model.c4` — logical architecture
- `deployment.c4` — physical layout
- `views.c4` — view definitions

LikeC4 auto-merges all `.c4` files in the workspace.
