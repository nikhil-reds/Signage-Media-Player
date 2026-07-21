# SignLink Digital Signage Player

SignLink is a planned commercial-grade digital signage player inspired by the reliability and offline-first operation of products such as BrightSign. The goal is to run scheduled media continuously on dedicated display hardware, keep working when the network is unavailable, and be manageable from a remote content-management service.

> This is an independent project and is not affiliated with or endorsed by BrightSign.

## Current Status

This repository contains the working desktop/Electron player plus BrightSign
packaging files. The current live flow is:

```text
CMS schedule / playlist
        |
        v
cms-worker renders playlist MP4
        |
        v
S3 + CloudFront manifest
        |
        v
Electron player pulls manifest
        |
        v
downloads MP4s locally
        |
        v
updates local config.json
        |
        v
renderer plays active playlist
```

The player has two playback paths:

- **Manifest pull mode:** the normal scheduled playback path. The player polls a
  published manifest, downloads media, applies the active schedule, and plays the
  selected playlist.
- **Local fallback mode:** if no manifest is configured, or manifest sync fails,
  the player keeps using the last valid local `config.json`. The bundled default
  video exists so the screen is never blank.

The player does not yet implement device registration, heartbeat, proof-of-play,
remote diagnostics, signed updates, or production release automation.

## Important Files

```text
electron/main.cjs     Electron main process, LAN API, manifest sync, runtime storage
app.js                Browser playback engine that renders the current playlist
index.html            Fullscreen player shell
styles.css            Fullscreen media styling
config.json           Bundled/default player config
media/videos/         Bundled fallback media in development
autorun.brs           BrightSign launcher
scripts/              Build and validation helpers
```

## Runtime Storage

Development mode and packaged mode use different writable locations.

In development:

```text
/Users/nikhil/Desktop/player/
├── config.json
├── sync-state.json
├── manifest-cache.json
└── media/
```

In packaged Electron builds, such as Linux AppImage, the app cannot write inside
`resources/app.asar`. Runtime files are stored in Electron's writable user-data
folder instead.

On Linux AppImage this is usually:

```text
~/.config/signlink-digital-signage-player/
├── config.json
├── sync-state.json
├── manifest-cache.json
└── media/videos/
```

This avoids errors such as:

```text
ENOTDIR: not a directory, mkdir '/tmp/.mount_.../resources/app.asar/media/videos'
```

The renderer loads runtime `config.json` and `media/*` through the internal
`signlink://` protocol, so packaged playback can use files downloaded into the
writable user-data folder.

## Configuration

The bundled `config.json` can enable manifest sync directly:

```json
{
  "deviceId": "SL-PLAYER-001",
  "manifestUrl": "https://d1zue4w6hf1jx0.cloudfront.net/manifests/SL-PLAYER-001.json",
  "cdnUrl": "https://d1zue4w6hf1jx0.cloudfront.net",
  "syncIntervalMs": 30000,
  "refreshIntervalMs": 15000,
  "playlist": [
    {
      "id": "fallback",
      "type": "video",
      "src": "media/videos/default-video.mp4",
      "default": true,
      "loop": true,
      "muted": true
    }
  ]
}
```

Environment variables override `config.json`:

```bash
PLAYER_MANIFEST_URL=https://d1zue4w6hf1jx0.cloudfront.net/manifests/SL-PLAYER-001.json
PLAYER_CDN_URL=https://d1zue4w6hf1jx0.cloudfront.net
PLAYER_SYNC_INTERVAL_MS=30000
PLAYER_LAN_PORT=3030
PLAYER_LAN_TOKEN=change-me
```

## Manifest Sync

The player polls the manifest URL every `syncIntervalMs`.

Manifest shape:

```json
{
  "schemaVersion": 1,
  "deviceId": "SL-PLAYER-001",
  "revision": "2026-07-21T06:30:00.000Z",
  "playlist": [
    {
      "id": "playlist-id",
      "type": "video",
      "src": "media/videos/playlist-id.mp4",
      "url": "https://d1zue4w6hf1jx0.cloudfront.net/playlists/playlist-id.mp4",
      "loop": true,
      "muted": false
    }
  ],
  "playlists": [
    {
      "id": "playlist-id",
      "items": []
    }
  ],
  "schedules": [
    {
      "id": "schedule-id",
      "name": "Lunch Menu",
      "playlistId": "playlist-id",
      "priority": 100,
      "startAt": "2026-07-21T06:25:00.000Z",
      "endAt": "2026-07-21T11:30:00.000Z",
      "daysOfWeek": [1, 2, 3, 4, 5, 6, 7]
    }
  ]
}
```

Sync behavior:

1. Fetch manifest with `cache: no-store`.
2. Collect all media from `playlist` and `playlists[*].items`.
3. Download each media file into local `media/`.
4. Store downloaded URL metadata in `sync-state.json`.
5. Skip re-downloads when the same URL is already cached locally.
6. Pick the active schedule by time, day, and priority.
7. Write the selected playlist into local `config.json`.
8. The renderer re-reads `config.json` and starts playback.

If sync fails, the player keeps the last working local config and retries on the
next interval.

## Playback Engine

`app.js` runs inside the renderer. It:

- reads `config.json` on startup,
- re-reads it every `refreshIntervalMs`,
- plays videos/audio with HTML media elements,
- displays images for `durationMs`,
- advances through multi-item playlists,
- loops single-item playlists,
- skips broken files,
- falls back to `media/videos/default-video.mp4` if every configured item fails.

## LAN API

The Electron main process also starts a small local API on
`http://0.0.0.0:3030` by default.

Endpoints:

```text
GET  /health
POST /api/media/:folder/:fileName
POST /api/playlist/add
POST /api/playlist/replace
POST /api/playlist/remove
```

Run with optional token protection:

```bash
PLAYER_LAN_TOKEN="change-me" npm start
```

The worker can push to this API by setting:

```env
PLAYER_API_URL=http://192.168.1.25:3030
PLAYER_API_TOKEN=change-me
```

For scheduled production-style playback, manifest pull mode is preferred over
LAN push mode.

## Run Locally

Install dependencies once:

```bash
npm install
```

Start the player:

```bash
npm start
```

With the current `config.json`, plain `npm start` enables manifest sync. You can
still override the manifest at runtime:

```bash
PLAYER_MANIFEST_URL=https://d1zue4w6hf1jx0.cloudfront.net/manifests/SL-PLAYER-001.json \
PLAYER_CDN_URL=https://d1zue4w6hf1jx0.cloudfront.net \
PLAYER_SYNC_INTERVAL_MS=30000 \
npm start
```

Expected successful startup logs:

```text
Player manifest sync enabled: https://...
Player LAN API listening on http://0.0.0.0:3030
Downloading manifest media https://... -> media/videos/playlist-id.mp4
Applied scheduled playlist with 1 item(s).
Synced manifest revision 2026-07-21T06:30:00.000Z
```

## Build Commands

Run one of the target commands:

```bash
# Windows x64 — creates an NSIS .exe installer
npm run build:windows

# BrightSign — creates an SD-card folder and ZIP package
npm run build:brightsign

# Linux x64 — creates an AppImage
npm run build:linux

# macOS — creates a universal Intel/Apple Silicon DMG
npm run build:mac
```

Artifacts are separated by platform:

```text
output/
├── windows/              # SignLink Player Windows installer (.exe)
├── brightsign/           # all BrightSign output stays in this folder
│   ├── autorun.brs       # SD-card startup script
│   ├── media/            # SD-card media files
│   └── SignLink-BrightSign-1.0.0.zip
├── linux/                # Linux AppImage
└── macos/                # universal macOS DMG
```

BrightSign does not run Windows `.exe` files. Extract `output/brightsign/SignLink-BrightSign-1.0.0.zip` directly to the root of a supported SD card. Alternatively, copy `autorun.brs` and `media/` from `output/brightsign` to the card root. Do not place the enclosing `brightsign` directory on the card.

The BrightSign build validates the BrightScript syntax, required paths, JSON configuration, MP4 container header, H.264 video marker, and ZIP integrity. The current BrightSign launcher uses native `roVideoPlayer` playback and does not require Chromium or the desktop application files.

Default BrightSign playback is deliberately offline-only. The build fails if the launcher introduces an HTTP URL, `roUrlTransfer`, or `roNetworkConfiguration`. If the device displays a network setup/recovery screen instead of the video, configure that device for **No Networking / Standalone** mode and confirm that `autorun.brs` is directly at the SD-card root.

### Build-host requirements

- Build macOS packages on macOS. Apple code signing and notarization require an Apple Developer identity.
- Build Windows packages on Windows, or use a supported Wine/Docker build environment. Public releases should be Authenticode-signed.
- Build Linux packages on Linux, or use the electron-builder Docker image from macOS/Windows.
- Build the BrightSign ZIP on any system with Node.js. Test the extracted package on every supported BrightSign model and OS version.
- The current desktop packages are unsigned development artifacts. Signing, notarization, release credentials, and CI builds must be added before commercial distribution.

Electron-builder does not guarantee that every platform can be built reliably from one host. For repeatable releases, use a CI matrix with native Windows, Linux, and macOS runners, plus a separate BrightSign packaging job.

## Troubleshooting

### `cd: reds-player-arm64.AppImage: Not a directory`

An AppImage is an executable file, not a folder. Run it like this:

```bash
chmod +x "reds-player-arm64.AppImage"
./"reds-player-arm64.AppImage"
```

### `ENOTDIR ... resources/app.asar/media/videos`

This means an older packaged build tried to write downloaded media inside
`app.asar`. Rebuild the AppImage from the current code. Current builds write
runtime media to Electron `userData`, for example:

```text
~/.config/signlink-digital-signage-player/media/videos/
```

### Player Still Shows Default Video

Check these in order:

1. The player logs should include `Player manifest sync enabled`.
2. The manifest URL should be present in `config.json` or `PLAYER_MANIFEST_URL`.
3. The manifest should contain a non-empty `playlist` or an active schedule.
4. The listed media file should download into local `media/videos/`.
5. Local `config.json` should update from the fallback item to the scheduled item.

If manifest sync fails, the player intentionally keeps the previous local config
instead of switching to broken content.

### GPU / VAAPI Warnings On Linux

Messages such as these are usually hardware-acceleration warnings and are not
the manifest-sync failure:

```text
Xlib: extension "DRI2" missing
libva error
vaInitialize failed
```

The important failure to fix is any download, filesystem, or media decode error
that follows those warnings.

### Packaging release plan

1. **Development packages:** generate unsigned artifacts with the four commands above. This step is implemented.
2. **Branding:** replace the default Electron icon with validated `.ico`, `.icns`, and Linux PNG icon sets; add publisher metadata.
3. **Native testing:** install and run each artifact on clean Windows, Linux, and macOS machines and deploy the SD-card folder to the selected BrightSign models.
4. **Signing:** add a Windows code-signing certificate and Apple Developer ID/notarization credentials. Keep all credentials in CI secrets, never in the repository.
5. **Release automation:** build with native CI runners, retain checksums and build logs, and publish versioned artifacts only after tests pass.
6. **Update and rollback:** add signed update manifests, release channels, and a tested rollback path before commercial rollout.

## Product goals

The first production release should:

1. Start automatically after boot or power loss.
2. Register the device securely with a management service.
3. Download, validate, and activate published playlist revisions atomically.
4. Play images, video, audio, HTML, and approved web content.
5. Select content using date, time, day, priority, and timezone rules.
6. Continue playing the last valid schedule without a network connection.
7. Report heartbeat, playback proof, errors, storage, and software version.
8. Recover from renderer crashes, corrupt content, and interrupted downloads.
9. Support remote diagnostics and safe, signed software updates.

## Proposed architecture

The production codebase will use a feature-first structure. UI components should not contain sync, storage, scheduling, or analytics logic.

```text
SignLink Player
├── Boot and device identity
├── Device registration
├── Configuration and playlist sync
├── Download queue and media cache
├── Schedule engine
├── Playlist engine
├── Media renderers
├── Playback proof and diagnostics
├── Heartbeat and command channel
└── BrightSign launcher and watchdog
```

Recommended application stack:

| Area | Proposed choice |
| --- | --- |
| Application | React + TypeScript + Vite |
| State | Zustand |
| Server state | TanStack Query |
| Validation | Zod |
| Local metadata | IndexedDB |
| Media storage | BrightSign filesystem/SD storage |
| Playback | Native HTML media elements with type-specific renderers |
| Device integration | BrightScript launcher and BrightSign JavaScript APIs |
| Testing | Vitest, Testing Library, and hardware smoke tests |

Before adopting library versions, confirm that their generated JavaScript and browser APIs are compatible with the Chromium runtime on every supported BrightSign model and OS version.

## Target repository layout

```text
public/
├── config/
├── assets/
└── fallback-media/
src/
├── app/                  # startup, routing, and providers
├── components/           # reusable presentation components
├── features/
│   ├── device/           # identity, registration, and provisioning
│   ├── playlist/         # playlist state and playback engine
│   ├── scheduler/        # schedule evaluation
│   ├── media/            # image, video, audio, HTML, and web renderers
│   ├── cache/            # media index, quotas, and cleanup
│   ├── download/         # resumable downloads and verification
│   ├── sync/             # manifest/config synchronization
│   ├── analytics/        # proof-of-play event queue
│   ├── heartbeat/        # device health reporting
│   ├── commands/         # remote command channel
│   ├── settings/         # local and remote player settings
│   └── diagnostics/      # logs, health, and service information
├── services/             # API, storage, filesystem, network, and logging adapters
├── store/                # cross-feature runtime state
├── types/                # shared domain contracts
└── styles/
brightsign/
├── autorun.brs
├── launch.brs
├── watchdog.brs
├── network.brs
└── storage.brs
scripts/
├── package-player.ts
├── deploy.ts
└── validate.ts
tests/
├── unit/
├── integration/
└── hardware/
```

## Runtime flow

1. The BrightScript launcher starts the fullscreen player and watchdog.
2. The player loads device identity and the last known-good local manifest.
3. If provisioned and online, it authenticates and requests the latest published revision.
4. New media downloads to a staging area and is checked for size, checksum, and supported format.
5. The player activates the new revision only after all required assets are valid.
6. The scheduler selects the active playlist using the device timezone and priority rules.
7. The playlist engine delegates each item to its media renderer.
8. Heartbeats, proof-of-play records, and errors enter a durable local queue.
9. Queued events upload when connectivity returns; playback never waits for telemetry.

## Configuration contract

Configuration should be versioned and validated before use. A future manifest may follow this shape:

```json
{
  "schemaVersion": 1,
  "revision": "2026-07-13T10:00:00Z",
  "device": {
    "id": "SL-PLAYER-001",
    "timezone": "Asia/Kolkata"
  },
  "settings": {
    "volume": 80,
    "orientation": "landscape",
    "heartbeatSeconds": 60
  },
  "playlists": [
    {
      "id": "lobby-default",
      "items": [
        {
          "id": "welcome",
          "type": "image",
          "source": "media/images/welcome.png",
          "durationSeconds": 10,
          "sha256": "<asset-checksum>"
        }
      ]
    }
  ],
  "schedules": [
    {
      "playlistId": "lobby-default",
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "start": "08:00",
      "end": "20:00",
      "priority": 10
    }
  ]
}
```

The final contract must define defaults, maximum durations, allowed URL schemes, supported codecs, timezone behavior, schedule conflict resolution, and migration rules.

## Delivery plan

### Phase 0 — Define the supported platform

- Select BrightSign models, BrightSign OS versions, resolutions, orientations, and required codecs.
- Decide whether the product is BrightSign-only or will also target Windows/Linux/Android players.
- Document security, availability, retention, and fleet-size requirements.
- Define the player-to-CMS API and versioned manifest contract.

**Exit criteria:** a compatibility matrix and reviewed API/manifest specification exist.

### Phase 1 — Stabilize the local player

- Move the prototype to TypeScript and split media types into renderers.
- Add schema validation and a bundled fallback configuration.
- Correct pause/resume timing and handle media load, decode, and timeout errors.
- Add deterministic playlist transitions, optional looping, volume, fit modes, and fallback media.
- Add unit tests for playlist order, duration, skip, and error behavior.

**Exit criteria:** a local playlist loops for 72 hours on target hardware without manual recovery.

### Phase 2 — Scheduling and offline cache

- Build a timezone-aware schedule engine with priority and fallback rules.
- Add a persistent cache index, disk quota policy, and least-recently-used cleanup.
- Implement staged/resumable downloads, checksums, retries with backoff, and atomic revision activation.
- Guarantee startup from the last known-good revision without network access.

**Exit criteria:** interrupted updates never replace playable content, and the player survives seven offline days.

### Phase 3 — Provisioning and remote synchronization

- Add one-time device pairing and secure device credentials.
- Sync only published revisions and reject incompatible schema versions.
- Support configurable polling plus a command channel for refresh, restart, screenshot, and diagnostics.
- Define credential rotation and device decommissioning.

**Exit criteria:** a newly installed device can be paired, assigned content, updated, and revoked remotely.

### Phase 4 — Observability and recovery

- Send heartbeat data for player version, current item, connectivity, temperature where available, RAM, and disk.
- Persist proof-of-play and error events locally until acknowledged by the server.
- Add structured, rotating logs and a diagnostic bundle.
- Add BrightScript and application watchdogs with crash-loop protection.

**Exit criteria:** operators can distinguish offline, stale, unhealthy, and healthy devices and diagnose common failures remotely.

### Phase 5 — Security and production release

- Restrict web content, origins, filesystem access, and remote commands using least privilege.
- Verify signed manifests and update packages; protect secrets at rest.
- Add dependency, license, and vulnerability checks to CI.
- Produce versioned, reproducible SD-card packages with rollback instructions.
- Run soak, power-loss, low-disk, corrupt-file, clock-change, and network-failure tests on hardware.

**Exit criteria:** release checklist, threat model, rollback procedure, and signed production package are approved.

## Testing strategy

- **Unit:** manifest validation, schedule conflicts, playlist state, retry policy, and cache eviction.
- **Integration:** sync-to-download-to-activation, offline event queue, renderer failure, and recovery.
- **Hardware:** cold boot, power interruption, HDMI reconnect, resolution changes, weak network, full disk, and long-duration playback.
- **Soak:** continuous mixed image/video playback with periodic content changes for at least 72 hours before an initial pilot.

Track measurable targets for boot-to-content time, update success rate, frame/playback failures, crash-free hours, heartbeat freshness, and proof-of-play delivery latency.

## Immediate next steps

1. Confirm the first target BrightSign model and OS version.
2. Write JSON Schemas for player configuration and published manifests.
3. Refactor the prototype into playlist, renderer, scheduler, and storage modules.
4. Create a local test harness that can simulate offline mode, corrupt media, and schedule changes.
5. Define the minimum CMS endpoints for pairing, manifest sync, heartbeat, and event upload.

## Decisions still required

- Supported hardware and non-BrightSign platforms
- Required media formats, codecs, resolutions, and multi-zone layouts
- CMS ownership and API authentication method
- Polling versus persistent command connection
- Screenshot and remote-control privacy policy
- Proof-of-play retention and analytics requirements
- Update signing, release channels, and rollback policy
- Fleet size, bandwidth constraints, and storage quota

## Definition of the first pilot

The first pilot is ready when 5–10 target devices can be provisioned remotely, receive a scheduled playlist, validate and cache its assets, play for seven days through connectivity interruptions, report health and proof-of-play, recover after power loss, and roll back safely from a failed update.
