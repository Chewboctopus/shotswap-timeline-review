import os, sys, json, re, sqlite3, shutil, tempfile, argparse
from datetime import datetime
from pathlib import Path
from config_loader import (
    load_config,
    extract_shot_code,
    extract_version_string,
    detect_kind,
    is_ignored
)

review_dir = Path(os.path.abspath(__file__)).parent
config = load_config()

default_base_path = Path(config.get("filesystem", {}).get("media_root") or review_dir.parent)
default_resolve_root = default_base_path.parent / "RESOLVE PROJECT" if (default_base_path.parent / "RESOLVE PROJECT").exists() else Path(r"F:\RESOLVE PROJECT")
default_db = Path(config.get("resolve", {}).get("default_project_db") or (default_resolve_root / "RESOLVE 19" / "Resolve Project Library" / "Resolve Projects" / "Users" / "guest" / "Projects" / "PTH resolve 19" / "Project.db"))

parser = argparse.ArgumentParser(description="Sync Resolve Timeline from Project.db and scan media source for versions")
parser.add_argument("--project-db", default=str(default_db), help="Path to Resolve Project.db")
parser.add_argument("--timeline", default="", help="Specific timeline name to load")
parser.add_argument("--media-source", default=str(default_base_path), help="Root directory for shot media")
parser.add_argument("--fast", action="store_true", help="Reuse cached version lists for already-scanned shots when media-source has not changed")
args, _ = parser.parse_known_args()

base_path = Path(args.media_source)
if not base_path.exists():
    base_path = default_base_path
manifest_file = review_dir / "cut_manifest.json"
js_file = review_dir / "manifest.js"
resolve_db_path = Path(args.project_db)
if not resolve_db_path.exists() and default_db.exists():
    resolve_db_path = default_db
target_timeline_name = args.timeline.strip()
backup_root_cfg = config.get("backup", {}).get("backup_root")
backup_root = Path(backup_root_cfg) if backup_root_cfg else (review_dir / "backups")

if not manifest_file.exists():
    data = {
        "project": config.get("production", {}).get("name", "MY_PRODUCTION"),
        "timeline_name": "",
        "fps": 24,
        "start_frame": 86400,
        "start_timecode": "01:00:00:00",
        "total_shots": 0,
        "shots": []
    }
else:
    with open(manifest_file, "r", encoding="utf-8") as f:
        data = json.load(f)

# Build lookup of existing cached versions & active clips per shot_code before updating
prev_media_source = data.get("media_source", str(default_base_path))
prev_timeline_name = data.get("timeline_name", "")
old_known_versions = {}
old_active_clips = {}
cached_versions_by_shot = {}

for s in data.get("shots", []):
    sc = s.get("shot_code")
    if not sc:
        continue
    old_active_clips[sc] = s.get("active_clip", "")
    old_known_versions[sc] = set(v.get("base_name", "") for v in s.get("versions", []))
    if args.fast and os.path.normcase(prev_media_source) == os.path.normcase(str(base_path)) and s.get("versions"):
        cached_versions_by_shot[sc] = s["versions"]

data["project_db"] = str(resolve_db_path)
data["media_source"] = str(base_path)

def frames_to_tc(frame_num, fps=24):
    h = int(frame_num // (fps * 3600))
    m = int((frame_num % (fps * 3600)) // (fps * 60))
    s = int((frame_num % (fps * 60)) // fps)
    f = int(frame_num % fps)
    return f"{h:02d}:{m:02d}:{s:02d}:{f:02d}"

def read_latest_resolve_timeline_from_db():
    """Reads the latest timeline directly from Resolve's SQLite Project.db (works even when Resolve is closed)."""
    if not resolve_db_path.exists():
        print(f"Note: Resolve DB not found at {resolve_db_path}, keeping existing cut structure.")
        return None

    try:
        uri = f"file:{resolve_db_path.as_posix()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=10.0)
        cur = conn.cursor()

        base_v = config.get("resolve", {}).get("base_cut_track", 4)
        tl_pattern = config.get("resolve", {}).get("timeline_name_pattern", ".*")

        if target_timeline_name:
            row = cur.execute("""
                SELECT Sm2Timeline_id, Name, Sequence
                FROM Sm2Timeline
                WHERE Name = ?
                ORDER BY CreateTimeInSecs DESC, ModTimeInSecs DESC
                LIMIT 1
            """, (target_timeline_name,)).fetchone()
        else:
            all_tls = cur.execute("""
                SELECT Sm2Timeline_id, Name, Sequence
                FROM Sm2Timeline
                ORDER BY CreateTimeInSecs DESC, ModTimeInSecs DESC
            """).fetchall()
            row = None
            if all_tls:
                for cand_tl in all_tls:
                    if re.search(tl_pattern, cand_tl[1], re.IGNORECASE):
                        row = cand_tl
                        break
                if not row:
                    row = all_tls[0]

        if not row:
            conn.close()
            return None

        tl_id, tl_name, seq_id = row
        print(f"Found latest Resolve timeline in Project.db: {tl_name}")

        containers = cur.execute("SELECT Sm2SequenceContainer_id FROM Sm2SequenceContainer WHERE Sm2Sequence_id = ?", (seq_id,)).fetchall()
        if not containers:
            conn.close()
            return None

        cid = containers[0][0]
        # Type 0 = Video tracks; DbIndex 0 = V1, 3 = V4, 4 = V5, 5 = V6, 6 = V7, etc.
        tracks = cur.execute("""
            SELECT t.Sm2TiTrack_id, st.DbIndex
            FROM Sm2TiTrack t
            LEFT JOIN Sm2SequenceContainer_Sm2TiTrack st ON st.DbAssociate = t.Sm2TiTrack_id
            WHERE (t.Sm2SequenceContainer_id = ? OR st.DbOwner = ?) AND t.Type = 0
            ORDER BY st.DbIndex
        """, (cid, cid)).fetchall()

        tracks_by_v = {}
        for tr_id, db_idx in tracks:
            if db_idx is None:
                continue
            v_num = int(db_idx) + 1  # V1 = 1, V4 = 4, etc.
            if v_num < base_v:
                continue
            items_raw = cur.execute("""
                SELECT Name, Start, Duration, "In", Flags
                FROM Sm2TiItem
                WHERE Sm2TiTrack_id = ?
                ORDER BY CAST(Start AS INTEGER)
            """, (tr_id,)).fetchall()

            parsed_items = []
            for name, st_str, dur_str, in_str, flags in items_raw:
                if not name:
                    continue
                shot_code = extract_shot_code(name, config)
                if not shot_code:
                    continue
                r_start = int(float(st_str)) if st_str is not None else 0
                dur = int(float(dur_str)) if dur_str is not None else 0
                src_in = 0
                if in_str:
                    try:
                        src_in = int(float(str(in_str).split("|")[0]))
                    except Exception:
                        src_in = 0
                parsed_items.append({
                    "name": name,
                    "shot_code": shot_code,
                    "start": r_start,
                    "end": r_start + dur,
                    "duration": dur,
                    "source_in": src_in,
                    "source_out": src_in + dur,
                    "track": f"V{v_num}",
                    "v_num": v_num
                })
            tracks_by_v[v_num] = parsed_items

        conn.close()
        return {"timeline_name": tl_name, "tracks_by_v": tracks_by_v}
    except Exception as e:
        print(f"Warning reading Resolve DB: {e}")
        return None

def make_file_entry(p, file_map, display_stem=None):
    fname = p.name
    kind = detect_kind(fname, config)
    version_str = extract_version_string(fname, config)

    try:
        stat = p.stat()
        mtime = stat.st_mtime
        size = stat.st_size
        if size < 10240:
            return
    except Exception:
        return

    stem = display_stem if display_stem else p.stem
    rel_p = str(p.relative_to(base_path)).replace("\\", "/")

    if stem not in file_map:
        file_map[stem] = {
            "base_name": stem,
            "kind": kind,
            "version": version_str,
            "mtime": mtime,
            "date_formatted": datetime.fromtimestamp(mtime).strftime("%b %d, %Y %I:%M %p"),
            "size_mb": round(size / (1024 * 1024), 1),
            "mp4_path": None,
            "mov_path": None,
            "primary_path": None,
            "can_play_in_browser": True
        }

    entry = file_map[stem]
    if p.suffix.lower() == ".mp4":
        entry["mp4_path"] = rel_p
    elif p.suffix.lower() == ".mov":
        entry["mov_path"] = rel_p

    if mtime > entry["mtime"]:
        entry["mtime"] = mtime
        entry["date_formatted"] = datetime.fromtimestamp(mtime).strftime("%b %d, %Y %I:%M %p")


def scan_shot_files(shot_code, active_clip_name=""):
    struct_mode = config.get("filesystem", {}).get("directory_structure", "sequence_nested")
    valid_exts = tuple(config.get("file_search", {}).get("video_extensions", [".mov", ".mp4"]))
    kind_keywords = config.get("file_search", {}).get("kind_keywords", {})

    shot_dirs = []
    seq_dir = None
    if struct_mode == "sequence_nested":
        parts = shot_code.split('_')
        seq = f"{parts[0]}_{parts[1]}" if len(parts) >= 2 else parts[0]
        seq_dir = base_path / seq
        shot_dir = seq_dir / shot_code
        if shot_dir.exists():
            shot_dirs.append(shot_dir)
    elif struct_mode == "flat":
        shot_dir = base_path / shot_code
        if shot_dir.exists():
            shot_dirs.append(shot_dir)
    else:
        for cand in base_path.rglob(shot_code):
            if cand.is_dir() and not is_ignored(str(cand), config):
                shot_dirs.append(cand)

    file_map = {}
    for sd in shot_dirs:
        for ext in valid_exts:
            for p in sd.rglob(f"*{ext}"):
                p_str = str(p)
                if is_ignored(p_str, config):
                    continue
                if kind_keywords:
                    fname_upper = p.name.upper()
                    if not any(k.upper() in fname_upper for k in kind_keywords):
                        continue
                make_file_entry(p, file_map)

    # Also ensure the active clip from the Resolve timeline is included even if it lives in a sibling shot folder
    if active_clip_name and seq_dir and seq_dir.exists():
        clean_active = re.sub(r'[\._\s]*\[\d+\-\d+\].*$', '', Path(active_clip_name).stem)
        matched = any(
            k.lower() == clean_active.lower() or clean_active.lower() in k.lower()
            for k in file_map.keys()
        )
        if not matched:
            found_files = []
            for ext in valid_exts:
                found_files.extend(seq_dir.rglob(f"{clean_active}{ext}"))
            if not found_files:
                suffix_after_shot = re.sub(r'^[A-Za-z0-9]+_\d{3}_\d{3}', '', clean_active)
                if suffix_after_shot and suffix_after_shot != clean_active:
                    for ext in valid_exts:
                        found_files.extend(seq_dir.rglob(f"*{suffix_after_shot}{ext}"))
            for p in found_files:
                if not is_ignored(str(p), config):
                    make_file_entry(p, file_map, display_stem=clean_active)

    version_list = []
    p_dir_name = config.get("proxies", {}).get("proxy_dir", ".web_proxies")
    for stem, entry in file_map.items():
        proxy_Stem = Path(entry["mov_path"]).stem if entry.get("mov_path") else stem
        proxy_rel = f"{p_dir_name}/{proxy_Stem}.mp4"
        entry["primary_path"] = entry["mp4_path"] if entry["mp4_path"] else proxy_rel
        version_list.append(entry)

    version_list.sort(key=lambda x: x["mtime"], reverse=True)
    return version_list

# 1. Check Resolve DB for latest timeline & track overrides (works even when Resolve is closed!)
db_info = read_latest_resolve_timeline_from_db()
base_v = config.get("resolve", {}).get("base_cut_track", 4)
if db_info and db_info["tracks_by_v"].get(base_v):
    data["timeline_name"] = db_info["timeline_name"]
    tracks_by_v = db_info["tracks_by_v"]
    v_base_list = tracks_by_v[base_v]
    higher_v_nums = sorted([v for v in tracks_by_v.keys() if v > base_v], reverse=True)

    new_shots = []
    fps = data.get("fps", 24)
    for idx, base_it in enumerate(v_base_list):
        shot_code = base_it["shot_code"]
        r_start = base_it["start"]
        r_end = base_it["end"]
        dur = base_it["duration"]
        src_in = base_it["source_in"]
        src_out = base_it["source_out"]

        # Find highest track override strictly by timeline frame overlap
        top_it = None
        mid_frame = (r_start + r_end) // 2
        for v_num in higher_v_nums:
            for cand in tracks_by_v[v_num]:
                if cand["start"] <= mid_frame < cand["end"] or (cand["start"] <= r_start + 2 and cand["end"] >= r_end - 2):
                    top_it = cand
                    break
            if top_it:
                break

        active_clip = top_it["name"] if top_it else base_it["name"]
        active_track = top_it["track"] if top_it else f"V{base_v}"
        if top_it and top_it["source_in"] > 0:
            src_in = top_it["source_in"]
            src_out = src_in + dur

        parts = shot_code.split('_')
        seq = f"{parts[0]}_{parts[1]}"
        new_shots.append({
            "index": idx + 1,
            "shot_code": shot_code,
            "sequence": seq,
            "record_start": r_start,
            "record_end": r_end,
            "duration": dur,
            "source_in": src_in,
            "source_out": src_out,
            "timecode_in": frames_to_tc(r_start, fps),
            "timecode_out": frames_to_tc(r_end, fps),
            "active_track": active_track,
            "active_clip": active_clip,
            "active_version_index": 0,
            "version_count": 0,
            "versions": []
        })
    data["shots"] = new_shots
    data["total_shots"] = len(new_shots)

print(f"Re-scanning {len(data['shots'])} shots for new versions in {base_path}...")

total_versions_found = 0
missing_proxies = 0
proxies_dir = review_dir / ".web_proxies"
unreadable_file = proxies_dir / ".unreadable_movs.json"
unreadable_set = set()
if unreadable_file.exists():
    try:
        unreadable_set = set(json.loads(unreadable_file.read_text(encoding="utf-8")))
    except Exception:
        pass

new_versions_discovered = []
newer_than_active = []
cut_changes = []
missing_proxy_list = []

for shot in data["shots"]:
    shot_code = shot["shot_code"]
    cur_clip = shot.get("active_clip", "")
    clean_active = re.sub(r'[\._\s]*\[\d+\-\d+\].*$', '', Path(cur_clip).stem)

    if shot_code in cached_versions_by_shot:
        versions = [dict(v) for v in cached_versions_by_shot[shot_code]]
        if clean_active and not any(v["base_name"].lower() == clean_active.lower() or clean_active.lower() in v["base_name"].lower() for v in versions):
            versions = scan_shot_files(shot_code, cur_clip)
    else:
        versions = scan_shot_files(shot_code, cur_clip)
    shot["versions"] = versions
    shot["version_count"] = len(versions)
    total_versions_found += len(versions)

    # Check if active clip changed in Resolve timeline
    prev_clip = old_active_clips.get(shot_code, "")
    if prev_clip and cur_clip and Path(prev_clip).stem.lower() != Path(cur_clip).stem.lower():
        cut_changes.append({
            "shot_code": shot_code,
            "old_clip": Path(prev_clip).stem,
            "new_clip": Path(cur_clip).stem,
            "track": shot.get("active_track", "V4")
        })

    # Match active_version_index to active_clip from Resolve timeline (prefer exact match first, then substring)
    active_idx = 0
    matched_idx = None
    for v_i, v in enumerate(versions):
        if v["base_name"].lower() == clean_active.lower():
            matched_idx = v_i
            break
    if matched_idx is None:
        for v_i, v in enumerate(versions):
            if clean_active.lower() in v["base_name"].lower() or v["base_name"].lower() in clean_active.lower():
                matched_idx = v_i
                break
    if matched_idx is not None:
        active_idx = matched_idx
    shot["active_version_index"] = active_idx

    # Check if a newer version exists on disk than the active clip in the Resolve cut
    if versions and active_idx > 0:
        latest_v = versions[0]
        active_v = versions[active_idx]
        newer_than_active.append({
            "shot_code": shot_code,
            "active_clip": active_v["base_name"],
            "active_date": active_v.get("date_formatted", ""),
            "latest_version": latest_v["base_name"],
            "latest_kind": latest_v.get("kind", ""),
            "latest_date": latest_v.get("date_formatted", "")
        })

    known_set = old_known_versions.get(shot_code, set())
    for v_i, v in enumerate(versions):
        needs_proxy = False
        if not v.get("mp4_path") and v.get("mov_path") and v["base_name"] not in unreadable_set:
            proxy_stem = Path(v["mov_path"]).stem
            if not (proxies_dir / f"{proxy_stem}.mp4").exists() and not (proxies_dir / f"{v['base_name']}.mp4").exists():
                missing_proxies += 1
                needs_proxy = True
                missing_proxy_list.append({
                    "shot_code": shot_code,
                    "base_name": v["base_name"],
                    "kind": v.get("kind", ""),
                    "date_formatted": v.get("date_formatted", ""),
                    "is_active": (v_i == active_idx)
                })
        if known_set and v["base_name"] not in known_set:
            new_versions_discovered.append({
                "shot_code": shot_code,
                "base_name": v["base_name"],
                "kind": v.get("kind", ""),
                "date_formatted": v.get("date_formatted", ""),
                "needs_proxy": needs_proxy
            })

data["generated_at"] = datetime.now().isoformat()
data["scan_report"] = {
    "scanned_at": datetime.now().strftime("%b %d, %Y %I:%M:%S %p"),
    "timeline_name": data.get("timeline_name", ""),
    "previous_timeline_name": prev_timeline_name,
    "total_shots": len(data["shots"]),
    "total_versions": total_versions_found,
    "missing_proxies_count": missing_proxies,
    "missing_proxies": missing_proxy_list[:100],
    "new_versions_count": len(new_versions_discovered),
    "new_versions": new_versions_discovered[:100],
    "cut_changes_count": len(cut_changes),
    "cut_changes": cut_changes,
    "newer_on_disk_count": len(newer_than_active),
    "newer_on_disk": newer_than_active
}

# Back up manifest files before writing
try:
    ts = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    b_dir = backup_root / "review"
    b_dir.mkdir(parents=True, exist_ok=True)
    for target_f in (manifest_file, js_file):
        if target_f.exists():
            b_path = b_dir / f"{target_f.stem}_{ts}{target_f.suffix}"
            shutil.copy2(target_f, b_path)
except Exception as e:
    print(f"Warning creating manifest backup: {e}")

# Write atomically via temp files so concurrent readers on other cloud instances never read a half-written manifest
tmp_json = review_dir / f".cut_manifest_{os.getpid()}.tmp"
with open(tmp_json, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
os.replace(tmp_json, manifest_file)

tmp_js = review_dir / f".manifest_{os.getpid()}.tmp"
with open(tmp_js, "w", encoding="utf-8") as f:
    f.write("window.SHOTSWAP_CUT = ")
    json.dump(data, f, indent=2)
    f.write(";\n")
os.replace(tmp_js, js_file)

print(f"SUCCESS: Timeline '{data.get('timeline_name')}' — {len(data['shots'])} shots, {total_versions_found} versions | {len(new_versions_discovered)} new files | {len(newer_than_active)} shots w/ newer versions on disk | {missing_proxies} needing proxies.")
