#!/usr/bin/env bash
# build.sh — Render build script
# Installs Python dependencies + Playwright Chromium browser binary

set -e

echo "==> Installing Python dependencies..."
pip install -r backend/requirements.txt

echo "==> Installing Playwright browser binary..."
playwright install chromium

echo "==> Build complete."
