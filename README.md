# CoreX War Monitor

Real-time war monitoring dashboard that aggregates news from RSS feeds, displays them on an interactive map, shows live camera feeds, and streams 24/7 to YouTube Live.

## Architecture

```
monitor.html          Frontend dashboard (1920x1080, served at /monitor)
src/warMonitor/
  server.ts           Backend: RSS, markets, Redis, WebSocket, REST API
  capture.js          Puppeteer: headless browser for screen capture
  stream.sh           FFmpeg: captures display + audio, streams to YouTube
```

## Requirements

- **Node.js** >= 18
- **Redis** running instance
- **FFmpeg** with x11grab and libx264 support
- **Xvfb** virtual framebuffer (Linux)
- **PulseAudio** for audio capture (Linux)
- **Chromium** (installed automatically by Puppeteer)

## Setup

```bash
cd src/warMonitor
npm install
```

## Environment Variables

Create a `.env` file in the project root:

```
REDIS_URL=redis://127.0.0.1:6379
YOUTUBE_RTMP_KEY=your-stream-key-here
PORT=3000
```

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection URL |
| `YOUTUBE_RTMP_KEY` | — | YouTube Live stream key (required for streaming) |
| `PORT` | `3000` | HTTP server port |
| `WS_PORT` | `3001` | WebSocket server port |

## Running

### Step 1: Start the backend server

```bash
cd src/warMonitor
npm run dev
```

This starts:
- HTTP API on `http://localhost:3000`
- WebSocket on `ws://localhost:3001`
- RSS fetching every 15 minutes
- Market data every 5 minutes

### Step 2: View the dashboard

Open `http://localhost:3000/monitor` in a browser.

### Step 3: Start headless browser capture (Linux)

```bash
export DISPLAY=:99
node src/warMonitor/capture.js
```

### Step 4: Start YouTube Live stream (Linux)

```bash
export YOUTUBE_RTMP_KEY=your-stream-key
bash src/warMonitor/stream.sh
```

This script automatically:
1. Starts Xvfb virtual display
2. Starts PulseAudio virtual audio
3. Launches Chromium via Puppeteer
4. Captures screen + audio with FFmpeg
5. Streams to `rtmp://a.rtmp.youtube.com/live2/`

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /monitor` | Dashboard HTML page |
| `GET /api/news?limit=50&category=all` | News feed (category: `all`, `critical`, `high`, `general`) |
| `GET /api/markets` | Market data (BIST, S&P500, NASDAQ, USD/TRY, EUR/TRY, ALTIN) |
| `GET /health` | Server health check |

## WebSocket

Connect to `ws://localhost:3001` for real-time updates:

```json
{ "type": "init", "items": [...] }     // On connect: last 50 news
{ "type": "news", "item": {...} }       // New news item
{ "type": "markets", "data": {...} }    // Market update
```

## RSS Sources

- Al Jazeera English
- Reuters World
- BBC World
- TRT World

## Stream Specs

- Resolution: 1920x1080
- FPS: 30
- Video: H.264, 4500 kbps
- Audio: AAC, 128 kbps, 44100 Hz
