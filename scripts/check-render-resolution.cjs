const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const expectedWidth = Number(process.argv[2] || 2880);
const expectedHeight = Number(process.argv[3] || 1080);

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  await window.loadFile(path.join(__dirname, '..', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 500));

  const result = await window.webContents.executeJavaScript(`
    (() => {
      const stage = document.getElementById('playlist-stage');
      const style = getComputedStyle(stage);
      return {
        renderWidth: Number(stage.dataset.renderWidth),
        renderHeight: Number(stage.dataset.renderHeight),
        computedWidth: style.width,
        computedHeight: style.height,
        scale: style.getPropertyValue('--playlist-scale').trim()
      };
    })()
  `);

  console.log(JSON.stringify(result, null, 2));
  const valid =
    result.renderWidth === expectedWidth &&
    result.renderHeight === expectedHeight &&
    result.computedWidth === `${expectedWidth}px` &&
    result.computedHeight === `${expectedHeight}px`;

  await window.close();
  app.quit();
  process.exitCode = valid ? 0 : 1;
});
