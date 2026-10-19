#!/bin/sh
# Generates a 3-minute synthetic lesson video (VP8/WebM plays in Playwright's Chromium build).
set -e
cd "$(dirname "$0")/.."
mkdir -p media
[ -f media/lesson.webm ] && exit 0
ffmpeg -hide_banner -loglevel error -f lavfi -i "testsrc2=size=480x270:rate=10:duration=180" \
  -c:v libvpx -b:v 90k -deadline realtime -cpu-used 8 -g 10 -an media/lesson.webm
echo "wrote media/lesson.webm"
