# ShotSwap Timeline Review

**ShotSwap Timeline Review** is a lightweight, portable web-based VFX timeline player and version review suite. It syncs directly with DaVinci Resolve timelines (even when Resolve is closed) and allows editorial teams, VFX supervisors, and directors to scrub cuts, A/B compare shot versions, inspect handles, split-wipe passes, and swap cut versions in real-time.

---

## Key Features

- **Direct Resolve DB Sync**: Connects directly to DaVinci Resolve SQLite project databases (`Project.db`) — reads conformed cut timing and track overrides instantly without requiring DaVinci Resolve to be running.
- **ShotSwap Interactive Version Player**: Seamless dual ping-pong video player with instant A/B and A/C split-wipe comparison.
- **Handle Trimming & Conform Accuracy**: Shows source in/out and conformed record ranges frame-for-frame against the offline cut.
- **Batch Web Proxy Transcoding**: Background GPU NVENC / CPU proxy generator for smooth in-browser playback of high-res QuickTime ProRes / DNxHR renders.
- **Export Interchange**: Export updated cut choices to EDL, CSV, JSON, or directly push version swaps back into DaVinci Resolve tracks.
- **Production-Agnostic**: Configurable for any filesystem layout, shot naming convention, and department kind tags.

---

## Quick Start for a New Production

1. **Clone or Copy** this repository into your show directory (e.g. as a subfolder called `review/` or `shotswap/`):
   ```bash
   git clone <repo-url> shotswap_timeline_review
   cd shotswap_timeline_review
   ```

2. **Run the Setup Wizard**:
   * On Windows: Double-click `setup_production.bat` (or run `py setup_production.py`)
   * On macOS / Linux: `python3 setup_production.py`
   
   The interactive wizard will guide you through:
   - Production name and prefix
   - Media root directory (where shot folders are located)
   - DaVinci Resolve project database location
   - Shot code naming regex (presets available)
   - File extensions and kind keywords (`CMP`, `COMP`, `VID`, `UPRES`, `GEN`, etc.)

3. **Launch the Player**:
   * On Windows: Double-click `launch_player.bat`
   * On macOS / Linux: `./launch_player.command` or `python3 server.py`
   * Opens automatically in your browser at `http://127.0.0.1:8080/review/`

---

## File Architecture

| File | Purpose |
|---|---|
| `setup_production.py` | Interactive Q&A wizard to configure production paths and file search rules |
| `shotswap_config.json` | Generated local configuration (git-ignored) |
| `shotswap_config.template.json` | Default configuration template |
| `server.py` | Lightweight HTTP Range server & Resolve DB API |
| `rescan_versions.py` | Reads Resolve timeline and scans media folders for new versions |
| `generate_proxies.py` | Background GPU/CPU ffmpeg proxy transcoder |
| `resolve_timeline_sync.py` | Pushes swapped version choices back into DaVinci Resolve tracks |
| `index.html` / `app.js` / `style.css` | Interactive browser-based ShotSwap timeline interface |

---

## License & Usage
Portable VFX Timeline Review Suite. Configured for multi-project deployment.
