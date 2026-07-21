const { app, BrowserWindow, net, powerSaveBlocker, protocol } = require('electron');
const WebSocket = require('ws');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mainWindow;
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
let scheduleEvalTimer;
let serverClockOffsetMs = 0;
let lastAppliedScheduleId = '';
let lastAppliedScheduleEndMs = 0;
let lastAppliedPlaylist = [];

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
const playerDeviceId = process.env.PLAYER_DEVICE_ID || startupConfig.deviceId || 'SL-PLAYER-001';
const playerTenantId = process.env.PLAYER_TENANT_ID || startupConfig.tenantId || '';
const playerSiteId = process.env.PLAYER_SITE_ID || startupConfig.siteId || '';
const playerGroupId = process.env.PLAYER_GROUP_ID || startupConfig.groupId || '';
const playerDeviceToken =
  process.env.PLAYER_DEVICE_TOKEN ||
  process.env.PLAYER_WS_TOKEN ||
  startupConfig.deviceToken ||
  'change-me';
const playerWsUrl =
  process.env.PLAYER_WS_URL ||
  startupConfig.playerWsUrl ||
  startupConfig.webSocketUrl ||
  'ws://localhost:3001/ws/player';
const manifestUrl =
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

function protocolFileResponse(filePath) {
  return net.fetch(pathToFileURL(filePath).toString());
}

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
    return protocolFileResponse(filePath);
  });
}

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
      preload: path.join(__dirname, 'preload.cjs'),
      devTools: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  mainWindow.setMenu(null);
  mainWindow.once('ready-to-show', () => mainWindow.show());
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

function notifyRendererPlaylistUpdated(playlist) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('playlist.updated', playlist);
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
  if (!['videos', 'images', 'audio'].includes(folder)) {
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
        writeConfig(config);
        sendJson(response, 200, { ok: true, playlistLength: config.playlist.length });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/playlist/replace') {
        const body = await readJsonBody(request);
        const config = readConfig();
        config.playlist = Array.isArray(body.playlist) ? body.playlist : [];
        writeConfig(config);
        sendJson(response, 200, { ok: true, playlistLength: config.playlist.length });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/playlist/remove') {
        const body = await readJsonBody(request);
        const config = readConfig();
        config.playlist = config.playlist.filter((entry) => entry.src !== body.src);
        writeConfig(config);
        sendJson(response, 200, { ok: true, playlistLength: config.playlist.length });
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

function updateServerClockOffset(serverDate) {
  const serverTime = Date.parse(serverDate);
  if (!Number.isFinite(serverTime)) return;

  serverClockOffsetMs = serverTime - Date.now();
  console.info(
    `Player clock offset from server: ${serverClockOffsetMs}ms (server=${new Date(serverTime).toISOString()})`
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
  if (serverDate) updateServerClockOffset(serverDate);

  const body = await response.json();
  if (body?.serverNow) updateServerClockOffset(body.serverNow);
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
  const manifestItems = getAllManifestItems(manifest);
  const state = readSyncState();
  const mediaState = state.media && typeof state.media === 'object' ? state.media : {};

  if (state.revision === manifest.revision && fs.existsSync(manifestCachePath)) {
    applyScheduledPlaylist(manifest);
    return;
  }

  for (const item of manifestItems) {
    if (!item || typeof item.url !== 'string') continue;
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

function getAllManifestItems(manifest) {
  const items = [];

  if (Array.isArray(manifest.playlist)) {
    items.push(...manifest.playlist);
  }

  if (Array.isArray(manifest.playlists)) {
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

function selectScheduledPlaylist(manifest) {
  if (!Array.isArray(manifest.schedules) || !Array.isArray(manifest.playlists)) {
    return {
      playlist: Array.isArray(manifest.playlist) ? manifest.playlist : [],
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
        activeSchedule: {
          id: lastAppliedScheduleId,
          endAt: new Date(lastAppliedScheduleEndMs).toISOString(),
          grace: true
        }
      };
    }

    return { playlist: [], activeSchedule: null };
  }

  const playlist = manifest.playlists.find((candidate) => candidate.id === active.playlistId);
  return {
    playlist: Array.isArray(playlist?.items) ? playlist.items : [],
    activeSchedule: active
  };
}

function applyScheduledPlaylist(manifest = readManifestCache()) {
  if (!manifest) return;

  const selected = selectScheduledPlaylist(manifest);
  const playlist = selected.playlist;
  const config = readConfig();
  const nextPlaylist = playlist.map(({ url, ...item }) => item);
  const currentKey = JSON.stringify(config.playlist || []);
  const nextKey = JSON.stringify(nextPlaylist);

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

  config.playlist = nextPlaylist;
  writeConfig(config);
  notifyRendererPlaylistUpdated(nextPlaylist);
  console.info(`Applied scheduled playlist with ${nextPlaylist.length} item(s).`);
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
  const manifestItems = getAllManifestItems(manifest);
  const mediaState = state.media && typeof state.media === 'object' ? state.media : {};

  for (const item of manifestItems) {
    if (!item || typeof item.url !== 'string') continue;
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

function startManifestSync() {
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
app.commandLine.appendSwitch('disable-pinch');
// Allow the renderer (loaded from file://) to re-read config.json from disk,
// so media synced by the cms-worker starts playing without a restart.
app.commandLine.appendSwitch('allow-file-access-from-files');

app.whenReady().then(() => {
  powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  registerPlayerProtocol();
  startLanServer();
  startManifestSync();
  createWindow();
  startPlayerWebSocket();
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
  if (scheduleEvalTimer) {
    clearInterval(scheduleEvalTimer);
    scheduleEvalTimer = undefined;
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
