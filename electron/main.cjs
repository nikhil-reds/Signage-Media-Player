const { app, BrowserWindow, powerSaveBlocker } = require('electron');
const path = require('node:path');

let mainWindow;
let powerSaveBlockerId;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    fullscreen: true,
    kiosk: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  mainWindow.setMenu(null);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-pinch');

app.whenReady().then(() => {
  powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (powerSaveBlockerId !== undefined && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    powerSaveBlocker.stop(powerSaveBlockerId);
  }
  app.quit();
});
