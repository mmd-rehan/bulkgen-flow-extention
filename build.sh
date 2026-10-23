#!/bin/sh
# Builds the zip to upload to the Chrome Web Store: dist/bulkgen-flow-<version>.zip
set -e
cd "$(dirname "$0")/extension"
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
out="../dist/bulkgen-flow-$version.zip"
mkdir -p ../dist
rm -f "$out"
zip -q -X "$out" manifest.json background.js content.js sidepanel.html sidepanel.css sidepanel.js icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png
echo "Built $out"
unzip -l "$out"
