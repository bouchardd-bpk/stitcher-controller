#!/usr/bin/env bash

set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$ROOT_DIR/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"

ensure_venv() {
  if python3 -m venv "$VENV_DIR" 2>/dev/null && [ -x "$VENV_PYTHON" ]; then
    return 0
  fi

  # venv creation failed — install python3-venv and retry
  rm -rf "$VENV_DIR"
  echo "python3-venv not functional, installing..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get install -y python3-venv
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y python3
  else
    echo "ERROR: cannot install python3-venv automatically." >&2
    echo "  Debian/Ubuntu: sudo apt-get install -y python3-venv" >&2
    echo "  RHEL/Fedora:   sudo dnf install -y python3" >&2
    exit 1
  fi

  python3 -m venv "$VENV_DIR"
}

if [ ! -x "$VENV_PYTHON" ]; then
  ensure_venv
fi

if ! "$VENV_PYTHON" -m pip --version >/dev/null 2>&1; then
  echo "pip not available in virtualenv, bootstrapping ensurepip..."
  "$VENV_PYTHON" -m ensurepip --upgrade
fi

"$VENV_PYTHON" -m pip install -r "$ROOT_DIR/backend/requirements.txt"

exec "$VENV_PYTHON" -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8812 --reload --app-dir "$ROOT_DIR"
