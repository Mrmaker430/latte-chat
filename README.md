# Latte — AI Chat & Image Studio

A production-grade AI workspace: streaming chat, specialist agents and a parallel
image studio, wrapped in a warm **cream & brown glass** interface.

Backend: [FastAPI](https://fastapi.tiangolo.com/) over the public API of the
[`aimind`](https://pypi.org/project/aimind/) Python module (chat models, streaming,
vision attachments, 27 agents, image generation). No API keys required by `aimind`
itself.

```bash
./run.sh            # or: pip install -r requirements.txt && python3 server.py
# → http://localhost:8000
```

## Termux (Android) quickstart

```bash
# one-time setup
pkg update && pkg install -y python
termux-setup-storage                 # only if the zip is in your Downloads folder

# get the zip into $HOME (adjust the filename if needed)
cp ~/storage/downloads/latte-chat.zip ~/

# unpack, install, run
cd ~ && python -m zipfile -e latte-chat.zip .     # no unzip binary needed
cd latte-chat
pip install -r requirements.txt                   # add --break-system-packages if pip refuses
python server.py                                  # → http://localhost:8000
```

Tips: `termux-wake-lock` keeps Android from sleeping mid-chat; open
`http://<phone-ip>:8000` from any device on the same Wi‑Fi; everything is pure
Python, so nothing needs to be compiled on Android.

---

## What's inside

| Area | Details |
| --- | --- |
| **Chat** | True token streaming over SSE (`POST /api/chat`), markdown + syntax highlighting, tables, task lists, code copy, retry, read-aloud (Web Speech), per-message latency |
| **Image studio** | Aspect (8), style (11), quality (3), 1–4 parallel renders arriving as they finish, seeds, negative prompts, lightbox viewer, download, reuse-as-attachment |
| **Vision** | Attach up to 4 images (drag-drop, paste, picker; ≤5 MB each) — sent inline to `aimind` |
| **Agents** | All 27 built-in `aimind` specialists behind one picker |
| **Memory** | Per-conversation `AIMind` instances (LRU-capped server-side) + a live context-window meter |
| **Sessions** | Multiple conversations, switch/replay/delete, titles auto-derived |
| **Command palette** | `Ctrl/⌘+K` — fuzzy search over commands, models and agents |
| **Theming** | Light / Auto / Dark (espresso), adjustable glass blur, text scale, motion toggle — persisted in `localStorage` |

## Keyboard

| Keys | Action |
| --- | --- |
| `Enter` / `Shift+Enter` | send / newline |
| `⌘/Ctrl+K` | command palette |
| `⌘/Ctrl+J` | new chat |
| `⌘/Ctrl+,` | settings drawer |
| `⌘/Ctrl+B` | sidebar (mobile) |
| `/` | focus composer |
| `Esc` | close overlay / stop generation |
| `←` `→` | navigate images in the lightbox |

---

## Design system (the "research" part)

**Type.** Plus Jakarta Sans (UI) · Instrument Serif (display accents) ·
JetBrains Mono (code). 1.200 ratio scale anchored on 15 px; line-heights
1.62 body / 1.38 snug / 1.18 display; reading measure capped at ~74 ch.
`font-synthesis-weight: none` and full `font-feature-settings` for clean digits.

**Colour.** Two hand-tuned scales — *cream* `#FFFDF8 → #DFCDB1` and
*brown* `#E0B98C → #2A1A10`. Text inks are contrast-checked on cream:
primary **14.6:1**, secondary **8.4:1**, tertiary **4.6:1** (all ≥ WCAG AA,
most AAA). Dark mode swaps to an espresso base with the same ratios.

**Space.** 4 px base scale (`--s-1 … --s-11`); 8 pt rhythm between message
blocks; gutters step 32 → 24 → 16 px across breakpoints.

**Shape.** Nested-radius rule: inner radius = outer radius − padding, so
curves stay concentric (bubbles 26 px, panels 22–28 px, pills ∞).

**Glass & liquid.** Layered ambient canvas (4 drifting radial blooms + a slow
conic sheen) *behind* frosted panels (`backdrop-filter: blur+saturate`), each
panel carrying a 1 px gradient sheen rim and inner top light. Film-grain is a
data-URI `feTurbulence` painted **under** the glass and masked away from text
surfaces — type stays razor sharp ("noise-free words").

**Motion.** One spring (`cubic-bezier(.34,1.56,.64,1)`) for presses, one
decel curve for entrances; 140/240/420 ms tiers; 26 s ambient drift. All of it
collapses under `prefers-reduced-motion`.

**Responsive & adaptive.** 5 breakpoints (1280/1080/860/620/400) + short-viewport
and hover/pointer queries: sidebar becomes a slide-over, chips go full-width,
touch targets ≥ 44 px, safe-area insets respected, `dvh` everywhere.
Also honours `prefers-contrast`, `forced-colors`, and prints cleanly.

**A11y.** Skip link, `role=log` stream with polite live region, labelled
listboxes/menus/switches, visible focus rings, ARIA-checked options, toasts in
a live region, and a high-contrast token override.

---

## HTTP API (all JSON unless noted)

| Route | Notes |
| --- | --- |
| `GET /api/bootstrap` | fresh session + model/agent/style catalogues |
| `POST /api/chat` | **SSE** `ack · meta · token · done · error · end` |
| `POST /api/image` | **SSE** `start · image(n) · ping · done · end` |
| `POST /api/upload` | multipart → `{id, data_uri}` (vision attachments) |
| `GET /api/sessions` · `GET /api/history/{id}` · `DELETE /api/session/{id}` | conversation management |
| `POST /api/new` · `POST /api/regenerate` · `POST /api/memory/clear` · `GET /api/memory/{id}` | turns & context |
| `GET /api/health` | `aimind.ping()` proxy |
| `GET /gen/{file}` · `GET /media/{file}` | generated & uploaded images (path-traversal guarded) |

Errors are always JSON `{error}`; a global handler converts stray exceptions
into 500s with a message the UI can show.

## Layout

```
server.py            FastAPI + aimind bridge (sessions, SSE, uploads)
static/index.html    shell + inline SVG sprite
static/css/          tokens · base · layout · components · overlays · responsive
static/js/md.js      markdown renderer + warm syntax highlighter (no deps)
static/js/app.js     client (SSE reader, studio, palette, theming)
gen/ media/          generated renders & uploads (bounded, pruned)
qa.py                Playwright visual/console QA harness
```

## Notes

- `aimind` is proprietary-licensed: this project only calls its **documented
  public API** (`AIMind`, `chat_stream`, `generate_image`, agents, memory).
- Sessions live in server memory (LRU-capped at 24) — restart resets them;
  generated images persist in `gen/` (oldest pruned past 240 files).
  
