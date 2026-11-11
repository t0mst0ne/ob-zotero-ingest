"""Standalone runtime paths. Never discover settings in the original OB vault."""
import json
import os
import sys
from pathlib import Path


def default_config_dir():
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "OB-Zotero"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "ob-zotero"


CONFIG_FILE = Path(os.environ.get("OB_INGEST_CONFIG", default_config_dir() / "config.json")).expanduser().resolve()
RUNTIME_DIR = CONFIG_FILE.parent
CACHE_DIR = RUNTIME_DIR / "cache"


def load_settings():
    if not CONFIG_FILE.is_file():
        return {}
    return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))


def get_vault_root():
    configured = load_settings().get("vault_path")
    if not configured:
        raise RuntimeError("Vault is not configured. Run ./install.sh --vault /absolute/path/to/vault")
    path = Path(configured).expanduser().resolve()
    if not path.is_dir():
        raise RuntimeError(f"Configured Vault does not exist: {path}")
    return path


def get_vault_name():
    return load_settings().get("vault_name") or get_vault_root().name


def get_zotero_dir():
    configured = load_settings().get("zotero_dir")
    return Path(configured).expanduser().resolve() if configured else None
