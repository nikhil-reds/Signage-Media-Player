const path = require('node:path');
const { app, BrowserWindow, protocol } = require('electron');
const { protocolFileResponse } = require('../electron/file-response.cjs');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'loopcheck',
    privileges: { standard: true, secure: true, stream: true }
  }
]);

app.whenReady().then(async () => {
  const mediaPath = path.join(__dirname, '..', 'media', 'videos', 'default-video.mp4');
  protocol.handle('loopcheck', (request) => {
    if (new URL(request.url).pathname === '/video.mp4') {
      return protocolFileResponse(mediaPath, request);
    }

    return new Response(`
      <video id="video" src="loopcheck://player/video.mp4" autoplay muted loop></video>
      <script>
        const video = document.getElementById('video');
        window.loopResult = { ready: false, looped: false, error: null };
        video.addEventListener('error', () => {
          window.loopResult.error = video.error?.message || 'media error';
        });
        video.addEventListener('loadedmetadata', async () => {
          window.loopResult.ready = true;
          video.currentTime = Math.max(0, video.duration - 0.25);
          await video.play();
          const timer = setInterval(() => {
            if (video.currentTime < 0.2 && !video.paused) {
              window.loopResult.looped = true;
              clearInterval(timer);
            }
          }, 25);
        }, { once: true });
      </script>
    `, { headers: { 'Content-Type': 'text/html' } });
  });

  const window = new BrowserWindow({
    show: false,
    webPreferences: { autoplayPolicy: 'no-user-gesture-required' }
  });
  await window.loadURL('loopcheck://player/index.html');

  const deadline = Date.now() + 10000;
  let result;
  do {
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await window.webContents.executeJavaScript('window.loopResult');
  } while (!result.looped && !result.error && Date.now() < deadline);

  console.log(JSON.stringify(result, null, 2));
  window.close();
  app.quit();
  process.exitCode = result.looped ? 0 : 1;
});
