#!/bin/sh
# Headless screenshots of every dashboard page (dev helper)
OUT="${1:-./shots}"; mkdir -p "$OUT"
for p in sales cancel prep ratings items delayed; do
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
    --window-size=1500,1250 --virtual-time-budget=9000 --screenshot="$OUT/$p.png" "http://localhost:3000/#$p" >/dev/null 2>&1
done
ls "$OUT"
