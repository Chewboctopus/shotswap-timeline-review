import os
import sys
import json
import re
import sqlite3
from pathlib import Path
from config_loader import (
    load_config,
    save_config,
    get_tool_dir,
    get_config_path,
    extract_shot_code,
    detect_kind,
    extract_version_string,
    is_ignored
)

def prompt_input(prompt_text, default_val=""):
    if default_val:
        display_prompt = f"{prompt_text} [{default_val}]: "
    else:
        display_prompt = f"{prompt_text}: "
    user_val = input(display_prompt).strip()
    return user_val if user_val else default_val

def browse_folder_dialog(title="Select Folder", initial_dir=None):
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        res = filedialog.askdirectory(title=title, initialdir=initial_dir or os.getcwd())
        root.destroy()
        if res:
            return os.path.normpath(res)
    except Exception:
        pass
    return None

def browse_file_dialog(title="Select File", filetypes=None, initial_dir=None):
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        res = filedialog.askopenfilename(
            title=title,
            filetypes=filetypes or [("All Files", "*.*")],
            initialdir=initial_dir or os.getcwd()
        )
        root.destroy()
        if res:
            return os.path.normpath(res)
    except Exception:
        pass
    return None

def find_system_resolve_databases():
    found = []
    appdata = Path(os.environ.get("APPDATA", ""))
    programdata = Path(os.environ.get("PROGRAMDATA", ""))
    
    cand_roots = [
        appdata / "Blackmagic Design" / "DaVinci Resolve" / "Support" / "Resolve Disk Database" / "Resolve Projects" / "Users" / "guest" / "Projects",
        programdata / "Blackmagic Design" / "DaVinci Resolve" / "Support" / "Resolve Disk Database" / "Resolve Projects" / "Users" / "guest" / "Projects",
        Path(r"F:\RESOLVE PROJECT\RESOLVE 19\Resolve Project Library\Resolve Projects\Users\guest\Projects"),
        Path(r"F:\RESOLVE PROJECT\Resolve Project Library\Resolve Projects\Users\guest\Projects"),
    ]
    for cr in cand_roots:
        if cr.exists():
            for p in cr.iterdir():
                db_f = p / "Project.db"
                if p.is_dir() and db_f.exists():
                    found.append((p.name, str(db_f)))
    return found

def test_resolve_db(db_path):
    if not os.path.exists(db_path):
        return False, "File does not exist"
    try:
        uri = f"file:{Path(db_path).as_posix()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=3.0)
        cur = conn.cursor()
        rows = cur.execute("SELECT Name FROM Sm2Timeline LIMIT 10").fetchall()
        conn.close()
        timelines = [r[0] for r in rows if r[0]]
        return True, timelines
    except Exception as e:
        return False, str(e)

def test_filesystem_scan(media_root, shot_regex, video_exts, kind_keywords, ignore_patterns, max_shots=5):
    p = Path(media_root)
    if not p.exists():
        return 0, 0, []
    
    shots_found = {}
    total_versions = 0
    pattern = re.compile(shot_regex)
    ext_set = set(e.lower() for e in video_exts)
    
    for root, dirs, files in os.walk(str(p)):
        norm_root = root.replace("\\", "/")
        if any(ign in norm_root for ign in ignore_patterns):
            continue
        
        for f in files:
            norm_f = f"{norm_root}/{f}"
            if any(ign in norm_f for ign in ignore_patterns):
                continue
            ext = os.path.splitext(f)[1].lower()
            if ext not in ext_set:
                continue
            
            m = pattern.search(f) or pattern.search(norm_root)
            if m:
                shot_code = m.group(1)
                if shot_code not in shots_found:
                    shots_found[shot_code] = []
                shots_found[shot_code].append(f)
                total_versions += 1
                
    sample = []
    for sc, v_list in list(shots_found.items())[:max_shots]:
        sample.append((sc, len(v_list), v_list[:2]))
    return len(shots_found), total_versions, sample

def main():
    print("=" * 72)
    print("   SHOTSWAP TIMELINE REVIEW — Production Setup & Configuration Wizard   ")
    print("=" * 72)
    print("This wizard configures ShotSwap for any film, VFX, or editorial production.\n")
    
    existing_cfg = load_config()
    
    # 1. Production Details
    print("--- [1/5] Production Identity ---")
    cur_name = existing_cfg.get("production", {}).get("name", "MY_PRODUCTION")
    cur_prefix = existing_cfg.get("production", {}).get("prefix", "SH")
    cur_title = existing_cfg.get("production", {}).get("display_title", "ShotSwap Timeline Review")
    
    prod_name = prompt_input("Production / Show Name", cur_name)
    prod_prefix = prompt_input("Shot Prefix / Code", cur_prefix)
    disp_title = prompt_input("Browser UI Title", f"{prod_name} — ShotSwap Timeline Review")
    
    # 2. Filesystem & Media Root
    print("\n--- [2/5] Filesystem & Media Source ---")
    print("Where are your shot media folders stored on disk or network storage?")
    cur_media_root = existing_cfg.get("filesystem", {}).get("media_root", str(get_tool_dir().parent))
    
    while True:
        print(f"Current default: {cur_media_root}")
        choice = prompt_input("Enter directory path, [B] to browse with folder picker, or press Enter", cur_media_root)
        if choice.upper() == "B":
            picked = browse_folder_dialog("Select Media Source Root Directory", cur_media_root)
            if picked:
                cur_media_root = picked
                break
        elif os.path.isdir(choice):
            cur_media_root = choice
            break
        else:
            print(f"Warning: Directory '{choice}' does not exist on disk.")
            confirm = prompt_input("Use this path anyway? (y/n)", "n")
            if confirm.lower() == "y":
                cur_media_root = choice
                break
                
    print(f"Selected Media Root: {cur_media_root}")
    
    dir_structure_opts = [
        ("1", "sequence_nested", "Nested by Sequence/Scene then Shot (e.g. SEQ_001/SEQ_001_010/)"),
        ("2", "flat", "Flat Shot Folders directly under media root (e.g. SH010/ or SH_001_010/)"),
        ("3", "recursive", "Recursive scan across all subdirectories")
    ]
    print("\nHow are shot folders organized inside the media root?")
    for num, code, desc in dir_structure_opts:
        print(f"  [{num}] {desc}")
    struct_choice = prompt_input("Select folder structure (1-3)", "1")
    structure_code = "sequence_nested" if struct_choice == "1" else ("flat" if struct_choice == "2" else "recursive")

    # 3. DaVinci Resolve Project DB & Timelines
    print("\n--- [3/5] DaVinci Resolve Project & Database ---")
    print("ShotSwap can read Resolve Project.db files directly, even when Resolve is closed.")
    detected_dbs = find_system_resolve_databases()
    default_db = existing_cfg.get("resolve", {}).get("default_project_db", "")
    
    if detected_dbs:
        print("Detected local Resolve Projects on this machine:")
        for idx, (proj_name, db_p) in enumerate(detected_dbs[:8], 1):
            print(f"  [{idx}] {proj_name} -> {db_p}")
        print("  [B] Browse for another Project.db file")
        print("  [S] Skip / set later")
        db_choice = prompt_input("Choose an existing project or [B]/[S]", "1" if default_db == "" else default_db)
        if db_choice.isdigit() and 1 <= int(db_choice) <= len(detected_dbs):
            default_db = detected_dbs[int(db_choice) - 1][1]
        elif db_choice.upper() == "B":
            picked_db = browse_file_dialog("Select DaVinci Resolve Project.db", [("Resolve Project DB", "*.db"), ("All Files", "*.*")])
            if picked_db:
                default_db = picked_db
    else:
        print("No default Resolve project databases automatically found in standard paths.")
        browse_q = prompt_input("Browse for a Project.db now? (y/n)", "n")
        if browse_q.lower() == "y":
            picked_db = browse_file_dialog("Select DaVinci Resolve Project.db", [("Resolve Project DB", "*.db"), ("All Files", "*.*")])
            if picked_db:
                default_db = picked_db
                
    if default_db and os.path.exists(default_db):
        ok, tl_list = test_resolve_db(default_db)
        if ok:
            print(f"✓ Resolve DB accessible! Timelines found: {len(tl_list)}")
            if tl_list:
                print(f"  Example timelines: {', '.join(tl_list[:3])}")
        else:
            print(f"Notice: Could not read timelines ({tl_list})")

    base_track_str = prompt_input("Base Cut Track number in Resolve timeline (e.g. 4 for V4, 1 for V1)", str(existing_cfg.get("resolve", {}).get("base_cut_track", 4)))
    try:
        base_track = int(base_track_str)
    except ValueError:
        base_track = 4

    # 4. File Search & Version Q&A
    print("\n--- [4/5] File Search & Version Filtering Q&A ---")
    print("Choose your shot code naming pattern:")
    print("  [1] PREFIX_XXX_YYY   (e.g., SH_001_010, PROD_010_020)")
    print("  [2] SEQ_SHOT         (e.g., SQ01_SH010, SC01_SH020)")
    print("  [3] SH_XXXX / SHOT   (e.g., SH0010, SHOT_040)")
    print("  [4] Custom Regular Expression")
    pattern_choice = prompt_input("Select shot pattern (1-4)", "1")
    
    if pattern_choice == "1":
        shot_regex = rf"({prod_prefix}_\d{{3}}_\d{{3}})"
    elif pattern_choice == "2":
        shot_regex = r"([A-Za-z0-9]+_[A-Za-z0-9]+)"
    elif pattern_choice == "3":
        shot_regex = r"(SH\d{3,4}|SHOT_\d+)"
    else:
        shot_regex = prompt_input("Enter custom regex for shot code", existing_cfg.get("file_search", {}).get("shot_code_regex", r"([A-Za-z0-9]+_\d{3}_\d{3})"))

    print(f"Shot code regex: {shot_regex}")

    cur_exts = ", ".join(existing_cfg.get("file_search", {}).get("video_extensions", [".mov", ".mp4"]))
    video_exts_input = prompt_input("Video file extensions to scan (comma-separated)", cur_exts)
    video_exts = [e.strip() if e.strip().startswith(".") else f".{e.strip()}" for e in video_exts_input.split(",") if e.strip()]

    cur_ver = existing_cfg.get("file_search", {}).get("version_regex", r"(_v\d+)")
    version_regex = prompt_input("Version tag pattern regex (e.g. _v001 or v01)", cur_ver)

    print("\nWhat kind tags / department keywords should identify version types?")
    print("Example: CMP, COMP, VID, UPRES, GEN, CG, PLATE")
    cur_kw = existing_cfg.get("file_search", {}).get("kind_keywords", {"CMP": "CMP", "COMP": "COMP", "VID": "VID"})
    kw_str = ", ".join(cur_kw.keys())
    kw_input = prompt_input("Kind keywords (comma-separated)", kw_str)
    kind_keywords = {}
    for k in kw_input.split(","):
        clean_k = k.strip().upper()
        if clean_k:
            kind_keywords[clean_k] = clean_k

    cur_ignore = ", ".join(existing_cfg.get("file_search", {}).get("ignore_patterns", ["_TO_DELETE", "_backup", ".web_proxies"]))
    ignore_input = prompt_input("Folder/file names to ignore (comma-separated)", cur_ignore)
    ignore_patterns = [i.strip() for i in ignore_input.split(",") if i.strip()]

    # 5. Validation Test & Save
    print("\n--- [5/5] Validation & Scan Test ---")
    print("Testing settings against filesystem...")
    num_shots, num_vers, sample = test_filesystem_scan(
        cur_media_root, shot_regex, video_exts, kind_keywords, ignore_patterns
    )
    print(f"✓ Found {num_shots} shots matching '{shot_regex}'")
    print(f"✓ Found {num_vers} media versions across the media root")
    if sample:
        print("\nSample shots discovered:")
        for sc, v_cnt, v_files in sample:
            print(f"  • {sc}: {v_cnt} versions (e.g. {', '.join(v_files)})")
    
    new_config = {
        "production": {
            "name": prod_name,
            "prefix": prod_prefix,
            "display_title": disp_title
        },
        "filesystem": {
            "media_root": cur_media_root,
            "directory_structure": structure_code,
            "subfolders": existing_cfg.get("filesystem", {}).get("subfolders", [])
        },
        "resolve": {
            "search_roots": existing_cfg.get("resolve", {}).get("search_roots", []),
            "default_project_db": default_db,
            "timeline_name_pattern": existing_cfg.get("resolve", {}).get("timeline_name_pattern", ".*"),
            "base_cut_track": base_track,
            "override_tracks": [base_track + 1, base_track + 2, base_track + 3]
        },
        "file_search": {
            "shot_code_regex": shot_regex,
            "video_extensions": video_exts,
            "still_extensions": existing_cfg.get("file_search", {}).get("still_extensions", [".jpg", ".png"]),
            "version_regex": version_regex,
            "kind_keywords": kind_keywords,
            "ignore_patterns": ignore_patterns
        },
        "proxies": existing_cfg.get("proxies", {
            "proxy_dir": ".web_proxies",
            "transcode_mode": "h264_nvenc",
            "resolution": "1920:1080",
            "crf_cq": 23
        }),
        "backup": {
            "backup_root": existing_cfg.get("backup", {}).get("backup_root", "")
        }
    }

    save_path = save_config(new_config)
    print(f"\nSUCCESS! Configuration saved to:\n  {save_path}")

    rescan_now = prompt_input("\nRun timeline/version rescan now to build manifest? (y/n)", "y")
    if rescan_now.lower() == "y":
        rescan_script = get_tool_dir() / "rescan_versions.py"
        if rescan_script.exists():
            import subprocess
            print("\nRunning rescan_versions.py...")
            subprocess.run([sys.executable, str(rescan_script)])

    print("\nSetup complete! You can start ShotSwap Timeline Review by running launch_player.bat")

if __name__ == "__main__":
    main()
