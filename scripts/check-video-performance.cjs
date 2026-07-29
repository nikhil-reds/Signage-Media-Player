const path = require('node:path');
const { app, BrowserWindow, protocol } = require('electron');
const { protocolFileResponse } = require('../electron/file-response.cjs');

const source = process.argv[2] || 'media/videos/default-video.mp4';
const mediaPath = path.resolve(__dirname, '..', source);

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'perfcheck',
    privileges: { standard: true, secure: true, stream: true }
  }
]);

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

app.whenReady().then(async () => {
  protocol.handle('perfcheck', (request) => {
    if (new URL(request.url).pathname === '/video.mp4') {
      return protocolFileResponse(mediaPath, request);
    }

    return new Response(`
      <video id="video" src="perfcheck://player/video.mp4" autoplay muted loop></video>
      <script>
        const video = document.getElementById('video');
        window.result = { ready: false, error: null };
        video.addEventListener('error', () => {
          window.result.error = video.error?.message || 'media error';
        });
        video.addEventListener('playing', () => {
          if (window.result.ready) return;
          const start = video.getVideoPlaybackQuality();
          window.result = {
            ready: true,
            duration: video.duration,
            width: video.videoWidth,
            height: video.videoHeight,
            startedAt: performance.now(),
            startTotalFrames: start.totalVideoFrames,
            startDroppedFrames: start.droppedVideoFrames
          };
        });
      </script>
    `, { headers: { 'Content-Type': 'text/html' } });
  });

  const window = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    webPreferences: { backgroundThrottling: false }
  });
  await window.loadURL('perfcheck://player/index.html');
  await new Promise((resolve) => setTimeout(resolve, 8000));

  const result = await window.webContents.executeJavaScript(`
    (() => {
      const quality = video.getVideoPlaybackQuality();
      const elapsedSeconds = (performance.now() - window.result.startedAt) / 1000;
      const presentedFrames = quality.totalVideoFrames - window.result.startTotalFrames;
      const droppedFrames = quality.droppedVideoFrames - window.result.startDroppedFrames;
      return {
        ...window.result,
        elapsedSeconds,
        presentedFrames,
        droppedFrames,
        measuredFps: presentedFrames / elapsedSeconds,
        droppedPercent: presentedFrames > 0 ? (droppedFrames / presentedFrames) * 100 : 0
      };
    })()
  `);

  console.log(JSON.stringify(result, null, 2));
  window.close();
  app.quit();
  process.exitCode = result.error || result.droppedPercent > 2 ? 1 : 0;
});
