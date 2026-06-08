#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_NAME="stitcher-controller"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE_DIR="$ROOT_DIR/archive"
mkdir -p "$ARCHIVE_DIR"
OUTPUT="${1:-$ARCHIVE_DIR/$PROJECT_NAME-$TIMESTAMP.tar.gz}"

echo "Building archive: $OUTPUT"
echo "Source: $ROOT_DIR"
echo

tar -czf "$OUTPUT" \
  --exclude='.venv' \
  --exclude='node_modules' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='*.pyo' \
  --exclude='conf/backups' \
  --exclude='conf/docker-compose.yml' \
  --exclude='*.tar.gz' \
  --exclude='.git' \
  --exclude='package-lock.json' \
  -C "$(dirname "$ROOT_DIR")" \
  "$(basename "$ROOT_DIR")"

SIZE="$(du -sh "$OUTPUT" | cut -f1)"
echo "Done: $OUTPUT ($SIZE)"
echo
echo "Deploy on your VM:"
echo "  scp $OUTPUT user@vm-ip:~/"
echo "  ssh user@vm-ip 'tar -xzf $(basename "$OUTPUT") && cd $(basename "$ROOT_DIR") && python3 -m venv .venv && source .venv/bin/activate && pip install -r backend/requirements.txt && ./run_controller.sh'"
