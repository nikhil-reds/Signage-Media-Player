const { app, BrowserWindow, ipcMain, powerSaveBlocker, protocol, screen } = require('electron');
const WebSocket = require('ws');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { protocolFileResponse } = require('./file-response.cjs');
const {
  collectMachineInfo,
  discoverProvisioning,
  ensureInstallId,
  exchangePairingCode,
  persistProvisioning,
  registerInstall,
  sendHeartbeat
} = require('./provisioning.cjs');

let mainWindow;
let pairingWindow;
let powerSaveBlockerId;
let lanServer;
let playerSocket;
let reconnectTimer;

const appRoot = path.join(__dirname, '..');
const runtimeRoot = app.isPackaged ? app.getPath('userData') : appRoot;
const configPath = path.join(runtimeRoot, 'config.json');
const mediaRoot = path.join(runtimeRoot, 'media');
const lanHost = process.env.PLAYER_LAN_HOST || '0.0.0.0';
const lanPort = Number.parseInt(process.env.PLAYER_LAN_PORT || '3030', 10);
const lanToken = process.env.PLAYER_LAN_TOKEN || '';
const syncStatePath = path.join(runtimeRoot, 'sync-state.json');
const manifestCachePath = path.join(runtimeRoot, 'manifest-cache.json');

let manifestSyncTimer;
let heartbeatTimer;
let playerProvisioning;
let playerInstallId;
let scheduleEvalTimer;
let scheduleBoundaryTimer;
let scheduleBoundaryAtMs = 0;
let serverClockOffsetMs = 0;
let lastAppliedScheduleId = '';
let lastAppliedScheduleEndMs = 0;
let lastAppliedPlaylist = [];

const defaultPlaylistItem = {
  id: 'fallback',
  type: 'video',
  src: 'media/videos/default-video.mp4',
  default: true,
  loop: true,
  muted: true,
  fit: 'scale-down',
  position: 'center'
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'signlink',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
]);

function ensureRuntimeFiles() {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(mediaRoot, { recursive: true });

  if (!fs.existsSync(configPath)) {
    const bundledConfigPath = path.join(appRoot, 'config.json');
    if (fs.existsSync(bundledConfigPath)) {
      fs.copyFileSync(bundledConfigPath, configPath);
    } else {
      writeConfig({ playlist: [] });
    }
  }
}

function readStartupConfig() {
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.warn('config.json is invalid during startup; using environment settings only.', error);
    return {};
  }
}

ensureRuntimeFiles();
const startupConfig = readStartupConfig();
// Identity is assigned by the CMS during registration, so these stay mutable and
// are refreshed from config once registration completes. There is deliberately
// no shared default: an unregistered player must stay idle rather than claim a
// device id that belongs to some other screen.
let playerDeviceId = process.env.PLAYER_DEVICE_ID || startupConfig.deviceId || '';
let playerTenantId = process.env.PLAYER_TENANT_ID || startupConfig.tenantId || '';
const playerSiteId = process.env.PLAYER_SITE_ID || startupConfig.siteId || '';
const playerGroupId = process.env.PLAYER_GROUP_ID || startupConfig.groupId || '';
let playerDeviceToken =
  process.env.PLAYER_DEVICE_TOKEN ||
  process.env.PLAYER_WS_TOKEN ||
  startupConfig.deviceToken ||
  '';
let playerWsUrl =
  process.env.PLAYER_WS_URL ||
  startupConfig.playerWsUrl ||
  startupConfig.webSocketUrl ||
  'ws://localhost:3031/ws/player';
let manifestUrl =
  process.env.PLAYER_MANIFEST_URL ||
  startupConfig.manifestUrl ||
  startupConfig.playerManifestUrl ||
  '';
const manifestSyncIntervalMs = Number.parseInt(
  process.env.PLAYER_SYNC_INTERVAL_MS ||
    String(startupConfig.syncIntervalMs || startupConfig.manifestSyncIntervalMs || '30000'),
  10
);
const cdnBaseUrl =
  process.env.PLAYER_CDN_URL ||
  process.env.NEXT_PUBLIC_CDN_URL ||
  process.env.CLOUDFRONT_URL ||
  startupConfig.cdnUrl ||
  startupConfig.cdnBaseUrl ||
  '';
const s3BaseUrl = process.env.PLAYER_S3_BASE_URL || startupConfig.s3BaseUrl || '';
const playerWindowMode = process.env.PLAYER_WINDOW_MODE || startupConfig.windowMode || 'kiosk';
const playerKioskMode =
  playerWindowMode === 'kiosk' ||
  process.env.PLAYER_KIOSK === '1' ||
  startupConfig.kiosk === true;

function resolvePlayerProtocolPath(requestUrl) {
  const url = new URL(requestUrl);
  const pathname = decodeURIComponent(url.pathname.replace(/^\/+/, ''));

  if (!pathname || pathname === 'index.html') {
    return path.join(appRoot, 'index.html');
  }

  if (pathname === 'config.json') {
    return configPath;
  }

  if (pathname.startsWith('media/')) {
    const runtimeMediaPath = path.resolve(runtimeRoot, pathname);
    const bundledMediaPath = path.resolve(appRoot, pathname);

    if (runtimeMediaPath.startsWith(`${mediaRoot}${path.sep}`) && fs.existsSync(runtimeMediaPath)) {
      return runtimeMediaPath;
    }

    if (bundledMediaPath.startsWith(path.resolve(appRoot, 'media') + path.sep)) {
      return bundledMediaPath;
    }
  }

  const appFilePath = path.resolve(appRoot, pathname);
  if (!appFilePath.startsWith(`${path.resolve(appRoot)}${path.sep}`)) {
    throw new Error(`Blocked invalid app path: ${pathname}`);
  }
  return appFilePath;
}

function registerPlayerProtocol() {
  protocol.handle('signlink', async (request) => {
    const filePath = resolvePlayerProtocolPath(request.url);
    return protocolFileResponse(filePath, request);
  });
}

function enforcePlayerKioskWindow() {
  if (!playerKioskMode || !mainWindow || mainWindow.isDestroyed()) return;

  const display = screen.getPrimaryDisplay();
  mainWindow.setBounds(display.bounds);
  mainWindow.setSkipTaskbar(true);
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setFullScreen(true);
  mainWindow.setKiosk(true);
  mainWindow.moveTop();
  mainWindow.focus();
  app.focus({ steal: true });
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const bounds = playerKioskMode ? display.bounds : display.workArea;
  const width = playerKioskMode ? bounds.width : Math.min(1920, bounds.width);
  const height = playerKioskMode ? bounds.height : Math.min(1080, bounds.height);
  const x = bounds.x + Math.max(0, Math.round((bounds.width - width) / 2));
  const y = bounds.y + Math.max(0, Math.round((bounds.height - height) / 2));

  mainWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    fullscreen: playerKioskMode,
    kiosk: playerKioskMode,
    frame: !playerKioskMode,
    skipTaskbar: playerKioskMode,
    alwaysOnTop: playerKioskMode,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.cjs'),
      webviewTag: true,
      devTools: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  mainWindow.setMenu(null);
  mainWindow.setFullScreenable(true);
  mainWindow.webContents.setZoomFactor(1);
  void mainWindow.webContents.setVisualZoomLevelLimits(1, 1).catch((error) => {
    console.warn('Unable to lock visual zoom.', error);
  });
  mainWindow.webContents.on('zoom-changed', (event) => {
    event.preventDefault();
    mainWindow?.webContents.setZoomFactor(1);
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const zoomKey = input.key === '+' || input.key === '=' || input.key === '-' || input.key === '0';
    if ((input.control || input.meta) && zoomKey) event.preventDefault();
    if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'p') {
      event.preventDefault();
      void openRegistrationWindow();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!targetUrl.startsWith('signlink://player/')) {
      event.preventDefault();
    }
  });
  if (playerKioskMode) {
    mainWindow.on('leave-full-screen', () => {
      setTimeout(enforcePlayerKioskWindow, 100);
    });
    mainWindow.on('unmaximize', () => {
      setTimeout(enforcePlayerKioskWindow, 100);
    });
    mainWindow.on('restore', () => {
      setTimeout(enforcePlayerKioskWindow, 100);
    });
    mainWindow.on('blur', () => {
      if (pairingWindow && !pairingWindow.isDestroyed()) return;
      setTimeout(enforcePlayerKioskWindow, 250);
    });
  }
  mainWindow.once('ready-to-show', () => {
    mainWindow.setBounds({ x, y, width, height });
    enforcePlayerKioskWindow();
    mainWindow.show();
    enforcePlayerKioskWindow();
    setTimeout(enforcePlayerKioskWindow, 250);
    setTimeout(enforcePlayerKioskWindow, 1000);
  });
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });

  mainWindow.loadURL('signlink://player/index.html');
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  });
  response.end(JSON.stringify(body));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function readConfig() {
  if (!fs.existsSync(configPath)) return { playlist: [] };
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!Array.isArray(config.playlist)) config.playlist = [];
  return config;
}

function writeConfig(config) {
  const tmpPath = `${configPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, configPath);
}

function notifyRendererConfigUpdated(config) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('playlist.updated', {
    playbackMode: config.playbackMode || 'default',
    activeScheduleId: config.activeScheduleId || null,
    activeScheduleName: config.activeScheduleName || null,
    width: config.width,
    height: config.height,
    renderWidth: config.renderWidth,
    renderHeight: config.renderHeight,
    playlistWidth: config.playlistWidth,
    playlistHeight: config.playlistHeight,
    resolution: config.resolution,
    renderResolution: config.renderResolution,
    playlistResolution: config.playlistResolution,
    playlist: Array.isArray(config.playlist) ? config.playlist : []
  });
}

function readSyncState() {
  if (!fs.existsSync(syncStatePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(syncStatePath, 'utf8'));
  } catch (error) {
    console.warn('sync-state.json is invalid; continuing with an empty state.', error);
    return {};
  }
}

function writeSyncState(state) {
  const tmpPath = `${syncStatePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, syncStatePath);
}

function readManifestCache() {
  if (!fs.existsSync(manifestCachePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestCachePath, 'utf8'));
  } catch (error) {
    console.warn('manifest-cache.json is invalid; ignoring cached manifest.', error);
    return null;
  }
}

function writeManifestCache(manifest) {
  const tmpPath = `${manifestCachePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, manifestCachePath);
}

function safeMediaPath(folder, fileName) {
  if (!['videos', 'images', 'audio', 'html'].includes(folder)) {
    throw new Error(`Unsupported media folder: ${folder}`);
  }

  const target = path.resolve(mediaRoot, folder, path.basename(fileName));
  const folderRoot = path.resolve(mediaRoot, folder);

  if (!target.startsWith(`${folderRoot}${path.sep}`)) {
    throw new Error('Invalid media path');
  }

  return target;
}

function authorize(request, response) {
  if (!lanToken) return true;
  const header = request.headers.authorization || '';
  if (header === `Bearer ${lanToken}`) return true;
  sendJson(response, 401, { ok: false, error: 'Unauthorized' });
  return false;
}

function startLanServer() {
  lanServer = http.createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') {
        sendJson(response, 204, {});
        return;
      }

      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { ok: true, name: 'signlink-player' });
        return;
      }

      if (!authorize(request, response)) return;

      if (request.method === 'GET' && url.pathname === '/api/status') {
        sendJson(response, 200, await getPlayerStatus());
        return;
      }

      if (request.method === 'POST' && url.pathname.startsWith('/api/media/')) {
        const [, , , folder, ...nameParts] = url.pathname.split('/');
        const fileName = decodeURIComponent(nameParts.join('/'));
        const targetPath = safeMediaPath(folder, fileName);
        const tmpPath = `${targetPath}.tmp`;

        fs.mkdirSync(path.dirname(targetPath), { recursive: true });

        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(tmpPath);
          request.pipe(file);
          request.on('error', reject);
          file.on('finish', resolve);
          file.on('error', reject);
        });

        fs.renameSync(tmpPath, targetPath);
        sendJson(response, 200, {
          ok: true,
          src: path.relative(runtimeRoot, targetPath).split(path.sep).join('/')
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/playlist/add') {
        const item = await readJsonBody(request);
        const config = readConfig();
        const existingIndex = config.playlist.findIndex((entry) => entry.src === item.src);
        if (existingIndex >= 0) {
          config.playlist[existingIndex] = { ...config.playlist[existingIndex], ...item };
        } else {
          config.playlist.push(item);
        }
        normalizeLocalPlaylistResolution(config);
        writeConfig(config);
        sendJson(response, 200, {
          ok: true,
          playlistLength: config.playlist.length,
          playlistResolution: config.playlistResolution || null
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/playlist/replace') {
        const body = await readJsonBody(request);
        const config = readConfig();
        config.playlist = Array.isArray(body.playlist) ? body.playlist : [];
        normalizeLocalPlaylistResolution(config, readExplicitPlaylistResolution(body));
        writeConfig(config);
        sendJson(response, 200, {
          ok: true,
          playlistLength: config.playlist.length,
          playlistResolution: config.playlistResolution || null
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/playlist/remove') {
        const body = await readJsonBody(request);
        const config = readConfig();
        config.playlist = config.playlist.filter((entry) => entry.src !== body.src);
        normalizeLocalPlaylistResolution(config);
        writeConfig(config);
        sendJson(response, 200, {
          ok: true,
          playlistLength: config.playlist.length,
          playlistResolution: config.playlistResolution || null
        });
        return;
      }

      sendJson(response, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  lanServer.listen(lanPort, lanHost, () => {
    console.info(`Player LAN API listening on http://${lanHost}:${lanPort}`);
  });
}

function updateServerClockOffset(serverDate, source = 'server') {
  const serverTime = Date.parse(serverDate);
  if (!Number.isFinite(serverTime)) return;

  serverClockOffsetMs = serverTime - Date.now();
  console.info(
    `Player clock offset from ${source}: ${serverClockOffsetMs}ms (${new Date(serverTime).toISOString()})`
  );
}

function verifiedNow() {
  return new Date(Date.now() + serverClockOffsetMs);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  }
  const serverDate = response.headers.get('date');
  if (serverDate) updateServerClockOffset(serverDate, 'http-date');

  const body = await response.json();
  if (body?.serverNow) {
    const manifestAgeMs = Date.now() - Date.parse(body.serverNow);
    if (Number.isFinite(manifestAgeMs)) {
      console.info(
        `Manifest serverNow age=${manifestAgeMs}ms; using HTTP Date/local clock for schedule evaluation.`
      );
    }
  }
  return body;
}

function safeLocalSrc(src) {
  if (typeof src !== 'string' || !src.startsWith('media/')) {
    throw new Error(`Invalid manifest src: ${src}`);
  }

  const target = path.resolve(runtimeRoot, src);
  if (!target.startsWith(`${mediaRoot}${path.sep}`)) {
    throw new Error(`Manifest src escapes media root: ${src}`);
  }

  return target;
}

function isRemoteUrl(src) {
  return typeof src === 'string' && /^https?:\/\//i.test(src);
}

function isExternalHtmlItem(item) {
  return item?.type === 'html' && (item.sourceType === 'external_url' || isRemoteUrl(item.src));
}

function isHtmlItem(item) {
  return item?.type === 'html';
}

async function downloadFile(url, targetPath) {
  const tmpPath = `${targetPath}.tmp`;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  }

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmpPath);
    const stream = require('node:stream');
    stream.Readable.fromWeb(response.body).pipe(file);
    file.on('finish', resolve);
    file.on('error', reject);
  });

  fs.renameSync(tmpPath, targetPath);
}

function toCdnUrl(url) {
  if (!cdnBaseUrl) return url;

  const cdnBase = cdnBaseUrl.replace(/\/$/, '');
  const configuredS3Base = s3BaseUrl.replace(/\/$/, '');
  const s3Bases = configuredS3Base
    ? [configuredS3Base]
    : [
        'https://redsxp-media-processed.s3.ap-south-1.amazonaws.com',
        'https://redsxp-media-processed.s3.amazonaws.com'
      ];

  for (const s3Base of s3Bases) {
    if (url.startsWith(s3Base)) {
      return `${cdnBase}${url.slice(s3Base.length)}`;
    }
  }

  return url;
}

async function syncManifestOnce() {
  if (!manifestUrl) return;

  const manifest = await fetchJson(manifestUrl);
  const manifestItems = getDownloadableManifestItems(manifest);
  const state = readSyncState();
  const mediaState = state.media && typeof state.media === 'object' ? state.media : {};

  if (state.revision === manifest.revision && fs.existsSync(manifestCachePath)) {
    applyScheduledPlaylist(manifest);
    return;
  }

  for (const item of manifestItems) {
    if (!item || typeof item.url !== 'string') continue;
    if (isHtmlItem(item)) continue;
    if (isExternalHtmlItem(item)) continue;
    const targetPath = safeLocalSrc(item.src);
    const downloadUrl = toCdnUrl(item.url);
    const cached = mediaState[item.src];
    if (cached?.url === downloadUrl && fs.existsSync(targetPath)) {
      continue;
    }

    console.info(`Downloading manifest media ${downloadUrl} -> ${item.src}`);
    await downloadFile(downloadUrl, targetPath);
    mediaState[item.src] = {
      url: downloadUrl,
      downloadedAt: new Date().toISOString()
    };
  }

  writeManifestCache(manifest);
  applyScheduledPlaylist(manifest);
  writeSyncState({
    revision: manifest.revision,
    syncedAt: new Date().toISOString(),
    manifestUrl,
    media: mediaState
  });
  console.info(`Synced manifest revision ${manifest.revision || 'unknown'}`);
}

function getDownloadableManifestItems(manifest) {
  const items = [];

  if (Array.isArray(manifest.playlist)) {
    items.push(...manifest.playlist);
  }

  if (Array.isArray(manifest.schedules) && Array.isArray(manifest.playlists)) {
    const now = verifiedNow().getTime();
    const downloadablePlaylistIds = new Set(
      manifest.schedules
        .filter((schedule) => {
          const end = Date.parse(schedule.endAt);
          return Number.isFinite(end) && end > now;
        })
        .map((schedule) => schedule.playlistId)
        .filter((playlistId) => typeof playlistId === 'string' && playlistId.length > 0)
    );

    for (const playlist of manifest.playlists) {
      if (!downloadablePlaylistIds.has(playlist.id)) continue;
      if (Array.isArray(playlist.items)) {
        items.push(...playlist.items);
      }
    }
  } else if (Array.isArray(manifest.playlists)) {
    for (const playlist of manifest.playlists) {
      if (Array.isArray(playlist.items)) {
        items.push(...playlist.items);
      }
    }
  }

  const seen = new Set();
  return items.filter((item) => {
    if (!item || typeof item.src !== 'string') return false;
    if (seen.has(item.src)) return false;
    seen.add(item.src);
    return true;
  });
}

function isScheduleActive(schedule, now = new Date()) {
  const start = Date.parse(schedule.startAt);
  const end = Date.parse(schedule.endAt);
  const days = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : [];

  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;

  const jsDay = now.getDay();
  const cmsSunday = jsDay === 0 ? 7 : jsDay;
  return now.getTime() >= start && now.getTime() < end && (days.includes(jsDay) || days.includes(cmsSunday));
}

function getNextScheduleBoundary(manifest) {
  if (!Array.isArray(manifest?.schedules)) return null;

  const now = verifiedNow().getTime();
  const boundaries = [];
  for (const schedule of manifest.schedules) {
    const start = Date.parse(schedule.startAt);
    const end = Date.parse(schedule.endAt);
    if (Number.isFinite(start) && start > now) {
      boundaries.push({
        at: start,
        label: `start:${schedule.name || schedule.id || schedule.playlistId || 'schedule'}`
      });
    }
    if (Number.isFinite(end) && end > now) {
      boundaries.push({
        at: end,
        label: `end:${schedule.name || schedule.id || schedule.playlistId || 'schedule'}`
      });
    }
  }

  boundaries.sort((a, b) => a.at - b.at);
  return boundaries[0] || null;
}

function armNextScheduleBoundary(manifest = readManifestCache()) {
  const boundary = getNextScheduleBoundary(manifest);
  if (!boundary) {
    if (scheduleBoundaryTimer) {
      clearTimeout(scheduleBoundaryTimer);
      scheduleBoundaryTimer = undefined;
    }
    scheduleBoundaryAtMs = 0;
    return;
  }

  if (scheduleBoundaryTimer && scheduleBoundaryAtMs === boundary.at) {
    return;
  }

  if (scheduleBoundaryTimer) {
    clearTimeout(scheduleBoundaryTimer);
    scheduleBoundaryTimer = undefined;
  }
  scheduleBoundaryAtMs = boundary.at;

  const delayMs = Math.max(0, boundary.at - verifiedNow().getTime());
  scheduleBoundaryTimer = setTimeout(() => {
    scheduleBoundaryTimer = undefined;
    scheduleBoundaryAtMs = 0;
    console.info(`Schedule boundary reached (${boundary.label}); applying cached manifest.`);
    applyScheduledPlaylist();
  }, delayMs);

  console.info(
    `Next schedule boundary ${boundary.label} at ${new Date(boundary.at).toISOString()} (${delayMs}ms)`
  );
}

function selectScheduledPlaylist(manifest) {
  if (!Array.isArray(manifest.schedules) || !Array.isArray(manifest.playlists)) {
    return {
      playlist: Array.isArray(manifest.playlist) ? manifest.playlist : [],
      playlistConfig: manifest,
      activeSchedule: null
    };
  }

  const now = verifiedNow();
  const active = manifest.schedules
    .filter((schedule) => isScheduleActive(schedule, now))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];

  if (!active) {
    const graceMs = 5000;
    if (
      lastAppliedScheduleId &&
      lastAppliedPlaylist.length > 0 &&
      now.getTime() < lastAppliedScheduleEndMs + graceMs
    ) {
      return {
        playlist: lastAppliedPlaylist,
        playlistConfig: {},
        activeSchedule: {
          id: lastAppliedScheduleId,
          endAt: new Date(lastAppliedScheduleEndMs).toISOString(),
          grace: true
        }
      };
    }

    return { playlist: [], playlistConfig: {}, activeSchedule: null };
  }

  // Published manifests can contain repeated playlist IDs. The final entry is
  // the most recently published representation of that playlist.
  const playlist = [...manifest.playlists]
    .reverse()
    .find((candidate) => candidate.id === active.playlistId);
  return {
    playlist: Array.isArray(playlist?.items) ? playlist.items : [],
    playlistConfig: playlist || {},
    activeSchedule: active
  };
}

function clearPlaylistResolution(target) {
  for (const key of [
    'width',
    'height',
    'renderWidth',
    'renderHeight',
    'playlistWidth',
    'playlistHeight',
    'resolution',
    'renderResolution',
    'playlistResolution'
  ]) {
    delete target[key];
  }
}

function readExplicitPlaylistResolution(source) {
  if (!source || typeof source !== 'object') return null;

  const nested = source.playlistResolution;
  if (nested && typeof nested === 'object') {
    const nestedWidth = Number(nested.width ?? nested.w);
    const nestedHeight = Number(nested.height ?? nested.h);
    if (Number.isFinite(nestedWidth) && Number.isFinite(nestedHeight) && nestedWidth > 0 && nestedHeight > 0) {
      return { width: nestedWidth, height: nestedHeight };
    }
  }

  const width = Number(source.playlistWidth);
  const height = Number(source.playlistHeight);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height };
  }

  return null;
}

function derivePlaylistResolution(items) {
  const playableItems = Array.isArray(items) ? items.filter((item) => !item?.default) : [];
  if (playableItems.length === 0) return null;

  let width = 0;
  let height = 0;
  for (const item of playableItems) {
    const itemWidth = Number(item?.width);
    const itemHeight = Number(item?.height);
    const x = Number(item?.x ?? item?.left ?? 0);
    const y = Number(item?.y ?? item?.top ?? 0);
    if (
      !Number.isFinite(itemWidth) || itemWidth <= 0 ||
      !Number.isFinite(itemHeight) || itemHeight <= 0 ||
      !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0
    ) {
      return null;
    }
    width = Math.max(width, x + itemWidth);
    height = Math.max(height, y + itemHeight);
  }

  return width > 0 && height > 0 ? { width, height } : null;
}

function resolvePlaylistResolution(playlistConfig, items) {
  const configResolution = readExplicitPlaylistResolution(playlistConfig);
  if (configResolution) return configResolution;

  const derivedResolution = derivePlaylistResolution(items);
  return derivedResolution;
}

function applyPlaylistResolution(target, resolution) {
  if (!resolution) return;
  target.playlistResolution = resolution;
  target.renderResolution = resolution;
  target.playlistWidth = resolution.width;
  target.playlistHeight = resolution.height;
}

function normalizeLocalPlaylistResolution(config, explicitResolution = null) {
  clearPlaylistResolution(config);
  applyPlaylistResolution(
    config,
    explicitResolution || derivePlaylistResolution(config.playlist)
  );
}

async function getRendererStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;

  try {
    return await mainWindow.webContents.executeJavaScript(`
      (() => {
        const stage = document.getElementById('playlist-stage');
        const media = document.querySelector('.media-element:not(.media-element--pending)');
        const style = stage ? getComputedStyle(stage) : null;
        const quality = media?.getVideoPlaybackQuality?.();
        return {
          canvas: stage ? {
            width: Number(stage.dataset.renderWidth),
            height: Number(stage.dataset.renderHeight),
            cssWidth: style.width,
            cssHeight: style.height,
            presentationScale: style.getPropertyValue('--playlist-scale').trim()
          } : null,
          media: media ? {
            src: media.getAttribute('src'),
            paused: Boolean(media.paused),
            currentTime: Number(media.currentTime?.toFixed?.(3) || 0),
            videoWidth: Number(media.videoWidth || 0),
            videoHeight: Number(media.videoHeight || 0),
            droppedFrames: Number(quality?.droppedVideoFrames || 0),
            totalFrames: Number(quality?.totalVideoFrames || 0)
          } : null
        };
      })()
    `);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function getPlayerStatus() {
  const config = readConfig();
  return {
    ok: true,
    playbackMode: config.playbackMode || 'default',
    activeSchedule: {
      id: config.activeScheduleId || null,
      name: config.activeScheduleName || null,
      startAt: config.activeScheduleStartAt || null,
      endAt: config.activeScheduleEndAt || null
    },
    playlistResolution: readExplicitPlaylistResolution(config),
    playlist: (config.playlist || []).map((item) => ({
      id: item.id || null,
      type: item.type || null,
      src: item.src || null,
      width: Number(item.width || 0),
      height: Number(item.height || 0)
    })),
    renderer: await getRendererStatus()
  };
}

function applyScheduledPlaylist(manifest = readManifestCache()) {
  if (!manifest) return;
  armNextScheduleBoundary(manifest);

  const selected = selectScheduledPlaylist(manifest);
  const playlist = selected.playlist;
  const config = readConfig();
  const nextPlaylist = playlist
    .filter((item) => {
      if (!item?.src) return false;
      if (isExternalHtmlItem(item)) return true;
      try {
        return fs.existsSync(safeLocalSrc(item.src));
      } catch (error) {
        console.warn(
          `Skipping scheduled media with invalid local src ${item.src}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return false;
      }
    })
    .map(({ url, ...item }) => item);
  const nextPlaybackMode =
    selected.activeSchedule && nextPlaylist.length > 0 ? 'scheduled' : 'default';
  const playbackPlaylist = nextPlaybackMode === 'scheduled' ? nextPlaylist : [defaultPlaylistItem];
  const nextResolution = resolvePlaylistResolution(selected.playlistConfig, nextPlaylist);
  const currentKey = JSON.stringify({
    playbackMode: config.playbackMode || 'default',
    resolution: readExplicitPlaylistResolution(config),
    playlist: config.playlist || []
  });
  const nextKey = JSON.stringify({
    playbackMode: nextPlaybackMode,
    resolution: nextResolution,
    playlist: playbackPlaylist
  });

  if (selected.activeSchedule && playlist.length > 0 && nextPlaylist.length === 0) {
    console.warn(
      `Schedule ${selected.activeSchedule.name || selected.activeSchedule.id || 'active'} is active, ` +
        'but its media is not downloaded yet; falling back to default video.'
    );
  }

  if (selected.activeSchedule && nextPlaylist.length > 0) {
    lastAppliedScheduleId = selected.activeSchedule.id || lastAppliedScheduleId;
    lastAppliedScheduleEndMs = Date.parse(selected.activeSchedule.endAt) || lastAppliedScheduleEndMs;
    lastAppliedPlaylist = playlist;
  } else if (nextPlaylist.length === 0) {
    lastAppliedScheduleId = '';
    lastAppliedScheduleEndMs = 0;
    lastAppliedPlaylist = [];
  }

  if (currentKey === nextKey) return;

  config.playbackMode = nextPlaybackMode;
  config.activeScheduleId = selected.activeSchedule?.id || null;
  config.activeScheduleName = selected.activeSchedule?.name || null;
  config.activeScheduleStartAt = selected.activeSchedule?.startAt || null;
  config.activeScheduleEndAt = selected.activeSchedule?.endAt || null;
  config.appliedAt = new Date().toISOString();
  config.playlist = playbackPlaylist;
  clearPlaylistResolution(config);
  applyPlaylistResolution(config, nextResolution);
  writeConfig(config);
  notifyRendererConfigUpdated(config);
  console.info(
    `Applied ${nextPlaybackMode} playlist with ${nextPlaylist.length} item(s) ` +
      `(schedule=${config.activeScheduleName || config.activeScheduleId || 'none'}, now=${verifiedNow().toISOString()})`
  );
}

async function syncManifestFromPush(notification) {
  const state = readSyncState();
  if (
    notification.manifestRevision &&
    state.revision === notification.manifestRevision &&
    state.contentHash === notification.contentHash
  ) {
    console.info(`Manifest ${notification.manifestRevision} already applied, skipping push`);
    return;
  }

  const pushedManifestUrl = notification.manifestUrl || manifestUrl;
  if (!pushedManifestUrl) {
    throw new Error('manifest.updated did not include a manifestUrl and no PLAYER_MANIFEST_URL is configured');
  }

  const manifest = await fetchJson(pushedManifestUrl);
  const manifestItems = getDownloadableManifestItems(manifest);
  const mediaState = state.media && typeof state.media === 'object' ? state.media : {};

  for (const item of manifestItems) {
    if (!item || typeof item.url !== 'string') continue;
    if (isHtmlItem(item)) continue;
    if (isExternalHtmlItem(item)) continue;
    const targetPath = safeLocalSrc(item.src);
    const downloadUrl = toCdnUrl(item.url);
    const cached = mediaState[item.src];
    if (cached?.url === downloadUrl && fs.existsSync(targetPath)) continue;

    console.info(`Downloading pushed manifest media ${downloadUrl} -> ${item.src}`);
    await downloadFile(downloadUrl, targetPath);
    mediaState[item.src] = {
      url: downloadUrl,
      downloadedAt: new Date().toISOString()
    };
  }

  writeManifestCache(manifest);
  applyScheduledPlaylist(manifest);
  writeSyncState({
    revision: manifest.revision || notification.manifestRevision,
    contentHash: notification.contentHash,
    syncedAt: new Date().toISOString(),
    manifestUrl: pushedManifestUrl,
    media: mediaState
  });
}

function sendPlayerSocketMessage(message) {
  if (!playerSocket || playerSocket.readyState !== WebSocket.OPEN) return;
  playerSocket.send(JSON.stringify(message));
}

function startPlayerWebSocket() {
  if (!playerWsUrl) return;
  if (!playerDeviceId || !playerDeviceToken) {
    console.warn('Player WebSocket not started: no device identity assigned yet.');
    return;
  }

  const url = new URL(playerWsUrl);
  url.searchParams.set('deviceId', playerDeviceId);
  url.searchParams.set('token', playerDeviceToken);
  if (playerTenantId) url.searchParams.set('tenantId', playerTenantId);
  if (playerSiteId) url.searchParams.set('siteId', playerSiteId);
  if (playerGroupId) url.searchParams.set('groupId', playerGroupId);

  playerSocket = new WebSocket(url.toString());

  playerSocket.on('open', () => {
    console.info(`Connected to player WebSocket gateway as ${playerDeviceId}`);
  });

  playerSocket.on('message', (raw) => {
    handlePlayerSocketMessage(raw.toString()).catch((error) => {
      console.warn('Player WebSocket message failed:', error);
    });
  });

  playerSocket.on('close', () => {
    console.warn('Player WebSocket disconnected, reconnecting soon');
    schedulePlayerWebSocketReconnect();
  });

  playerSocket.on('error', (error) => {
    console.warn('Player WebSocket error:', error.message);
  });
}

function schedulePlayerWebSocketReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    startPlayerWebSocket();
  }, 3000);
}

async function handlePlayerSocketMessage(raw) {
  const message = JSON.parse(raw);
  if (message.type !== 'manifest.updated') return;

  try {
    const startedAt = new Date().toISOString();
    await syncManifestFromPush(message);
    sendPlayerSocketMessage({
      schemaVersion: 1,
      type: 'manifest.applied',
      eventId: message.eventId,
      deviceId: playerDeviceId,
      manifestRevision: message.manifestRevision,
      contentHash: message.contentHash,
      receivedAt: startedAt,
      appliedAt: new Date().toISOString()
    });
  } catch (error) {
    sendPlayerSocketMessage({
      schemaVersion: 1,
      type: 'manifest.apply_failed',
      eventId: message.eventId,
      deviceId: playerDeviceId,
      manifestRevision: message.manifestRevision,
      error: error instanceof Error ? error.message : String(error),
      failedAt: new Date().toISOString()
    });
    throw error;
  }
}

function manifestUrlForDevice(deviceId) {
  if (!cdnBaseUrl || !deviceId) return '';
  return `${cdnBaseUrl.replace(/\/$/, '')}/manifests/${deviceId}.json`;
}

/**
 * Recovery UI shown when no provisioning file was found. Resolves with the
 * provisioning payload once the agent types a valid pairing code.
 */
function registrationDetails() {
  const config = readConfig();
  return {
    apiBaseUrl: process.env.PLAYER_API_BASE_URL || playerProvisioning?.apiBaseUrl || startupConfig.apiBaseUrl || '',
    deviceId: playerDeviceId || config.deviceId || '',
    deviceName: config.deviceName || '',
    registrationId: playerProvisioning?.registrationId || config.registrationId || '',
    installId: playerInstallId || config.installId || '',
    registeredAt: config.registeredAt || ''
  };
}

function stopRegistrationServices() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  if (manifestSyncTimer) {
    clearInterval(manifestSyncTimer);
    manifestSyncTimer = undefined;
  }
  if (scheduleEvalTimer) {
    clearInterval(scheduleEvalTimer);
    scheduleEvalTimer = undefined;
  }
  if (scheduleBoundaryTimer) {
    clearTimeout(scheduleBoundaryTimer);
    scheduleBoundaryTimer = undefined;
    scheduleBoundaryAtMs = 0;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  if (playerSocket) {
    playerSocket.close();
    playerSocket = undefined;
  }
}

async function refreshRegistration() {
  stopRegistrationServices();
  const registered = await registerWithCms({ strict: true });
  if (!registered) throw new Error('CMS registration did not return a device identity.');
  startHeartbeat();
  startManifestSync();
  startPlayerWebSocket();
  return registrationDetails();
}

function clearLocalRegistration() {
  stopRegistrationServices();
  const provisioningPath = path.join(runtimeRoot, 'provisioning.json');
  try {
    fs.unlinkSync(provisioningPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const config = readConfig();
  for (const key of ['deviceId', 'deviceToken', 'tenantId', 'manifestUrl', 'registrationId', 'registeredAt']) {
    delete config[key];
  }
  writeConfig(config);
  playerProvisioning = undefined;
  playerDeviceId = '';
  playerDeviceToken = '';
  playerTenantId = '';
  manifestUrl = '';
  console.info('Local player registration was cleared by the operator.');
}

async function openRegistrationWindow() {
  if (pairingWindow && !pairingWindow.isDestroyed()) {
    pairingWindow.focus();
    return;
  }
  await showPairingWindow({ allowExistingRegistration: true });
}

function showPairingWindow({ allowExistingRegistration = false } = {}) {
  return new Promise((resolve) => {
    pairingWindow = new BrowserWindow({
      width: 720,
      height: 620,
      fullscreen: playerKioskMode,
      title: 'Pair this screen',
      backgroundColor: '#0d131e',
      webPreferences: {
        preload: path.join(__dirname, 'pairing-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    let settled = false;

    ipcMain.handle('pairing:defaults', () => registrationDetails());

    ipcMain.handle('pairing:submit', async (_event, { apiBaseUrl, code }) => {
      try {
        const provisioning = await exchangePairingCode(apiBaseUrl, code);
        persistProvisioning(runtimeRoot, provisioning);
        playerProvisioning = provisioning;
        if (allowExistingRegistration) {
          // Do not fall back to the old screen identity if the new registration
          // request fails. The operator needs to see that failure and retry.
          playerDeviceId = '';
          playerDeviceToken = '';
          const details = await refreshRegistration();
          return { ok: true, details };
        }
        settled = true;
        resolve(provisioning);
        setTimeout(() => {
          if (!pairingWindow.isDestroyed()) pairingWindow.close();
        }, 800);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    });

    ipcMain.handle('pairing:reset', () => {
      clearLocalRegistration();
      return registrationDetails();
    });

    pairingWindow.on('closed', () => {
      ipcMain.removeHandler('pairing:defaults');
      ipcMain.removeHandler('pairing:submit');
      ipcMain.removeHandler('pairing:reset');
      pairingWindow = undefined;
      if (!settled) resolve(null);
    });

    pairingWindow.loadFile(path.join(__dirname, 'pairing.html'));
  });
}

/**
 * Registers with the CMS on every launch. The install endpoint is idempotent per
 * installId, so repeat calls simply refresh the machine info the CMS holds.
 * Returns false when the player could not be linked to a screen.
 */
async function registerWithCms({ strict = false } = {}) {
  let discovered = discoverProvisioning({ app, appRoot, runtimeRoot });

  if (!discovered) {
    console.warn('No provisioning.json found; asking the operator to pair this screen.');
    const paired = await showPairingWindow();
    if (!paired) {
      console.warn('Pairing was cancelled. This player is not linked to a screen.');
      return false;
    }
    discovered = { provisioning: paired, sourcePath: path.join(runtimeRoot, 'provisioning.json') };
  }

  playerProvisioning = discovered.provisioning;
  playerInstallId = ensureInstallId(runtimeRoot);

  // Keep a copy in the runtime dir so later launches work after the agent
  // deletes the unzipped download folder.
  if (discovered.sourcePath !== path.join(runtimeRoot, 'provisioning.json')) {
    try {
      persistProvisioning(runtimeRoot, playerProvisioning);
    } catch (error) {
      console.warn('Could not persist provisioning file:', error.message);
    }
  }

  const machineInfo = collectMachineInfo({ app, screen });

  try {
    const identity = await registerInstall({
      provisioning: playerProvisioning,
      installId: playerInstallId,
      machineInfo
    });

    if (!identity?.deviceId || !identity?.deviceToken) {
      const responseShape = identity ? Object.keys(identity).join(', ') : 'empty response';
      const error = new Error(`CMS install response did not include deviceId/deviceToken (${responseShape}).`);
      console.error(error.message);
      if (strict) throw error;
      return false;
    }

    playerDeviceId = identity.deviceId;
    playerDeviceToken = identity.deviceToken;
    playerTenantId = playerProvisioning.tenantId || playerTenantId;
    manifestUrl =
      process.env.PLAYER_MANIFEST_URL ||
      identity.manifestUrl ||
      manifestUrlForDevice(identity.deviceId) ||
      manifestUrl;
    playerWsUrl = process.env.PLAYER_WS_URL || identity.webSocketUrl || playerWsUrl;

    const config = readConfig();
    writeConfig({
      ...config,
      deviceId: playerDeviceId,
      deviceName: identity.deviceName || config.deviceName || '',
      deviceToken: playerDeviceToken,
      tenantId: playerTenantId,
      manifestUrl,
      playerWsUrl,
      cdnUrl: identity.cdnUrl || config.cdnUrl || cdnBaseUrl || '',
      registrationId: playerProvisioning.registrationId,
      installId: playerInstallId,
      registeredAt: new Date().toISOString()
    });

    console.info(
      `Registered with CMS as device ${playerDeviceId}` +
        (identity.deviceName ? ` (${identity.deviceName})` : '')
    );
    return true;
  } catch (error) {
    console.error('CMS registration failed:', error.message);
    if (strict) throw error;
    // A previously registered player keeps running on its stored identity.
    return Boolean(playerDeviceId && playerDeviceToken);
  }
}

function startHeartbeat() {
  if (!playerProvisioning || !playerDeviceId || !playerDeviceToken) return;

  const intervalMs = Number.parseInt(
    process.env.PLAYER_HEARTBEAT_INTERVAL_MS || String(startupConfig.heartbeatIntervalMs || '60000'),
    10
  );

  const beat = async () => {
    try {
      await sendHeartbeat({
        provisioning: playerProvisioning,
        deviceId: playerDeviceId,
        deviceToken: playerDeviceToken,
        machineInfo: collectMachineInfo({ app, screen })
      });
    } catch (error) {
      console.warn('Heartbeat failed:', error.message);
    }
  };

  beat();
  heartbeatTimer = setInterval(beat, Number.isFinite(intervalMs) ? intervalMs : 60000);
}

function startManifestSync() {
  if (process.env.PLAYER_MANIFEST_SYNC === '0') {
    console.info('Player manifest sync disabled by PLAYER_MANIFEST_SYNC=0.');
    return;
  }

  if (!manifestUrl) return;

  console.info(`Player manifest sync enabled: ${manifestUrl}`);
  syncManifestOnce().catch((error) => {
    console.warn('Initial manifest sync failed; keeping current local config.', error);
  });

  manifestSyncTimer = setInterval(() => {
    syncManifestOnce().catch((error) => {
      console.warn('Manifest sync failed; keeping current local config.', error);
    });
  }, manifestSyncIntervalMs);

  applyScheduledPlaylist();
  scheduleEvalTimer = setInterval(() => {
    applyScheduledPlaylist();
  }, 1000);
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-pinch');
// Allow the renderer (loaded from file://) to re-read config.json from disk,
// so media synced by the cms-worker starts playing without a restart.
app.commandLine.appendSwitch('allow-file-access-from-files');

app.whenReady().then(async () => {
  powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  registerPlayerProtocol();
  startLanServer();

  // Show the window first so a screen that cannot reach the CMS still displays
  // its cached playlist instead of staying black while registration retries.
  createWindow();

  const registered = await registerWithCms();
  if (registered) {
    startHeartbeat();
    startManifestSync();
    startPlayerWebSocket();
  } else {
    console.warn('Skipping manifest sync and gateway connection until this player is registered.');
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (lanServer) {
    lanServer.close();
    lanServer = undefined;
  }
  if (manifestSyncTimer) {
    clearInterval(manifestSyncTimer);
    manifestSyncTimer = undefined;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  if (scheduleEvalTimer) {
    clearInterval(scheduleEvalTimer);
    scheduleEvalTimer = undefined;
  }
  if (scheduleBoundaryTimer) {
    clearTimeout(scheduleBoundaryTimer);
    scheduleBoundaryTimer = undefined;
    scheduleBoundaryAtMs = 0;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  if (playerSocket) {
    playerSocket.close();
    playerSocket = undefined;
  }
  if (powerSaveBlockerId !== undefined && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
    powerSaveBlocker.stop(powerSaveBlockerId);
  }
  app.quit();
});
