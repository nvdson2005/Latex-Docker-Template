#!/usr/bin/env bash
# Build main.pdf via docker compose and export a dated copy to export/.
# Usage: ./build.sh [export-name]   (default: Document)
set -euo pipefail
cd "$(dirname "$0")"

name="${1:-Document}"

docker compose run --rm latex

mkdir -p export
out="export/${name}-$(date +%y-%m-%d).pdf"
cp build/main.pdf "$out"
echo "Exported $out"
