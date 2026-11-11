#!/usr/bin/env python3
"""
Installer script for OB-Zotero Chrome Native Messaging Host.
Registers com.ob.zotero.ingest.json into ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
"""

import json
import os
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent.parent.resolve()
HOST_SCRIPT = BASE_DIR / "scripts" / "native_host" / "native_host.py"
EXT_ID_FILE = BASE_DIR / "chrome-extension" / "ext_id.txt"

CHROME_HOSTS_DIR = Path.home() / "Library" / "Application Support" / "Google" / "Chrome" / "NativeMessagingHosts"
TARGET_MANIFEST = CHROME_HOSTS_DIR / "com.ob.zotero.ingest.json"


def main():
    if not HOST_SCRIPT.exists():
        print(f"Error: Host script not found at {HOST_SCRIPT}")
        sys.exit(1)

    # Ensure executable
    os.chmod(HOST_SCRIPT, 0o755)

    ext_id = "nigcccipceneamlocmomenlncpedpkne"
    if EXT_ID_FILE.exists():
        ext_id = EXT_ID_FILE.read_text().strip()

    if len(sys.argv) > 1:
        ext_id = sys.argv[1].strip()

    manifest_data = {
        "name": "com.ob.zotero.ingest",
        "description": "OB-Zotero Ingestion Native Messaging Host",
        "path": str(HOST_SCRIPT),
        "type": "stdio",
        "allowed_origins": [
            f"chrome-extension://{ext_id}/"
        ]
    }

    CHROME_HOSTS_DIR.mkdir(parents=True, exist_ok=True)
    TARGET_MANIFEST.write_text(json.dumps(manifest_data, indent=2), encoding="utf-8")

    print("=" * 65)
    print("✅ OB-Zotero Native Messaging Host 註冊完成！")
    print("=" * 65)
    print(f"Host 腳本位置:   {HOST_SCRIPT}")
    print(f"Manifest 位置:   {TARGET_MANIFEST}")
    print(f"授權 Extension:  chrome-extension://{ext_id}/")
    print("=" * 65)


if __name__ == "__main__":
    main()
