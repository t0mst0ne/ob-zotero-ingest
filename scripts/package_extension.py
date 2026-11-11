#!/usr/bin/env python3
"""Build only browser runtime files; never include host settings, tests or credentials."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'chrome-extension'
FILES = ['manifest.json', 'background.js', 'content_script.js', 'sidepanel.js',
         'sidepanel.html', 'sidepanel.css', 'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png']


def main():
    manifest = json.loads((SOURCE / 'manifest.json').read_text())
    assert manifest['manifest_version'] == 3
    assert len(manifest['description']) <= 132
    output = ROOT / 'dist' / f'ob-zotero-{manifest["version"]}.zip'
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            archive.write(SOURCE / name, name)
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == set(FILES)
    print(json.dumps({'zip': str(output), 'bytes': output.stat().st_size,
                      'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}, indent=2))


if __name__ == '__main__':
    main()
