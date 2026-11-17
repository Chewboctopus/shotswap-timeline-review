import os, sys, json
from pathlib import Path
from datetime import datetime
from config_loader import load_config

config = load_config()
show_name = config.get("production", {}).get("name", "VFX")

def get_resolve():
    # Standard DaVinci Resolve scripting paths on Windows
    script_api = os.environ.get(
        "RESOLVE_SCRIPT_API",
        r"C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting"
    )
    modules_path = os.path.join(script_api, "Modules")
    if modules_path not in sys.path and os.path.exists(modules_path):
        sys.path.append(modules_path)
    import DaVinciResolveScript as dvr_script
    return dvr_script.scriptapp("Resolve")


def ensure_bin_path(mp, root_folder, rel_parts):
    """Walks or creates Master/{show_name}/... matching filesystem hierarchy."""
    curr = root_folder
    for part in rel_parts:
        if not part:
            continue
        found = None
        for sub in (curr.GetSubFolderList() or []):
            if sub.GetName().lower() == part.lower():
                found = sub
                break
        if not found:
            found = mp.AddSubFolder(curr, part)
        if found:
            curr = found
    return curr


def find_or_import_clip(mp, root_folder, file_path_str, base_path_str):
    """Finds an existing MediaPoolItem by file path or clip name, or imports it into its mirrored sub-bin."""
    norm_target = os.path.normcase(os.path.normpath(file_path_str))
    target_name = os.path.basename(file_path_str)
    target_stem = os.path.splitext(target_name)[0].lower()

    # 1. Search existing Media Pool first
    exact_match = None
    name_match = None

    def walk(folder):
        nonlocal exact_match, name_match
        for clip in (folder.GetClipList() or []):
            if exact_match:
                return
            try:
                c_path = clip.GetClipProperty("File Path") or ""
                if c_path and os.path.normcase(os.path.normpath(c_path)) == norm_target:
                    exact_match = clip
                    return
                c_name = clip.GetName() or ""
                if os.path.splitext(c_name)[0].lower() == target_stem:
                    name_match = clip
            except Exception:
                pass
        for sub in (folder.GetSubFolderList() or []):
            if exact_match:
                return
            walk(sub)

    walk(root_folder)
    if exact_match:
        return exact_match

    # 2. Import into mirrored bin structure
    if os.path.exists(file_path_str):
        try:
            rel_dir = os.path.relpath(os.path.dirname(file_path_str), base_path_str)
            rel_parts = [show_name] + [p for p in Path(rel_dir).parts if p not in (".", "..")]
        except Exception:
            rel_parts = [show_name]

        dest_folder = ensure_bin_path(mp, root_folder, rel_parts)
        mp.SetCurrentFolder(dest_folder)
        imported = mp.ImportMedia([file_path_str])
        if imported and len(imported) > 0:
            return imported[0]

    return name_match


def main():
    if len(sys.argv) < 2:
        print("Error: Missing spec JSON path.")
        sys.exit(1)

    spec_path = sys.argv[1]
    with open(spec_path, "r", encoding="utf-8") as f:
        spec = json.load(f)

    try:
        os.remove(spec_path)
    except Exception:
        pass

    mode = spec.get("mode", "update_timeline")  # "update_timeline" | "export_drt"
    output_path = spec.get("output_path", "")
    base_path = spec.get("base_path", ".")
    updates = spec.get("updates", [])

    if not updates:
        print("Error: No updated shots to process.")
        sys.exit(1)

    print(f"Connecting to DaVinci Resolve ({len(updates)} shot updates)...", flush=True)
    resolve = get_resolve()
    if not resolve:
        print("Error: Could not connect to DaVinci Resolve. Make sure DaVinci Resolve is open on this workstation.")
        sys.exit(1)

    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    if not project:
        print("Error: No project is currently open in DaVinci Resolve.")
        sys.exit(1)

    mp = project.GetMediaPool()
    root_folder = mp.GetRootFolder()
    orig_tl = project.GetCurrentTimeline()
    if not orig_tl:
        print("Error: No timeline is currently active in DaVinci Resolve.")
        sys.exit(1)

    orig_tl_name = orig_tl.GetName()
    orig_start_tc = orig_tl.GetStartTimecode() or "01:00:00:00"

    # Resolve Media Pool items for each update
    resolved_items = []
    total = len(updates)
    for i, u in enumerate(updates):
        shot_code = u.get("shot_code", "")
        ver_name = u.get("version_name", "")
        src_path = u.get("source_path", "")
        print(f"[{i + 1}/{total}] Locating/Importing {shot_code}: {ver_name}...", flush=True)
        mp_item = find_or_import_clip(mp, root_folder, src_path, base_path)
        if not mp_item:
            print(f"  WARNING: Could not find or import media for {shot_code} ({src_path})", flush=True)
            continue
        resolved_items.append((u, mp_item))

    if not resolved_items:
        print("Error: None of the updated clips could be found or imported into the Media Pool.")
        sys.exit(1)

    if mode == "update_timeline":
        # Find highest occupied video track on the open timeline, then use the track above it
        v_count = orig_tl.GetTrackCount("video")
        highest_occupied = 4
        for t_idx in range(1, v_count + 1):
            items = orig_tl.GetItemListInTrack("video", t_idx) or []
            if len(items) > 0:
                highest_occupied = t_idx

        target_track = highest_occupied + 1
        while orig_tl.GetTrackCount("video") < target_track:
            orig_tl.AddTrack("video")

        print(f"Placing {len(resolved_items)} updated clips onto Track V{target_track} of '{orig_tl_name}'...", flush=True)
        placed = 0
        for i, (u, mp_item) in enumerate(resolved_items):
            rec_start = int(u["record_start"])
            dur = int(u["duration"])
            src_in = int(u.get("source_in", 10))
            # Resolve's AppendToTimeline endFrame is exclusive (startFrame + duration)
            src_out = src_in + dur
            res = mp.AppendToTimeline([{
                "mediaPoolItem": mp_item,
                "startFrame": src_in,
                "endFrame": src_out,
                "recordFrame": rec_start,
                "trackIndex": target_track,
                "mediaType": 1
            }])
            if res:
                placed += 1

        print(f"SUCCESS: Placed {placed}/{len(resolved_items)} updated shots on Track V{target_track} in '{orig_tl_name}'.", flush=True)

    elif mode == "export_drt":
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        temp_tl_name = Path(output_path).stem if output_path else f"SHOTSWAP_WHATS_NEW_{ts}"
        # Ensure unique timeline name in project
        mp.SetCurrentFolder(root_folder)
        temp_tl = mp.CreateEmptyTimeline(temp_tl_name)
        if not temp_tl:
            temp_tl_name = f"{temp_tl_name}_{ts}"
            temp_tl = mp.CreateEmptyTimeline(temp_tl_name)
        if not temp_tl:
            print("Error: Could not create temporary timeline in Resolve for DRT export.")
            sys.exit(1)

        temp_tl.SetStartTimecode(orig_start_tc)
        print(f"Building Diff Timeline '{temp_tl_name}' ({len(resolved_items)} shots)...", flush=True)
        placed = 0
        for i, (u, mp_item) in enumerate(resolved_items):
            rec_start = int(u["record_start"])
            dur = int(u["duration"])
            src_in = int(u.get("source_in", 10))
            src_out = src_in + dur
            res = mp.AppendToTimeline([{
                "mediaPoolItem": mp_item,
                "startFrame": src_in,
                "endFrame": src_out,
                "recordFrame": rec_start,
                "trackIndex": 1,
                "mediaType": 1
            }])
            if res:
                placed += 1

        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        ok = temp_tl.Export(output_path, resolve.EXPORT_DRT, resolve.EXPORT_NONE)

        # Restore original timeline and remove temp timeline from Media Pool
        project.SetCurrentTimeline(orig_tl)
        try:
            tl_mp_item = temp_tl.GetMediaPoolItem()
            if tl_mp_item:
                mp.DeleteClips([tl_mp_item])
        except Exception:
            pass

        if ok and os.path.exists(output_path):
            sz_kb = round(os.path.getsize(output_path) / 1024, 1)
            print(f"SUCCESS: Exported 'What's New' DRT ({placed} shots, {sz_kb} KB) to {output_path}", flush=True)
        else:
            print(f"Error: Resolve failed to export DRT to {output_path}", flush=True)
            sys.exit(1)


if __name__ == "__main__":
    main()
