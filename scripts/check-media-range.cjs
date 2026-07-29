const path = require('node:path');
const { app } = require('electron');
const { protocolFileResponse } = require('../electron/file-response.cjs');

app.whenReady().then(async () => {
  const mediaPath = path.join(__dirname, '..', 'media', 'videos', 'default-video.mp4');
  const response = protocolFileResponse(mediaPath, {
    method: 'GET',
    headers: new Headers({ Range: 'bytes=0-1023' })
  });
  const body = await response.arrayBuffer();
  const result = {
    status: response.status,
    contentRange: response.headers.get('content-range'),
    acceptRanges: response.headers.get('accept-ranges'),
    bytes: body.byteLength
  };

  console.log(JSON.stringify(result, null, 2));
  app.quit();
  process.exitCode =
    result.status === 206 &&
    result.contentRange?.startsWith('bytes 0-1023/') &&
    result.bytes === 1024
      ? 0
      : 1;
});
