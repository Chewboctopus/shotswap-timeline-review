import os, sys, json, re, subprocess, threading, sqlite3, shutil, tempfile
from urllib.parse import urlparse, parse_qs
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from datetime import datetime
from config_loader import load_config, get_resolve_search_roots

review_dir = Path(os.path.abspath(__file__)).parent
config = load_config()
base_path = Path(config.get("filesystem", {}).get("media_root") or review_dir.parent)
resolve_root = base_path.parent / "RESOLVE PROJECT" if (base_path.parent / "RESOLVE PROJECT").exists() else base_path

# Global task state for background Rescan / Proxy Generation triggered from the UI
task_state = {
    "running": False,
    "task_type": None,   # "rescan" | "proxies" | "load_timeline"
    "last_line": "Idle",
    "log_lines": [],
    "exit_code": None
}
state_lock = threading.Lock()

def discover_resolve_projects():
    projects = []
    search_roots = get_resolve_search_roots(config)
    for sr in search_roots:
        if sr.exists():
            sr_str = str(sr).upper()
            if "APPDATA" in sr_str or "ROAMING" in sr_str:
                lib_label = "Local Disk DB"
            elif "PROGRAMDATA" in sr_str:
                lib_label = "System DB"
            elif "RESOLVE 19" in sr_str:
                lib_label = "Resolve 19"
            else:
                lib_label = sr.parent.name or "Project Library"
            for p_dir in sorted(sr.iterdir()):
                db_f = p_dir / "Project.db"
                if p_dir.is_dir() and db_f.exists():
                    projects.append({
                        "name": f"{p_dir.name} ({lib_label})",
                        "project_name": p_dir.name,
                        "db_path": str(db_f),
                        "mtime": db_f.stat().st_mtime
                    })
    projects.sort(key=lambda x: x["mtime"], reverse=True)
    return projects

# Cache timelines per (db_path, mtime) so /api/resolve/projects responds in <10ms
_timeline_cache = {}

def list_timelines_in_db(db_path_str):
    db_p = Path(db_path_str)
    if not db_p.exists():
        return []
    try:
        mtime = db_p.stat().st_mtime
        cache_key = (str(db_p), mtime)
        if cache_key in _timeline_cache:
            return _timeline_cache[cache_key]

        # Open directly in read-only URI mode first (instant, no file copy over network)
        uri = f"file:{db_p.as_posix()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=5.0)
        cur = conn.cursor()
        rows = cur.execute("""
            SELECT Name, ModTimeInSecs, CreateTimeInSecs
            FROM Sm2Timeline
            ORDER BY CreateTimeInSecs DESC, ModTimeInSecs DESC
        """).fetchall()
        conn.close()
        result = [{"name": r[0], "mod_time": r[1], "create_time": r[2]} for r in rows if r[0]]
        _timeline_cache[cache_key] = result
        return result
    except Exception as e:
        print(f"Error listing timelines from {db_path_str}: {e}")
        return []

def run_background_script(task_type, script_path, extra_args=None):
    with state_lock:
        task_state["running"] = True
        task_state["task_type"] = task_type
        task_state["last_line"] = f"Starting {task_type}..."
        task_state["log_lines"] = []
        task_state["exit_code"] = None

    try:
        cmd = [sys.executable, "-u", str(script_path)]
        if extra_args:
            cmd.extend(extra_args)
        proc = subprocess.Popen(
            cmd,
            cwd=str(review_dir),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace"
        )
        for line in proc.stdout:
            clean = line.strip()
            if clean:
                with state_lock:
                    task_state["last_line"] = clean
                    task_state["log_lines"].append(clean)
                    if len(task_state["log_lines"]) > 100:
                        task_state["log_lines"].pop(0)
        proc.wait()
        with state_lock:
            task_state["exit_code"] = proc.returncode
            task_state["running"] = False
            if proc.returncode == 0 and not task_state["last_line"].startswith("SUCCESS"):
                task_state["last_line"] = f"Completed {task_type} successfully."
    except Exception as e:
        with state_lock:
            task_state["last_line"] = f"Error: {e}"
            task_state["exit_code"] = 1
            task_state["running"] = False


class ShotSwapReviewHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(base_path), **kwargs)

    def log_message(self, format, *args):
        # Suppress noisy static asset logs; only log API calls
        first = str(args[0]) if args else ""
        if "/api/" in first:
            super().log_message(format, *args)

    def guess_type(self, path):
        # Serve H.264 .mov and .mp4 as video/mp4 so Chrome plays QuickTime H.264/AAC containers inline
        if str(path).lower().endswith((".mov", ".mp4")):
            return "video/mp4"
        return super().guess_type(path)

    def serve_file_with_range(self, file_path):
        if not os.path.isfile(file_path):
            self.send_json({"ok": False, "error": f"File not found: {file_path}"}, 404)
            return
        try:
            file_size = os.path.getsize(file_path)
            ctype = self.guess_type(file_path)
            max_chunk = 8 * 1024 * 1024  # 8 MB max per Range response so large 1.5GB .mov files never hog a connection
            if "Range" in self.headers:
                m = re.match(r"bytes=(\d+)-(\d*)", self.headers["Range"])
                if m:
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), file_size - 1)
                    else:
                        end = min(file_size - 1, start + max_chunk - 1)
                    if start <= end:
                        length = end - start + 1
                        self.send_response(206)
                        self.send_header("Content-Type", ctype)
                        self.send_header("Accept-Ranges", "bytes")
                        self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                        self.send_header("Content-Length", str(length))
                        self.end_headers()
                        with open(file_path, "rb") as f:
                            f.seek(start)
                            remaining = length
                            while remaining > 0:
                                chunk = f.read(min(65536, remaining))
                                if not chunk:
                                    break
                                self.wfile.write(chunk)
                                remaining -= len(chunk)
                        return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(file_size))
            self.end_headers()
            with open(file_path, "rb") as f:
                shutil.copyfileobj(f, self.wfile)
        except (ConnectionAbortedError, BrokenPipeError):
            return
        except Exception as e:
            print(f"Error serving {file_path}: {e}")

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return

        if parsed.path == "/api/status":
            with state_lock:
                snap = dict(task_state)
            self.send_json(snap)
            return

        if parsed.path == "/api/config":
            self.send_json({"ok": True, "config": config})
            return

        if parsed.path == "/api/resolve/projects":
            projects = discover_resolve_projects()
            manifest_file = review_dir / "cut_manifest.json"
            configured_db = config.get("resolve", {}).get("default_project_db", "")
            fallback_db = projects[0]["db_path"] if projects else ""
            default_db = configured_db if configured_db and os.path.exists(configured_db) else fallback_db
            cur_db = default_db
            cur_tl = ""
            cur_media = str(base_path)
            if manifest_file.exists():
                try:
                    with open(manifest_file, "r", encoding="utf-8") as f:
                        mdata = json.load(f)
                        saved_db = mdata.get("project_db", cur_db)
                        if saved_db and os.path.exists(saved_db):
                            cur_db = saved_db
                        cur_tl = mdata.get("timeline_name", "")
                        saved_media = mdata.get("media_source", cur_media)
                        if saved_media and os.path.exists(saved_media):
                            cur_media = saved_media
                except Exception:
                    pass
            timelines = list_timelines_in_db(cur_db)
            self.send_json({
                "ok": True,
                "projects": projects,
                "current_project_db": cur_db,
                "current_timeline": cur_tl,
                "current_media_source": cur_media,
                "timelines": timelines
            })
            return

        if parsed.path == "/api/resolve/timelines":
            qs = parse_qs(parsed.query)
            db_path = qs.get("project_db", [""])[0]
            timelines = list_timelines_in_db(db_path)
            self.send_json({"ok": True, "timelines": timelines})
            return

        if parsed.path == "/api/external-media":
            qs = parse_qs(parsed.query)
            ext_path = qs.get("path", [""])[0]
            self.serve_file_with_range(ext_path)
            return

        if parsed.path == "/api/resolve/ref-movies":
            ref_dir = resolve_root / "RESOLVE 19" / "EDL and Ref"
            movies = []
            if ref_dir.exists():
                for f in ref_dir.iterdir():
                    if f.is_file() and f.suffix.lower() in (".mov", ".mp4"):
                        st = f.stat()
                        movies.append({
                            "name": f.name,
                            "path": str(f),
                            "mtime": st.st_mtime,
                            "date_formatted": datetime.fromtimestamp(st.st_mtime).strftime("%b %d, %Y %I:%M %p"),
                            "size_mb": round(st.st_size / (1024 * 1024), 1)
                        })
            movies.sort(key=lambda x: x["mtime"], reverse=True)
            self.send_json({"ok": True, "movies": movies})
            return

        if parsed.path == "/api/manifest":
            manifest_file = review_dir / "cut_manifest.json"
            if manifest_file.exists():
                with open(manifest_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self.send_json({"ok": True, "manifest": data})
            else:
                self.send_json({"ok": False, "error": "cut_manifest.json not found"}, 404)
            return

        # Support HTTP Range requests for smooth HTML5 <video> scrubbing
        path = self.translate_path(self.path)
        if os.path.isfile(path) and "Range" in self.headers:
            self.serve_file_with_range(path)
            return

        try:
            super().do_GET()
        except (ConnectionAbortedError, BrokenPipeError):
            pass

    def do_POST(self):
        content_len = int(self.headers.get("Content-Length", 0))
        body_data = {}
        if content_len > 0:
            try:
                body_data = json.loads(self.rfile.read(content_len).decode("utf-8"))
            except Exception:
                body_data = {}

        if self.path.startswith("/api/dialog/folder"):
            initial_dir = body_data.get("initial_dir", str(base_path))
            title = body_data.get("title", "Select Folder")
            if not os.path.isdir(initial_dir):
                initial_dir = str(base_path)
            try:
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk()
                root.withdraw()
                root.attributes("-topmost", True)
                chosen = filedialog.askdirectory(initialdir=initial_dir, title=title, parent=root)
                root.destroy()
                if chosen:
                    chosen = os.path.normpath(chosen)
                    self.send_json({"ok": True, "path": chosen})
                else:
                    self.send_json({"ok": False, "cancelled": True})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 500)
            return

        if self.path.startswith("/api/dialog/file"):
            initial_dir = body_data.get("initial_dir", str(resolve_root / "RESOLVE 19" / "EDL and Ref"))
            title = body_data.get("title", "Select File")
            kind = body_data.get("kind", "video")
            if not os.path.isdir(initial_dir):
                initial_dir = str(base_path)
            try:
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk()
                root.withdraw()
                root.attributes("-topmost", True)
                if kind == "db":
                    ftypes = [("Resolve Project DB", "Project.db *.db"), ("All Files", "*.*")]
                else:
                    ftypes = [("Video Files", "*.mov *.mp4 *.m4v"), ("All Files", "*.*")]
                chosen = filedialog.askopenfilename(initialdir=initial_dir, title=title, filetypes=ftypes, parent=root)
                root.destroy()
                if chosen:
                    chosen = os.path.normpath(chosen)
                    self.send_json({"ok": True, "path": chosen, "name": os.path.basename(chosen)})
                else:
                    self.send_json({"ok": False, "cancelled": True})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 500)
            return

        if self.path.startswith("/api/resolve/load"):
            with state_lock:
                if task_state["running"]:
                    self.send_json({"ok": False, "error": f"Task '{task_state['task_type']}' is already running."}, 409)
                    return
            proj_db = body_data.get("project_db", "")
            tl_name = body_data.get("timeline_name", "")
            media_src = body_data.get("media_source", str(base_path))
            fast_mode = body_data.get("fast", True)

            cli_args = []
            if proj_db:
                cli_args.extend(["--project-db", proj_db])
            if tl_name:
                cli_args.extend(["--timeline", tl_name])
            if media_src:
                cli_args.extend(["--media-source", media_src])
            if fast_mode:
                cli_args.append("--fast")

            t = threading.Thread(
                target=run_background_script,
                args=("load_timeline", review_dir / "rescan_versions.py", cli_args),
                daemon=True
            )
            t.start()
            self.send_json({"ok": True, "started": "load_timeline"})
            return

        if self.path.startswith("/api/rescan"):
            with state_lock:
                if task_state["running"]:
                    self.send_json({"ok": False, "error": f"Task '{task_state['task_type']}' is already running."}, 409)
                    return
            t = threading.Thread(target=run_background_script, args=("rescan", review_dir / "rescan_versions.py"), daemon=True)
            t.start()
            self.send_json({"ok": True, "started": "rescan"})
            return

        if self.path.startswith("/api/dialog/save-file"):
            initial_dir = body_data.get("initial_dir", str(base_path))
            default_name = body_data.get("default_name", "SHOTSWAP_CUT_BURNIN.mp4")
            title = body_data.get("title", "Save File As")
            kind = body_data.get("kind", "video")
            if not os.path.isdir(initial_dir):
                initial_dir = str(review_dir / "exports")
                os.makedirs(initial_dir, exist_ok=True)
            try:
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk()
                root.withdraw()
                root.attributes("-topmost", True)
                if kind == "drt":
                    ftypes = [("DaVinci Resolve Timeline", "*.drt"), ("All Files", "*.*")]
                    def_ext = ".drt"
                else:
                    ftypes = [("MP4 Video", "*.mp4"), ("QuickTime MOV", "*.mov"), ("All Files", "*.*")]
                    def_ext = ".mp4"
                chosen = filedialog.asksaveasfilename(
                    initialdir=initial_dir,
                    initialfile=default_name,
                    defaultextension=def_ext,
                    title=title,
                    filetypes=ftypes,
                    parent=root
                )
                root.destroy()
                if chosen:
                    chosen = os.path.normpath(chosen)
                    self.send_json({"ok": True, "path": chosen, "name": os.path.basename(chosen)})
                else:
                    self.send_json({"ok": False, "cancelled": True})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 500)
            return

        if self.path.startswith("/api/resolve/sync-timeline"):
            with state_lock:
                if task_state["running"]:
                    self.send_json({"ok": False, "error": f"Task '{task_state['task_type']}' is already running."}, 409)
                    return
            try:
                body_data["base_path"] = str(base_path)
                fd, spec_file = tempfile.mkstemp(prefix="shotswap_sync_", suffix=".json")
                os.close(fd)
                with open(spec_file, "w", encoding="utf-8") as sf:
                    json.dump(body_data, sf, indent=2)
                t_type = body_data.get("mode", "update_timeline")
                t = threading.Thread(
                    target=run_background_script,
                    args=(t_type, review_dir / "resolve_timeline_sync.py", [spec_file]),
                    daemon=True
                )
                t.start()
                self.send_json({"ok": True, "started": t_type})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 500)
            return

        if self.path.startswith("/api/export-movie"):
            with state_lock:
                if task_state["running"]:
                    self.send_json({"ok": False, "error": f"Task '{task_state['task_type']}' is already running."}, 409)
                    return
            try:
                fd, spec_file = tempfile.mkstemp(prefix="shotswap_export_", suffix=".json")
                os.close(fd)
                with open(spec_file, "w", encoding="utf-8") as sf:
                    json.dump(body_data, sf, indent=2)
                t = threading.Thread(
                    target=run_background_script,
                    args=("export_movie", review_dir / "export_burnin_movie.py", [spec_file]),
                    daemon=True
                )
                t.start()
                self.send_json({"ok": True, "started": "export_movie", "output_path": body_data.get("output_path", "")})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 500)
            return

        if self.path.startswith("/api/generate-proxies"):
            with state_lock:
                if task_state["running"]:
                    self.send_json({"ok": False, "error": f"Task '{task_state['task_type']}' is already running."}, 409)
                    return
            t = threading.Thread(target=run_background_script, args=("proxies", review_dir / "generate_proxies.py"), daemon=True)
            t.start()
            self.send_json({"ok": True, "started": "proxies"})
            return

        self.send_json({"ok": False, "error": "Unknown endpoint"}, 404)


class ExclusiveThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False


def is_shotswap_server_running(port):
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=1.5) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode("utf-8"))
                return "running" in data and "last_line" in data
    except Exception:
        pass
    return False


def is_port_in_use(port):
    import socket
    for family, addr in ((socket.AF_INET, ("127.0.0.1", port)), (socket.AF_INET6, ("::1", port))):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.settimeout(0.4)
                if s.connect_ex(addr) == 0:
                    return True
        except Exception:
            pass
    return False


if __name__ == "__main__":
    import webbrowser
    start_port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    no_browser = "--no-browser" in sys.argv

    server = None
    bound_port = None

    for candidate_port in range(start_port, start_port + 20):
        # First check if a ShotSwap review server is already alive on this port
        if is_shotswap_server_running(candidate_port):
            url = f"http://127.0.0.1:{candidate_port}/review/"
            print(f"ShotSwap Review Server is already running at {url}")
            if not no_browser:
                print(f"Opening {url} in your browser...")
                webbrowser.open(url)
            sys.exit(0)

        # If another service is listening on this port, skip it!
        if is_port_in_use(candidate_port):
            print(f"Port {candidate_port} is in use by another service — trying {candidate_port + 1}...")
            continue

        try:
            server = ExclusiveThreadingHTTPServer(("0.0.0.0", candidate_port), ShotSwapReviewHandler)
            bound_port = candidate_port
            break
        except OSError as e:
            print(f"Port {candidate_port} unavailable ({e}) — trying {candidate_port + 1}...")
            continue

    if server is None or bound_port is None:
        print(f"ERROR: Could not bind to any port in range {start_port}-{start_port + 19}.")
        sys.exit(1)

    display_title = config.get("production", {}).get("display_title", "ShotSwap Timeline Review")
    url = f"http://127.0.0.1:{bound_port}/review/"
    print("========================================================")
    print(f"  {display_title} Server (with Resolve DB Sync)   ")
    print("========================================================")
    print(f"Serving root: {base_path}")
    print(f"Player URL:   {url}")
    print("API Ready:    /api/rescan | /api/generate-proxies | /api/status")
    print("Press Ctrl+C to stop.\n")

    if not no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
