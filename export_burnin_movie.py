import os, sys, json, subprocess, tempfile, shutil
from pathlib import Path
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

review_dir = Path(os.path.abspath(__file__)).parent
base_path = review_dir.parent
exports_dir = review_dir / "exports"
exports_dir.mkdir(parents=True, exist_ok=True)

def frames_to_tc(frame_num, fps=24):
    total_frames = max(0, int(frame_num))
    h = total_frames // (fps * 3600)
    m = (total_frames % (fps * 3600)) // (fps * 60)
    s = (total_frames % (fps * 60)) // fps
    f = total_frames % fps
    return f"{h:02d}\\:{m:02d}\\:{s:02d}\\:{f:02d}"

def esc_drawtext(txt):
    if not txt:
        return ""
    return str(txt).replace("\\", "\\\\").replace(":", "\\:").replace("'", "").replace("%", "\\%")

def render_shot_segment(idx, total, shot_spec, temp_dir, fps, timeline_name):
    seg_out = temp_dir / f"seg_{idx:04d}.ts"
    src_path = Path(shot_spec["media_path"])
    src_in_frames = int(shot_spec.get("source_in", 0))
    dur_frames = int(shot_spec.get("duration", 24))
    rec_start = int(shot_spec.get("record_start", 86400))
    shot_code = shot_spec.get("shot_code", f"SHOT_{idx}")
    ver_name = shot_spec.get("version_name", "")
    slip_delta = int(shot_spec.get("slip_delta", 0))

    ss_sec = max(0.0, src_in_frames / float(fps))
    dur_sec = max(0.04, dur_frames / float(fps))

    rec_tc_start = frames_to_tc(rec_start, fps)
    slip_str = f"  [SLIP {slip_delta:+d}f | In {src_in_frames}f]" if slip_delta != 0 else f"  [In {src_in_frames}f]"

    top_left_1 = esc_drawtext(f"{shot_code}  ({idx}/{total})")
    top_left_2 = esc_drawtext(f"{ver_name}{slip_str}")
    bottom_tc = esc_drawtext(timeline_name)

    # Use Windows Arial / Consolas font for crisp burn-in
    font_path = "C\\:/Windows/Fonts/consolab.ttf"
    if not Path("C:/Windows/Fonts/consolab.ttf").exists():
        font_path = "C\\:/Windows/Fonts/arial.ttf"

    # Build FFmpeg drawtext filter chain:
    # 1. Top-Left Box: Shot Code + Selected Version Name + Source In / Slip
    # 2. Top-Right Box: Running Record Timecode + Record Frame + Shot Frame (1..N)
    # 3. Bottom-Center: Timeline Name
    vf_parts = [
        "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=24",
        f"drawtext=fontfile='{font_path}':text='{top_left_1}':x=28:y=24:fontsize=28:fontcolor=0x38bdf8:box=1:boxcolor=black@0.65:boxborderw=8",
        f"drawtext=fontfile='{font_path}':text='{top_left_2}':x=28:y=64:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=6",
        f"drawtext=fontfile='{font_path}':timecode='{rec_tc_start}':rate={fps}:x=w-tw-28:y=24:fontsize=28:fontcolor=0xfbbf24:box=1:boxcolor=black@0.65:boxborderw=8",
        f"drawtext=fontfile='{font_path}':text='Rec Frame\\: %{{eif\\:{rec_start}+n\\:d}}  |  Shot Frame\\: %{{eif\\:n+1\\:d}}/{dur_frames}':x=w-tw-28:y=64:fontsize=18:fontcolor=0xcbd5e1:box=1:boxcolor=black@0.65:boxborderw=6",
        f"drawtext=fontfile='{font_path}':text='{bottom_tc}':x=(w-tw)/2:y=h-42:fontsize=20:fontcolor=0xf87171:box=1:boxcolor=black@0.65:boxborderw=6"
    ]
    vf_str = ",".join(vf_parts)

    if src_path.exists():
        cmd = [
            "ffmpeg", "-y",
            "-ss", f"{ss_sec:.4f}",
            "-i", str(src_path),
            "-t", f"{dur_sec:.4f}",
            "-vf", vf_str,
            "-c:v", "h264_nvenc",
            "-preset", "p3",
            "-cq", "21",
            "-g", "24",
            "-pix_fmt", "yuv420p",
            "-an",
            "-f", "mpegts",
            str(seg_out)
        ]
    else:
        # Black slug fallback if media missing
        cmd = [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", f"color=c=black:s=1920x1080:r={fps}:d={dur_sec:.4f}",
            "-vf", vf_str,
            "-c:v", "h264_nvenc",
            "-preset", "p3",
            "-cq", "21",
            "-g", "24",
            "-pix_fmt", "yuv420p",
            "-an",
            "-f", "mpegts",
            str(seg_out)
        ]

    ret = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if ret.returncode != 0:
        # Fallback to libx264 if NVENC session limit reached
        cmd_cpu = [c if c != "h264_nvenc" else "libx264" for c in cmd]
        cmd_cpu = [c if c != "p3" else "ultrafast" for c in cmd_cpu]
        cmd_cpu = [c if c != "-cq" else "-crf" for c in cmd_cpu]
        subprocess.run(cmd_cpu, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)

    return f"[{idx}/{total}] Rendered burn-in segment: {shot_code} ({ver_name})"

def main():
    if len(sys.argv) < 2:
        print("Usage: py export_burnin_movie.py <spec_json_path>")
        sys.exit(1)

    spec_path = Path(sys.argv[1])
    spec = json.loads(spec_path.read_text(encoding="utf-8"))

    fps = int(spec.get("fps", 24))
    timeline_name = spec.get("timeline_name", "SHOTSWAP_CUT")
    output_path = Path(spec.get("output_path", str(exports_dir / f"{timeline_name}_BURNIN.mp4")))
    base_movie_path = spec.get("base_movie_path", "")
    base_start_frame = int(spec.get("base_start_frame", 86208))
    shots = spec.get("shots", [])

    if not shots:
        print("ERROR: No shots provided in export spec.")
        sys.exit(1)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix="shotswap_burnin_"))

    try:
        total = len(shots)
        print(f"Starting GPU Burn-In Render: {total} shots -> {output_path.name}", flush=True)

        # Render segments with 3 concurrent GPU workers
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = [
                pool.submit(render_shot_segment, i + 1, total, s, temp_dir, fps, timeline_name)
                for i, s in enumerate(shots)
            ]
            done_cnt = 0
            for fut in as_completed(futures):
                done_cnt += 1
                msg = fut.result()
                print(f"[{done_cnt}/{total}] {msg.split('] ', 1)[-1]}", flush=True)

        # Build concat list
        concat_file = temp_dir / "concat.txt"
        with open(concat_file, "w", encoding="utf-8") as cf:
            for i in range(1, total + 1):
                seg_p = temp_dir / f"seg_{i:04d}.ts"
                if seg_p.exists():
                    cf.write(f"file '{seg_p.as_posix()}'\n")

        print(f"[{total}/{total}] Stitching {total} segments and muxing audio...", flush=True)

        first_rec_frame = int(shots[0].get("record_start", 86400))
        audio_offset_sec = max(0.0, (first_rec_frame - base_start_frame) / float(fps))

        if base_movie_path and Path(base_movie_path).exists():
            mux_cmd = [
                "ffmpeg", "-y",
                "-f", "concat", "-safe", "0", "-i", str(concat_file),
                "-ss", f"{audio_offset_sec:.4f}", "-i", str(base_movie_path),
                "-map", "0:v:0", "-map", "1:a:0?",
                "-c:v", "copy",
                "-c:a", "aac", "-b:a", "192k",
                "-shortest",
                "-movflags", "+faststart",
                str(output_path)
            ]
        else:
            mux_cmd = [
                "ffmpeg", "-y",
                "-f", "concat", "-safe", "0", "-i", str(concat_file),
                "-c:v", "copy",
                "-movflags", "+faststart",
                str(output_path)
            ]

        ret = subprocess.run(mux_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        if ret.returncode != 0:
            print(f"ERROR muxing final movie: {ret.stderr[-200:]}", flush=True)
            sys.exit(1)

        sz_mb = round(output_path.stat().st_size / (1024 * 1024), 1)
        print(f"SUCCESS: Burn-In Proxy Movie exported to {output_path} ({sz_mb} MB)", flush=True)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

if __name__ == "__main__":
    main()
