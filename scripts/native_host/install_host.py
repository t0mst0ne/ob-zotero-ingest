#!/usr/bin/env python3
"""Register a standalone native host without depending on shell PATH or Anaconda."""
import argparse
import hashlib
import json
import os
import re
import shlex
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOST_NAME = 'com.ob.zotero.ingest'


def default_config_dir():
    if sys.platform == 'darwin':
        return Path.home() / 'Library/Application Support/OB-Zotero'
    return Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'ob-zotero'


def default_hosts_dir():
    if sys.platform == 'darwin':
        return Path.home() / 'Library/Application Support/Google/Chrome/NativeMessagingHosts'
    if sys.platform.startswith('linux'):
        return Path.home() / '.config/google-chrome/NativeMessagingHosts'
    raise ValueError('Windows registration is not implemented; use macOS or Linux.')


def default_extension_id():
    import base64
    manifest = json.loads((ROOT / 'chrome-extension/manifest.json').read_text())
    digest = hashlib.sha256(base64.b64decode(manifest['key'])).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(char, 16)) for char in digest)


def install(args):
    vault = Path(args.vault).expanduser().resolve()
    if not vault.is_dir():
        raise ValueError('Vault directory does not exist; create/select an empty directory first.')
    extension_id = args.extension_id or default_extension_id()
    if not re.fullmatch('[a-p]{32}', extension_id):
        raise ValueError('Extension ID must contain exactly 32 characters in a-p.')
    config_dir = Path(args.config_dir).expanduser().resolve() if args.config_dir else default_config_dir().resolve()
    hosts_dir = Path(args.hosts_dir).expanduser().resolve() if args.hosts_dir else default_hosts_dir()
    python = Path(args.python or sys.executable).expanduser().absolute()
    if not python.is_file() or not os.access(python, os.X_OK):
        raise ValueError(f'Python is not executable: {python}')
    config_file = config_dir / 'config.json'
    launcher = config_dir / 'native-host.sh'
    manifest_file = hosts_dir / f'{HOST_NAME}.json'
    manifest = {
        'name': HOST_NAME,
        'description': 'OB-Zotero standalone ingestion host',
        'path': str(launcher),
        'type': 'stdio',
        'allowed_origins': [f'chrome-extension://{extension_id}/'],
    }
    if manifest_file.exists() and not args.replace_host:
        previous = json.loads(manifest_file.read_text())
        if previous.get('path') != str(launcher):
            raise ValueError('A different OB native host is already registered. Use --hosts-dir for an isolated test, or explicitly use --replace-host to switch.')
    settings = {
        'vault_path': str(vault),
        'vault_name': args.vault_name or vault.name,
        'zotero_dir': str(Path(args.zotero_dir).expanduser().resolve()) if args.zotero_dir else None,
    }
    if settings['zotero_dir'] and not Path(settings['zotero_dir']).is_dir():
        raise ValueError('Configured Zotero directory does not exist.')
    config_dir.mkdir(parents=True, exist_ok=True)
    hosts_dir.mkdir(parents=True, exist_ok=True)
    config_file.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + '\n')
    config_file.chmod(0o600)
    launcher.write_text(
        '#!/bin/sh\n'
        f'export OB_INGEST_CONFIG={shlex.quote(str(config_file))}\n'
        f'exec {shlex.quote(str(python))} -I {shlex.quote(str(ROOT / "scripts/native_host/native_host.py"))} "$@"\n'
    )
    launcher.chmod(0o700)
    manifest_file.write_text(json.dumps(manifest, indent=2) + '\n')
    return {
        'config': str(config_file), 'launcher': str(launcher),
        'manifest': str(manifest_file), 'extension_id': extension_id,
        'vault': str(vault), 'python': str(python),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vault', required=True, help='Existing Obsidian Vault directory')
    parser.add_argument('--vault-name', help='Vault name registered in Obsidian; defaults to directory name')
    parser.add_argument('--zotero-dir', help='Optional Zotero data directory; omitted means no local database access')
    parser.add_argument('--extension-id', help='Chrome Web Store/unpacked extension ID; defaults to manifest key-derived ID')
    parser.add_argument('--config-dir', help='Override runtime settings/cache directory')
    parser.add_argument('--hosts-dir', help='Override Chrome native-host registration directory for isolated testing')
    parser.add_argument('--python', help='Absolute Python interpreter used by Chrome')
    parser.add_argument('--replace-host', action='store_true', help='Explicitly replace a different existing host registration')
    try:
        result = install(parser.parse_args())
    except (ValueError, OSError) as error:
        parser.exit(1, f'Installation failed: {error}\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
