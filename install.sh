#!/bin/sh
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$#" -eq 0 ] || [ "$1" = "--help" ]; then
    exec "${PYTHON:-python3}" "$PROJECT_DIR/scripts/native_host/install_host.py" --help
fi
if [ ! -x "$PROJECT_DIR/.venv/bin/python" ]; then
    if command -v uv >/dev/null 2>&1 && [ -z "${PYTHON:-}" ]; then
        uv venv --python 3.12 "$PROJECT_DIR/.venv"
    else
        "${PYTHON:-python3}" -m venv "$PROJECT_DIR/.venv"
    fi
fi
if command -v uv >/dev/null 2>&1; then
    uv pip sync --python "$PROJECT_DIR/.venv/bin/python" "$PROJECT_DIR/requirements.txt"
else
    "$PROJECT_DIR/.venv/bin/python" -m pip --isolated install --use-deprecated=legacy-certs -r "$PROJECT_DIR/requirements.txt"
fi
exec "$PROJECT_DIR/.venv/bin/python" -I "$PROJECT_DIR/scripts/native_host/install_host.py" "$@"
