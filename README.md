# SignLink Digital Signage Player

SignLink is a planned commercial-grade digital signage player inspired by the reliability and offline-first operation of products such as BrightSign. The goal is to run scheduled media continuously on dedicated display hardware, keep working when the network is unavailable, and be manageable from a remote content-management service.

> This is an independent project and is not affiliated with or endorsed by BrightSign.

## Project status

The repository currently contains a proof of concept for BrightSign hardware:

- `autorun.brs` launches a fullscreen HTML widget at 1920×1080.
- `index.html`, `styles.css`, and `app.js` provide an unattended fullscreen playback surface with no visible controls.
- `config.json` defines the device and its bundled startup video.
- The bundled default video autoplays muted and loops continuously.

The prototype does **not** yet implement remote registration, scheduling, durable media caching, content verification, telemetry, watchdog recovery, or production signing and release automation. Development packaging is available for all four targets. The bundled `media/videos/default-video.mp4` is the first playlist item and starts automatically when the player launches.

## Build commands

The packaging workflow has two steps. Install the build tools once:

```bash
npm install
```

Then run one of the four target commands:

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
├── brightsign/
│   ├── sd-card/          # copy these contents to the SD-card root
│   └── SignLink-BrightSign-1.0.0.zip
├── linux/                # Linux AppImage
└── macos/                # universal macOS DMG
```

BrightSign does not run Windows `.exe` files. Extract the BrightSign ZIP and copy the contents—not the enclosing `sd-card` directory—to the root of a supported SD card. The player boots through `autorun.brs`.

### Build-host requirements

- Build macOS packages on macOS. Apple code signing and notarization require an Apple Developer identity.
- Build Windows packages on Windows, or use a supported Wine/Docker build environment. Public releases should be Authenticode-signed.
- Build Linux packages on Linux, or use the electron-builder Docker image from macOS/Windows.
- Build the BrightSign ZIP on any system with Node.js. Test the extracted package on every supported BrightSign model and OS version.
- The current desktop packages are unsigned development artifacts. Signing, notarization, release credentials, and CI builds must be added before commercial distribution.

Electron-builder does not guarantee that every platform can be built reliably from one host. For repeatable releases, use a CI matrix with native Windows, Linux, and macOS runners, plus a separate BrightSign packaging job.

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
