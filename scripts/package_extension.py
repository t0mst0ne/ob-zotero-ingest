#!/usr/bin/env python3
"""Build only browser runtime files; never include host settings, tests or credentials."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'chrome-extension'
FILES = ['manifest.json', 'background.js', 'content_script.js', 'sidepanel.js',
         'sidepanel.html', 'sidepanel.css', 'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--keep-key', action='store_true',
                        help='Keep development public key in packaged manifest.json')
    args = parser.parse_args()

    manifest = json.loads((SOURCE / 'manifest.json').read_text(encoding='utf-8'))
    assert manifest['manifest_version'] == 3
    assert len(manifest['description']) <= 132
    assert 'cookies' not in manifest.get('permissions', [])
    assert '<all_urls>' not in manifest.get('host_permissions', [])

    store_manifest = dict(manifest)
    if not args.keep_key:
        store_manifest.pop('key', None)

    output = ROOT / 'dist' / f'ob-zotero-{manifest["version"]}.zip'
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            if name == 'manifest.json':
                archive.writestr(name, json.dumps(store_manifest, ensure_ascii=False, indent=2) + '\n')
            else:
                archive.write(SOURCE / name, name)
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == set(FILES)
        packaged_manifest = json.loads(archive.read('manifest.json').decode('utf-8'))
        if not args.keep_key:
            assert 'key' not in packaged_manifest
    print(json.dumps({'zip': str(output), 'bytes': output.stat().st_size,
                      'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
                      'store_ready_manifest': 'key' not in packaged_manifest}, indent=2))


if __name__ == '__main__':
    main()
