import os, sys, json, subprocess
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from config_loader import load_config

review_dir = Path(os.path.abspath(__file__)).parent
config = load_config()
base_path = Path(config.get("filesystem", {}).get("media_root") or review_dir.parent)
proxy_folder_name = config.get("proxies", {}).get("proxy_dir", ".web_proxies")
proxies_dir = review_dir / proxy_folder_name
proxies_dir.mkdir(parents=True, exist_ok=True)

manifest_file = review_dir / "cut_manifest.json"

if not manifest_file.exists():
    print(f"Error: {manifest_file} not found! Please run setup_production.py or rescan_versions.py first.")
    sys.exit(1)

with open(manifest_file, "r", encoding="utf-8") as f:
    data = json.load(f)

# Optional scene filter from command line argument
target_filter = sys.argv[1].upper() if len(sys.argv) > 1 else None

print("=================================================================")
print("  ShotSwap Web Proxy Generator — ALL VERSIONS (GPU NVENC Batch)  ")
print("=================================================================")
if target_filter:
    print(f"Filter: {target_filter}")

# Build priority queue:
# Pass 1: Active cut versions across all shots (so full cut plays immediately)
# Pass 2: All other versions across all shots (excluding _TO_DELETE trash folders)
pass1_tasks = []
pass2_tasks = []
already_done = 0

for shot in data["shots"]:
    shot_code = shot["shot_code"]
    if target_filter and target_filter not in shot_code:
        continue

    versions = shot.get("versions") or []
    act_idx = shot.get("active_version_index", 0)

    for v_idx, ver in enumerate(versions):
        # Skip native mp4 files that already exist outside .web_proxies
        mp4_rel = ver.get("mp4_path")
        if mp4_rel and not mp4_rel.startswith("review/.web_proxies/"):
            if (base_path / mp4_rel).exists():
                already_done += 1
                continue

        mov_rel = ver.get("mov_path")
        if not mov_rel or "_TO_DELETE" in mov_rel:
            continue

        source_mov = base_path / mov_rel
        if not source_mov.exists() or source_mov.stat().st_size < 10240:
            continue

        stem = ver["base_name"]
        proxy_filename = f"{stem}.mp4"
        proxy_path = proxies_dir / proxy_filename

        # Never overwrite an existing valid proxy
        if proxy_path.exists() and proxy_path.stat().st_size > 1000:
            already_done += 1
            continue

        task = (shot_code, v_idx == act_idx, source_mov, proxy_path)
        if v_idx == act_idx:
            pass1_tasks.append(task)
        else:
            pass2_tasks.append(task)

unreadable_file = proxies_dir / ".unreadable_movs.json"
unreadable_set = set()
if unreadable_file.exists():
    try:
        unreadable_set = set(json.loads(unreadable_file.read_text(encoding="utf-8")))
    except Exception:
        pass

all_tasks = [t for t in (pass1_tasks + pass2_tasks) if t[3].stem not in unreadable_set]
print(f"Already playable (native MP4 or existing proxy): {already_done}")
print(f"Queued for proxy generation: {len(all_tasks)} total ({len(pass1_tasks)} active cut + {len(pass2_tasks)} alternate versions)")

def transcode_one(idx, total, shot_code, is_active, source_mov, proxy_path):
    tag = "ACTIVE" if is_active else "ALT"
    cmd = [
        "ffmpeg", "-n",
        "-i", str(source_mov),
        "-c:v", "h264_nvenc",
        "-pix_fmt", "yuv420p",
        "-preset", "p4",
        "-cq", "23",
        "-vf", "scale=1920:1080",
        "-movflags", "+faststart",
        str(proxy_path)
    ]
    ret = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if ret.returncode != 0:
        cmd_cpu = [
            "ffmpeg", "-n",
            "-i", str(source_mov),
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-vf", "scale=1920:1080",
            "-movflags", "+faststart",
            str(proxy_path)
        ]
        ret_cpu = subprocess.run(cmd_cpu, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        if ret_cpu.returncode != 0:
            unreadable_set.add(proxy_path.stem)
            try:
                unreadable_file.write_text(json.dumps(sorted(unreadable_set)), encoding="utf-8")
            except Exception:
                pass
            return f"[{idx}/{total}] [{shot_code} {tag}] SKIPPED (corrupt/incomplete .mov): {source_mov.name}"
    sz = round(proxy_path.stat().st_size / (1024 * 1024), 1) if proxy_path.exists() else 0
    return f"[{idx}/{total}] [{shot_code} {tag}] Done: {proxy_path.name} ({sz} MB)"

completed = 0
total = len(all_tasks)
# Use 3 concurrent NVENC workers for maximum GPU throughput
with ThreadPoolExecutor(max_workers=3) as pool:
    futures = [
        pool.submit(transcode_one, i + 1, total, t[0], t[1], t[2], t[3])
        for i, t in enumerate(all_tasks)
    ]
    for fut in as_completed(futures):
        completed += 1
        print(fut.result(), flush=True)

print(f"\nSUCCESS: Generated {completed} proxies in {proxies_dir}")
