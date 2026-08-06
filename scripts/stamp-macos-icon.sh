#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICNS="$ROOT/src-tauri/icons/icon.icns"
BIN="$ROOT/src-tauri/target/debug/canopy"
APP="$ROOT/src-tauri/target/debug/bundle/macos/Canopy.app"
[[ -f "$ICNS" ]] || exit 0
osascript -l JavaScript -e "
ObjC.import('AppKit');
const image = \$.NSImage.alloc.initWithContentsOfFile('$ICNS');
const ws = \$.NSWorkspace.sharedWorkspace;
if (\$.NSFileManager.defaultManager.fileExistsAtPath('$BIN')) {
  ws.setIconForFileOptions(image, '$BIN', 0);
}
if (\$.NSFileManager.defaultManager.fileExistsAtPath('$APP')) {
  ws.setIconForFileOptions(image, '$APP', 0);
}
'done';
" >/dev/null
