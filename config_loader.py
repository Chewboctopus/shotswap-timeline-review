import os
import sys
import json
import re
from pathlib import Path

DEFAULT_CONFIG_FILENAME = "shotswap_config.json"
TEMPLATE_CONFIG_FILENAME = "shotswap_config.template.json"

DEFAULT_CONFIG = {
    "production": {
        "name": "MY_PRODUCTION",
        "prefix": "SH",
        "display_title": "ShotSwap Timeline Review"
    },
    "filesystem": {
        "media_root": "",
        "directory_structure": "sequence_nested",  # "sequence_nested", "flat", "recursive"
        "subfolders": []  # optional specific subfolders, or empty for all
    },
    "resolve": {
        "search_roots": [
            r"%APPDATA%\Blackmagic Design\DaVinci Resolve\Support\Resolve Disk Database\Resolve Projects\Users\guest\Projects",
            r"%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Resolve Disk Database\Resolve Projects\Users\guest\Projects",
            r"F:\RESOLVE PROJECT\RESOLVE 19\Resolve Project Library\Resolve Projects\Users\guest\Projects",
            r"F:\RESOLVE PROJECT\Resolve Project Library\Resolve Projects\Users\guest\Projects"
        ],
        "default_project_db": "",
        "timeline_name_pattern": ".*",
        "base_cut_track": 4,
        "override_tracks": [5, 6, 7]
    },
    "file_search": {
        "shot_code_regex": r"([A-Za-z0-9]+_\d{3}_\d{3})",
        "video_extensions": [".mov", ".mp4"],
        "still_extensions": [".jpg", ".jpeg", ".png"],
        "version_regex": r"(_v\d+)",
        "kind_keywords": {
            "CMP": "CMP",
            "COMP": "COMP",
            "VID": "VID",
            "UPRES": "UPRES",
            "GEN": "GEN"
        },
        "ignore_patterns": ["_TO_DELETE", "_backup", ".web_proxies", ".tmp"]
    },
    "proxies": {
        "proxy_dir": ".web_proxies",
        "transcode_mode": "h264_nvenc",
        "resolution": "1920:1080",
        "crf_cq": 23
    },
    "backup": {
        "backup_root": ""
    }
}


def get_tool_dir():
    return Path(os.path.abspath(__file__)).parent


def get_config_path(custom_path=None):
    if custom_path:
        p = Path(custom_path)
        if p.is_dir():
            return p / DEFAULT_CONFIG_FILENAME
        return p
    return get_tool_dir() / DEFAULT_CONFIG_FILENAME


def deep_merge(source, destination):
    for key, value in source.items():
        if isinstance(value, dict) and key in destination and isinstance(destination[key], dict):
            deep_merge(value, destination[key])
        else:
            destination[key] = value
    return destination


def load_config(custom_path=None):
    config = json.loads(json.dumps(DEFAULT_CONFIG))
    tool_dir = get_tool_dir()

    # Dynamic defaults
    config["filesystem"]["media_root"] = str(tool_dir.parent)
    config["backup"]["backup_root"] = str(tool_dir / "backups")

    cfg_file = get_config_path(custom_path)
    if not cfg_file.exists():
        tpl_file = tool_dir / TEMPLATE_CONFIG_FILENAME
        if tpl_file.exists():
            cfg_file = tpl_file

    if cfg_file.exists():
        try:
            with open(cfg_file, "r", encoding="utf-8") as f:
                user_cfg = json.load(f)
            deep_merge(user_cfg, config)
        except Exception as e:
            print(f"[config_loader] Warning reading {cfg_file}: {e}")

    return config


def save_config(config_dict, custom_path=None):
    cfg_file = get_config_path(custom_path)
    cfg_file.parent.mkdir(parents=True, exist_ok=True)
    with open(cfg_file, "w", encoding="utf-8") as f:
        json.dump(config_dict, f, indent=2)
    return cfg_file


def extract_shot_code(name_or_path, config=None):
    if not name_or_path:
        return None
    if config is None:
        config = load_config()
    pattern = config.get("file_search", {}).get("shot_code_regex", r"([A-Za-z0-9]+_\d{3}_\d{3})")
    try:
        m = re.search(pattern, str(name_or_path))
        return m.group(1) if m else None
    except Exception:
        return None


def extract_version_string(filename, config=None):
    if not filename:
        return ""
    if config is None:
        config = load_config()
    pattern = config.get("file_search", {}).get("version_regex", r"(_v\d+)")
    try:
        m = re.search(pattern, str(filename), re.IGNORECASE)
        return m.group(1).lower() if m else ""
    except Exception:
        return ""


def detect_kind(filename, config=None):
    if not filename:
        return "VID"
    if config is None:
        config = load_config()
    fname_upper = str(filename).upper()
    kind_keywords = config.get("file_search", {}).get("kind_keywords", {})
    for kw, kind_label in kind_keywords.items():
        if kw.upper() in fname_upper:
            return kind_label
    return "VID"


def is_ignored(path_str, config=None):
    if config is None:
        config = load_config()
    ignore_list = config.get("file_search", {}).get("ignore_patterns", ["_TO_DELETE", "_backup", ".web_proxies"])
    norm_p = str(path_str).replace("\\", "/")
    for ign in ignore_list:
        if ign in norm_p:
            return True
    return False


def get_resolve_search_roots(config=None):
    if config is None:
        config = load_config()
    configured_roots = config.get("resolve", {}).get("search_roots", [])
    valid_paths = []
    for r in configured_roots:
        expanded = os.path.expandvars(r)
        p = Path(expanded)
        if p.exists():
            valid_paths.append(p)
    return valid_paths
