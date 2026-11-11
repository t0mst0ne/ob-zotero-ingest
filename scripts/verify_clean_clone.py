#!/usr/bin/env python3
"""Clone committed source, install via pip in an empty HOME, and run offline host tests."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--keep', action='store_true', help='Keep the temporary checkout and logs')
    args = parser.parse_args()
    sandbox = Path(tempfile.mkdtemp(prefix='ob-clean-clone-')).resolve()
    try:
        checkout = sandbox / 'Fresh clone with spaces'
        home = sandbox / 'Empty Home'
        vault = home / 'Empty Vault'
        vault.mkdir(parents=True)
        subprocess.run(['git', 'clone', '--no-hardlinks', str(ROOT), str(checkout)], check=True)
        # Explicitly select this Python version, without reusing site-packages or uv.
        environment = {'HOME': str(home), 'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8',
                       'PYTHON': sys._base_executable}
        steps = [
            [str(checkout / 'install.sh'), '--vault', str(vault),
             '--config-dir', str(home / 'settings'), '--hosts-dir', str(home / 'Test Chrome/NativeMessagingHosts')],
            [str(checkout / '.venv/bin/python'), '-I', '-m', 'unittest', 'discover',
             '-s', str(checkout / 'tests'), '-v'],
        ]
        for index, command in enumerate(steps, 1):
            print(f'Step {index}/{len(steps)}: {command[0]}', flush=True)
            result = subprocess.run(command, cwd=checkout, env=environment,
                                    capture_output=True, text=True, timeout=180)
            (sandbox / f'step-{index}.log').write_text(result.stdout + '\n' + result.stderr)
            if result.returncode:
                print(result.stdout + result.stderr)
                raise SystemExit(result.returncode)
            if index == 2:
                print(result.stdout + result.stderr)
        print(json.dumps({'status': 'passed', 'checkout': str(checkout),
                          'empty_home': True, 'new_virtualenv': True, 'installer': 'pip',
                          'browser_registration': 'isolated test directory only',
                          'browser_ui': 'not covered by this script',
                          'artifacts_kept': args.keep}, ensure_ascii=False, indent=2))
    finally:
        if args.keep:
            print(f'Test artifacts: {sandbox}')
        else:
            shutil.rmtree(sandbox)


if __name__ == '__main__':
    main()
