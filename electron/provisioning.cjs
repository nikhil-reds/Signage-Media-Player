const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { net } = require('electron');

const PROVISIONING_FILENAME = 'provisioning.json';
const INSTALL_ID_FILENAME = 'install-id';

/**
 * Where a downloaded provisioning.json can realistically be found. The CMS ships
 * it inside the same ZIP as the installer, so it is usually a sibling of the
 * executable or still sitting in the folder the agent unzipped into.
 */
function provisioningSearchPaths({ app, appRoot, runtimeRoot }) {
  const candidates = [];

  if (process.env.PLAYER_PROVISIONING) {
    candidates.push(process.env.PLAYER_PROVISIONING);
  }

  // Already consumed on a previous launch.
  candidates.push(path.join(runtimeRoot, PROVISIONING_FILENAME));

  // Next to the AppImage on Linux, next to the executable elsewhere.
  if (process.env.APPIMAGE) {
    candidates.push(path.join(path.dirname(process.env.APPIMAGE), PROVISIONING_FILENAME));
  }
  if (process.execPath) {
    candidates.push(path.join(path.dirname(process.execPath), PROVISIONING_FILENAME));
  }
  candidates.push(path.join(appRoot, PROVISIONING_FILENAME));

  for (const dirName of ['downloads', 'desktop']) {
    try {
      candidates.push(path.join(app.getPath(dirName), PROVISIONING_FILENAME));
    } catch {
      // Some minimal Linux images do not define these paths.
    }
  }

  return candidates;
}

function readProvisioningFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || !parsed.registrationId || !parsed.installToken) return null;
    return parsed;
  } catch (error) {
    console.warn(`Ignoring unreadable provisioning file at ${filePath}:`, error.message);
    return null;
  }
}

/** Returns the first usable provisioning payload, or null when unprovisioned. */
function discoverProvisioning(context) {
  for (const candidate of provisioningSearchPaths(context)) {
    const provisioning = readProvisioningFile(candidate);
    if (provisioning) {
      console.info(`Using player provisioning from ${candidate}`);
      return { provisioning, sourcePath: candidate };
    }
  }
  return null;
}

/**
 * Copies the provisioning payload into the runtime dir so later launches keep
 * working after the agent deletes the unzipped folder.
 */
function persistProvisioning(runtimeRoot, provisioning) {
  const target = path.join(runtimeRoot, PROVISIONING_FILENAME);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(provisioning, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

/** Stable per-machine id; survives reinstalls because it lives in the runtime dir. */
function ensureInstallId(runtimeRoot) {
  const installIdPath = path.join(runtimeRoot, INSTALL_ID_FILENAME);
  try {
    const existing = fs.readFileSync(installIdPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // Falls through to generation below.
  }

  const installId = crypto.randomUUID();
  fs.writeFileSync(installIdPath, installId, 'utf8');
  return installId;
}

function primaryMacAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry.internal && entry.mac && entry.mac !== '00:00:00:00:00:00') {
        return entry.mac.toUpperCase();
      }
    }
  }
  return null;
}

function collectMachineInfo({ app, screen }) {
  let screenResolution = null;
  let displayCount = null;

  try {
    const displays = screen.getAllDisplays();
    displayCount = displays.length;
    const primary = screen.getPrimaryDisplay();
    if (primary?.size) {
      // size is in DIPs; scale back up so the CMS records real pixels.
      const scale = primary.scaleFactor || 1;
      const width = Math.round(primary.size.width * scale);
      const height = Math.round(primary.size.height * scale);
      screenResolution = `${width}x${height}`;
    }
  } catch (error) {
    console.warn('Could not read display info:', error.message);
  }

  let timezone = null;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    timezone = null;
  }

  return {
    hostname: os.hostname(),
    osVersion: `${os.type()} ${os.release()}`,
    appVersion: app.getVersion(),
    arch: process.arch,
    screenResolution,
    displayCount,
    timezone,
    macAddress: primaryMacAddress(),
    appInstallPath: process.execPath
  };
}

async function postJson(url, payload, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Electron's network layer honours the device's proxy and certificate
    // configuration. Node's built-in fetch can fail on managed Linux devices
    // even while a browser on the same device reaches the CMS.
    const request = typeof net?.fetch === 'function' ? net.fetch.bind(net) : globalThis.fetch;
    const response = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body?.message || body?.error || `Request failed (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return body;
  } catch (error) {
    const cause = error && typeof error === 'object' ? error.cause : null;
    const detail = cause?.code || cause?.message || '';
    throw new Error(`CMS request failed${detail ? `: ${detail}` : `: ${error.message}`}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Registers this install with the CMS and returns the device identity the CMS
 * assigned. Safe to call on every launch: the endpoint is idempotent per
 * installId, which also refreshes reported machine info.
 */
async function registerInstall({ provisioning, installId, machineInfo }) {
  const endpoint =
    provisioning.installEndpoint ||
    `${String(provisioning.apiBaseUrl || '').replace(/\/$/, '')}/api/player-registrations/install`;

  const response = await postJson(endpoint, {
    registrationId: provisioning.registrationId,
    installToken: provisioning.installToken,
    installId,
    ...machineInfo
  });

  return response?.data || null;
}

/**
 * Recovery path: exchanges an agent-typed pairing code for the same
 * provisioning payload the download ZIP would have carried.
 */
async function exchangePairingCode(apiBaseUrl, pairingCode) {
  const base = String(apiBaseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('Enter the CMS address.');

  const response = await postJson(`${base}/api/player-registrations/pair`, { pairingCode });
  const provisioning = response?.data;
  if (!provisioning?.registrationId || !provisioning?.installToken) {
    throw new Error('The CMS did not return valid pairing details.');
  }

  return { ...provisioning, apiBaseUrl: provisioning.apiBaseUrl || base };
}

function heartbeatEndpointFor(provisioning) {
  return (
    provisioning.heartbeatEndpoint ||
    `${String(provisioning.apiBaseUrl || '').replace(/\/$/, '')}/api/devices/heartbeat`
  );
}

async function sendHeartbeat({ provisioning, deviceId, deviceToken, machineInfo }) {
  return postJson(heartbeatEndpointFor(provisioning), {
    deviceId,
    deviceToken,
    ...machineInfo
  });
}

module.exports = {
  PROVISIONING_FILENAME,
  collectMachineInfo,
  exchangePairingCode,
  discoverProvisioning,
  ensureInstallId,
  persistProvisioning,
  registerInstall,
  sendHeartbeat
};
