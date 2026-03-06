#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# CoreX War Monitor — YouTube Live Stream Script
# Captures Xvfb virtual display + PulseAudio and streams via RTMP
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────
DISPLAY=${DISPLAY:-:99}
RESOLUTION="1920x1080"
FPS="30"
VIDEO_BITRATE="4500k"
AUDIO_BITRATE="128k"
RTMP_URL="rtmp://a.rtmp.youtube.com/live2"

if [ -z "${YOUTUBE_RTMP_KEY:-}" ]; then
  echo "[STREAM] ERROR: YOUTUBE_RTMP_KEY environment variable is not set"
  exit 1
fi

STREAM_KEY="${YOUTUBE_RTMP_KEY}"
FULL_RTMP_URL="${RTMP_URL}/${STREAM_KEY}"

echo "═══════════════════════════════════════════════════"
echo "  COREX WAR MONITOR — STREAM LAUNCHER"
echo "═══════════════════════════════════════════════════"
echo "[STREAM] Display:    ${DISPLAY}"
echo "[STREAM] Resolution: ${RESOLUTION}@${FPS}fps"
echo "[STREAM] Bitrate:    ${VIDEO_BITRATE} video / ${AUDIO_BITRATE} audio"
echo "[STREAM] RTMP:       ${RTMP_URL}/****"
echo ""

# ─── Step 1: Start Xvfb (virtual framebuffer) ───────────────
echo "[STREAM] Starting Xvfb on ${DISPLAY}..."
Xvfb ${DISPLAY} -screen 0 ${RESOLUTION}x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 2

# Verify Xvfb is running
if ! kill -0 ${XVFB_PID} 2>/dev/null; then
  echo "[STREAM] ERROR: Xvfb failed to start"
  exit 1
fi
echo "[STREAM] Xvfb running (PID: ${XVFB_PID})"

# ─── Step 2: Start PulseAudio (virtual audio sink) ──────────
echo "[STREAM] Starting PulseAudio..."
pulseaudio --start --exit-idle-time=-1 2>/dev/null || true
# Create a virtual monitor sink for capturing browser audio
pactl load-module module-null-sink sink_name=virtual_speaker sink_properties=device.description="VirtualSpeaker" 2>/dev/null || true
pactl load-module module-virtual-source source_name=virtual_mic master=virtual_speaker.monitor 2>/dev/null || true
export PULSE_SINK=virtual_speaker
sleep 1
echo "[STREAM] PulseAudio ready"

# ─── Step 3: Launch browser capture ─────────────────────────
echo "[STREAM] Launching headless browser..."
export DISPLAY
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "${SCRIPT_DIR}/capture.js" &
BROWSER_PID=$!
sleep 5

if ! kill -0 ${BROWSER_PID} 2>/dev/null; then
  echo "[STREAM] ERROR: Browser failed to start"
  kill ${XVFB_PID} 2>/dev/null
  exit 1
fi
echo "[STREAM] Browser running (PID: ${BROWSER_PID})"

# ─── Step 4: Start FFmpeg stream ────────────────────────────
echo "[STREAM] Starting FFmpeg stream to YouTube..."
echo ""

ffmpeg \
  -f x11grab \
  -video_size ${RESOLUTION} \
  -framerate ${FPS} \
  -i ${DISPLAY}+0,0 \
  -f pulse \
  -i virtual_speaker.monitor \
  -c:v libx264 \
  -preset veryfast \
  -maxrate ${VIDEO_BITRATE} \
  -bufsize 9000k \
  -pix_fmt yuv420p \
  -g $(( FPS * 2 )) \
  -keyint_min ${FPS} \
  -sc_threshold 0 \
  -c:a aac \
  -b:a ${AUDIO_BITRATE} \
  -ar 44100 \
  -f flv \
  "${FULL_RTMP_URL}" &

FFMPEG_PID=$!
echo "[STREAM] FFmpeg running (PID: ${FFMPEG_PID})"
echo "[STREAM] ════════════════════════════════════════"
echo "[STREAM]   LIVE STREAM ACTIVE"
echo "[STREAM] ════════════════════════════════════════"

# ─── Cleanup on exit ────────────────────────────────────────
cleanup() {
  echo ""
  echo "[STREAM] Shutting down..."
  kill ${FFMPEG_PID} 2>/dev/null || true
  kill ${BROWSER_PID} 2>/dev/null || true
  kill ${XVFB_PID} 2>/dev/null || true
  pulseaudio --kill 2>/dev/null || true
  echo "[STREAM] All processes stopped."
  exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# Wait for FFmpeg to finish (or be killed)
wait ${FFMPEG_PID}
