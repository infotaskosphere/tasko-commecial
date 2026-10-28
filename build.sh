#!/usr/bin/env bash
# build.sh — Render build script
# Installs Python dependencies + Playwright Chromium browser binary

set -e

echo "==> Installing archive extraction support (7-Zip for RAR5)..."
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y 7zip 7zip-rar antiword catdoc || apt-get install -y p7zip-full antiword catdoc || true
fi

echo "==> Installing OCR runtime (Tesseract + Poppler)..."
if command -v apt-get >/dev/null 2>&1; then
  apt-get install -y tesseract-ocr poppler-utils || true
fi

echo "==> Installing Python dependencies..."
# requirements.txt lists what we depend on; requirements.lock pins every
# package (including indirect ones) so each deploy installs the same versions.
# After editing requirements.txt, re-lock with:
#   uv pip compile requirements.txt --python-version 3.12 --python-platform linux -o requirements.lock
pip install -r requirements.lock

echo "==> Installing Playwright browser binary..."
playwright install chromium

echo "==> Build complete."
