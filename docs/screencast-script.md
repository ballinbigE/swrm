# Screencast script (30 seconds)

Record this for the README hero GIF. Tool: any screen recorder + `gifski` to compress.

## Setup (before recording)
- Terminal + browser side by side, dark theme
- Clean `.loom/` (rm -rf .loom) so the board starts empty
- A throwaway git repo in cwd with at least one commit on `main`
- `ANTHROPIC_API_KEY` exported

## Beats (target ~30s)

1. **0-3s** — Terminal: type `npx loom`, hit enter. Show `[loom] http://localhost:5173` boot line.
2. **3-6s** — Browser opens localhost:5173. Home view shows the idea-input box (M8).
3. **6-11s** — Type into the box: `Add a dark-mode toggle that persists across sessions`. Click **Generate & Execute**.
4. **11-16s** — Plan preview renders: 4 stories appear with tech_stack badge. Click **Save & spawn first attempt**.
5. **16-20s** — Workspace opens. Left: conversation. Middle: diff (empty → quickstart card). Right: preview pane.
6. **20-25s** — Cut to the diff pane auto-refreshing as the agent commits (show the green +lines appearing). Status dot pulsing.
7. **25-30s** — Click a diff line → composer → type "tighten this" → cmd+enter. Press `m` → merge toast. End on the green "merged into main" toast.

## Caption overlay (optional)
- "idea → PRD → agent → diff → merge. localhost. `npx loom`."

## Export
```sh
# from a .mov
ffmpeg -i recording.mov -vf "fps=15,scale=1200:-1:flags=lanczos" -f gif - | gifski -o docs/demo.gif -
```
Then reference `docs/demo.gif` in README.md (replace the `<!-- TODO -->` marker).
