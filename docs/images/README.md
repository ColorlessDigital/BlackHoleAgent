# Image provenance

These images explain BlackHole; they are not personal screenshots or live
model benchmark evidence. All visible workspaces, requests, model labels,
responses, errors and logs are hand-authored public demonstration fixtures.
The interface and scripted content are captured in English (`en-US`); changing
the isolated browser locale does not change a user's saved application language.

| Asset | Source |
|---|---|
| `overview.png` | Real built BlackHole frontend, scripted API/SSE data |
| `timeline.png` | Same frontend and fixture, execution timeline selected |
| `recovery.png` | Same frontend, scripted timeout/checkpoint event |
| `unverified.png` | Build31 frontend, separate single-file fixture without behavioral tests |
| `demo-plan.png`, `demo-working.png` | Intermediate frames of that fixture |
| `workflow-demo.gif` | Three static PNG frames encoded at 960x600, 1.8/2.0/3.2-second display delays |
| `architecture.svg` | Hand-authored conceptual architecture diagram |

The UI comes from the stabilized31 built frontend; its
agent behavior is not executed by the screenshot fixture. No API credential,
user conversation, model request, local file mutation or desktop screenshot
was involved. The built UI's external font request was blocked, so it uses
fallback system fonts. The overlay explicitly labels the fixture as scripted.

`tools/capture-docs.mjs` reproduces the PNGs from a built frontend in a headless
browser. `CAPTURE_REPORT.json` records the controlled capture scope and errors.
The GIF is not a recording of inference speed or task execution time.
The GIF can be regenerated with `tools/render-workflow-gif.mjs` and a separately
installed Sharp module (optional documentation tooling, not an agent dependency).
Supply `--sharp-module=<installed-module-path>` when it is not resolvable locally.
No image-generation model was used; there is no generated fake product UI.
The original PNG/GIF files have no EXIF/IPTC/XMP metadata.

Project-owned documentation graphics follow the repository license; upstream
UI assets/marks remain subject to their own notices in THIRD_PARTY.md.
