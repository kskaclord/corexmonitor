#!/usr/bin/env node

// CoreX War Monitor — Headless browser capture for FFmpeg streaming
// Launches Chromium via Puppeteer, opens the monitor dashboard,
// and keeps it running so FFmpeg can capture the Xvfb display.

const puppeteer = require('puppeteer');

const PORT = process.env.PORT || 3000;
const MONITOR_URL = \`http://localhost:\${PORT}/monitor\`;
const DISPLAY = process.env.DISPLAY || ':99';

async function main() {
  console.log(\`[CAPTURE] Launching Chromium on DISPLAY=\${DISPLAY}\`);
  console.log(\`[CAPTURE] Target: \${MONITOR_URL}\`);

  const browser = await puppeteer.launch({
    headless: false,              // Need visible window for Xvfb capture
    defaultViewport: null,        // Use window size instead
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
      '--window-position=0,0',
      '--start-fullscreen',
      '--autoplay-policy=no-user-gesture-required',  // Allow YouTube audio
      '--disable-features=TranslateUI',
      '--disable-infobars',
      '--kiosk',                  // Fullscreen kiosk mode
      \`--display=\${DISPLAY}\`,
    ],
    ignoreDefaultArgs: ['--mute-audio'],  // Keep audio enabled
  });

  const page = await browser.newPage();

  // Set viewport to exact 1920x1080
  await page.setViewport({ width: 1920, height: 1080 });

  // Navigate to monitor dashboard
  console.log('[CAPTURE] Loading monitor dashboard...');
  await page.goto(MONITOR_URL, {
    waitUntil: 'networkidle2',
    timeout: 30000,
  });

  console.log('[CAPTURE] Dashboard loaded. Browser running.');
  console.log('[CAPTURE] FFmpeg can now capture DISPLAY=' + DISPLAY);

  // Keep alive — handle page crashes gracefully
  page.on('error', (err) => {
    console.error('[CAPTURE] Page error:', err.message);
  });

  page.on('pageerror', (err) => {
    console.error('[CAPTURE] Page JS error:', err.message);
  });

  // Auto-reload if page becomes unresponsive (every 30 min check)
  setInterval(async () => {
    try {
      await page.evaluate(() => document.title);
    } catch {
      console.log('[CAPTURE] Page unresponsive, reloading...');
      try {
        await page.goto(MONITOR_URL, {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });
        console.log('[CAPTURE] Reloaded successfully');
      } catch (reloadErr) {
        console.error('[CAPTURE] Reload failed:', reloadErr.message);
      }
    }
  }, 30 * 60 * 1000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[CAPTURE] Shutting down browser...');
    await browser.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[CAPTURE] Fatal error:', err.message);
  process.exit(1);
});
