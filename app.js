// SignLink unattended digital-signage player.
//
// Plays every item in config.json's `playlist` in a loop (videos play to the
// end, images show for `durationMs`). The config is re-read on an interval so
// media synced in by the cms-worker starts playing automatically — no restart.
class SignagePlayer {
  constructor(viewport, stage) {
    this.viewport = viewport;
    this.stage = stage;
    this.renderSize = { width: 1920, height: 1080 };
    this.defaultItem = {
      id: 'fallback',
      type: 'video',
      src: 'media/videos/default-video.mp4',
      default: true,
      muted: true,
      loop: true,
      fit: 'scale-down',
      position: 'center'
    };
    this.playlist = [];
    this.playlistKey = '';
    this.playbackMode = 'default';
    this.index = 0;
    this.failedSources = new Set();
    this.currentElement = null;
    this.pendingElement = null;
    this.advanceTimer = null;
    this.retryTimer = null;
    this.refreshTimer = null;
    this.refreshIntervalMs = 1000;
    this.resizeObserver = null;
  }

  async start() {
    const config = await this.loadConfig();
    this.applyConfig(config, { restart: true });
    this.listenForViewportChanges();
    this.listenForRuntimeUpdates();
    this.watchConfig();
  }

  // ---------------------------------------------------------------------
  // Config loading (file:// friendly: XHR first, fetch fallback)
  // ---------------------------------------------------------------------

  loadConfig() {
    return new Promise((resolve) => {
      const fallback = () => resolve(this.fallbackConfig());

      try {
        const xhr = new XMLHttpRequest();
        // Cache-buster so we always read the latest file from disk.
        xhr.open('GET', `config.json?ts=${Date.now()}`, true);
        xhr.onload = () => {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (error) {
            console.warn('config.json is not valid JSON yet, retrying later.', error);
            fallback();
          }
        };
        xhr.onerror = () => {
          // Some runtimes restrict XHR on file://; try fetch before giving up.
          fetch('config.json', { cache: 'no-store' })
            .then((response) => response.json())
            .then(resolve)
            .catch(fallback);
        };
        xhr.send();
      } catch (error) {
        console.warn('Unable to read config.json, using bundled fallback.', error);
        fallback();
      }
    });
  }

  fallbackConfig() {
    if (this.playbackMode === 'scheduled' && this.playlist.length > 0) {
      const scheduledPlaylist = this.playlist.filter((item) => item.src !== this.defaultItem.src);
      if (scheduledPlaylist.length === 0) {
        return {
          refreshIntervalMs: this.refreshIntervalMs,
          playbackMode: 'default',
          playlist: [this.defaultItem]
        };
      }

      return {
        refreshIntervalMs: this.refreshIntervalMs,
        playbackMode: 'scheduled',
        playlist: scheduledPlaylist
      };
    }

    return {
      refreshIntervalMs: this.refreshIntervalMs,
      playbackMode: 'default',
      playlist: [this.defaultItem]
    };
  }

  applyConfig(config, { restart = false } = {}) {
    if (Number.isFinite(config.refreshIntervalMs) && config.refreshIntervalMs >= 2000) {
      this.refreshIntervalMs = config.refreshIntervalMs;
    }

    const playbackMode = config.playbackMode === 'scheduled' ? 'scheduled' : 'default';
    let playlist = (Array.isArray(config.playlist) ? config.playlist : [])
      .filter((item) => item && typeof item.src === 'string')
      .map((item) => this.normalizeItem(item, playbackMode));

    if (playlist.length === 0) {
      playlist = [this.normalizeItem(this.defaultItem, 'default')];
    }

    const renderSize = this.resolveRenderSize(config, playlist);

    const key = JSON.stringify(
      {
        playbackMode,
        renderSize,
        playlist: playlist.map((item) => [
          item.src,
          item.type,
          item.durationMs,
          item.fit,
          item.position,
          item.width,
          item.height,
          item.muted,
          item.loop
        ])
      }
    );
    const changed = key !== this.playlistKey;

    if (!changed && !restart) return;

    this.playlistKey = key;
    this.playbackMode = playbackMode;
    this.playlist = playlist;
    this.setRenderSize(renderSize);
    this.failedSources.clear();

    if (changed || restart || this.index >= this.playlist.length) {
      this.index = 0;
    }

    console.info(`Playlist updated: ${this.playbackMode}, ${this.playlist.length} item(s).`);
    this.playCurrent();
  }

  watchConfig() {
    clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(async () => {
      const config = await this.loadConfig();
      this.applyConfig(config); // only re-renders when the playlist changed
    }, this.refreshIntervalMs);
  }

  listenForRuntimeUpdates() {
    if (!window.signlinkPlayer?.onPlaylistUpdated) return;

    window.signlinkPlayer.onPlaylistUpdated((update) => {
      if (Array.isArray(update)) {
        this.applyConfig({ playbackMode: update.length > 0 ? 'scheduled' : 'default', playlist: update }, { restart: true });
        return;
      }

      this.applyConfig(update);
    });
  }

  // ---------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------

  normalizeItem(item, playbackMode = 'default') {
    const fit = ['cover', 'contain', 'fill', 'none', 'scale-down'].includes(item.fit)
      ? item.fit
      : 'scale-down';
    const position = ['center', 'top', 'bottom', 'left', 'right'].includes(item.position)
      ? item.position
      : 'center';

    return {
      ...item,
      fit,
      position,
      playbackMode,
      muted: item.muted !== false
    };
  }

  resolveRenderSize(config, playlist) {
    const candidates = [
      config?.playlistResolution,
      config?.renderResolution,
      this.readNamedSize(config),
      playlist.find((item) => Number.isFinite(Number(item.width)) && Number.isFinite(Number(item.height)))
    ];

    for (const candidate of candidates) {
      const size = this.readSize(candidate);
      if (size) return size;
    }

    console.warn('Playlist resolution is missing; preserving the previous internal render size.');
    return this.renderSize;
  }

  readNamedSize(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;

    const width = Number(candidate.renderWidth ?? candidate.playlistWidth);
    const height = Number(candidate.renderHeight ?? candidate.playlistHeight);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }

    return { width, height };
  }

  readSize(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;

    const width = Number(candidate.width ?? candidate.w ?? candidate.renderWidth ?? candidate.playlistWidth);
    const height = Number(candidate.height ?? candidate.h ?? candidate.renderHeight ?? candidate.playlistHeight);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }

    return { width, height };
  }

  setRenderSize(size) {
    this.renderSize = size;
    this.stage.dataset.renderWidth = String(size.width);
    this.stage.dataset.renderHeight = String(size.height);
    this.stage.style.setProperty('--playlist-width', `${size.width}px`);
    this.stage.style.setProperty('--playlist-height', `${size.height}px`);
    this.scaleStageToViewport();
    console.info(`Internal playlist canvas: ${size.width}x${size.height}.`);
  }

  listenForViewportChanges() {
    window.addEventListener('resize', () => this.scaleStageToViewport());

    if (!window.ResizeObserver) {
      this.scaleStageToViewport();
      return;
    }

    this.resizeObserver = new ResizeObserver(() => this.scaleStageToViewport());
    this.resizeObserver.observe(this.viewport);
  }

  scaleStageToViewport() {
    const viewportWidth = this.viewport.clientWidth;
    const viewportHeight = this.viewport.clientHeight;
    const { width, height } = this.renderSize;

    if (viewportWidth <= 0 || viewportHeight <= 0 || width <= 0 || height <= 0) return;

    const scale = Math.min(viewportWidth / width, viewportHeight / height);
    this.stage.style.setProperty('--playlist-scale', String(scale));
  }

  applyLayout(element, item) {
    element.style.objectFit = item.fit || 'scale-down';
    element.style.objectPosition = item.position || 'center';

    const x = Number(item.x ?? item.left);
    const y = Number(item.y ?? item.top);
    const width = Number(item.width);
    const height = Number(item.height);
    const hasPosition = Number.isFinite(x) || Number.isFinite(y);
    const hasSize = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;

    element.style.inset = '';
    element.style.left = hasPosition && Number.isFinite(x) ? `${x}px` : '0';
    element.style.top = hasPosition && Number.isFinite(y) ? `${y}px` : '0';

    if (hasPosition || (hasSize && (width !== this.renderSize.width || height !== this.renderSize.height))) {
      element.style.width = hasSize ? `${width}px` : '100%';
      element.style.height = hasSize ? `${height}px` : '100%';
      return;
    }

    element.style.width = '100%';
    element.style.height = '100%';
  }

  playCurrent() {
    clearTimeout(this.advanceTimer);
    clearTimeout(this.retryTimer);

    const item = this.playlist[this.index];
    if (!item) {
      this.index = 0;
      return;
    }

    if (item.type === 'image') {
      this.mountImage(item);
    } else {
      this.mountVideo(item); // video and audio both use a media element
    }
  }

  swapToReadyElement(element) {
    if (this.currentElement && this.currentElement !== element) {
      this.currentElement.remove();
    }

    if (!element.isConnected) {
      this.stage.appendChild(element);
    }

    element.classList.remove('media-element--pending');
    this.currentElement = element;
    this.pendingElement = null;
  }

  next() {
    if (this.playlist.length === 0) return;
    this.index = (this.index + 1) % this.playlist.length;
    this.playCurrent();
  }

  handleMediaError(item) {
    console.warn(`Failed to load ${item.src}; skipping to next item.`);
    this.failedSources.add(item.src);

    if (this.failedSources.size >= this.playlist.length) {
      console.warn('No configured media could be loaded; playing default video.');
      this.applyConfig({ playbackMode: 'default', playlist: [this.defaultItem] }, { restart: true });
      return;
    }

    this.retryTimer = setTimeout(() => this.next(), 2000);
  }

  mountVideo(item) {
    if (this.pendingElement) {
      this.pendingElement.remove();
      this.pendingElement = null;
    }

    const video = document.createElement('video');
    video.className = 'media-element media-element--pending';
    this.applyLayout(video, item);
    video.autoplay = true;
    video.muted = item.muted;
    video.defaultMuted = video.muted;
    video.playsInline = true;
    video.preload = 'auto';
    video.controls = false;
    video.disablePictureInPicture = true;
    video.disableRemotePlayback = true;
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('controlsList', 'nodownload nofullscreen noremoteplayback');

    const loopAlone = this.playlist.length === 1 && item.loop !== false;
    video.loop = loopAlone;

    video.addEventListener('ended', () => {
      console.info(`Video ended: ${item.src} (mode=${item.playbackMode}, loopAlone=${loopAlone})`);
      if (!loopAlone) this.next();
    });

    video.addEventListener('error', () => {
      console.warn(`Video error: ${item.src} (mode=${item.playbackMode})`);
      this.handleMediaError(item);
    });

    video.addEventListener('canplay', () => {
      video.play().then(() => {
        console.info(`Video playing: ${item.src} (mode=${item.playbackMode}, loop=${video.loop})`);
        this.swapToReadyElement(video);
      }).catch(() => {
        this.retryTimer = setTimeout(() => this.playCurrent(), 2000);
      });
    });

    this.pendingElement = video;
    this.stage.appendChild(video);
    video.src = item.src;
  }

  mountImage(item) {
    if (this.pendingElement) {
      this.pendingElement.remove();
      this.pendingElement = null;
    }

    const img = document.createElement('img');
    img.className = 'media-element media-element--pending';
    img.alt = '';
    this.applyLayout(img, item);

    img.addEventListener('error', () => {
      this.handleMediaError(item);
    });

    this.stage.appendChild(img);

    const durationMs = Number.isFinite(item.durationMs) && item.durationMs > 0
      ? item.durationMs
      : 8000;
    img.addEventListener('load', () => {
      this.swapToReadyElement(img);
      this.advanceTimer = setTimeout(() => this.next(), durationMs);
    });

    img.src = item.src;
  }

  showError(message) {
    const error = document.createElement('div');
    error.className = 'player-error';
    error.textContent = message;
    this.stage.replaceChildren(error);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const viewport = document.getElementById('viewport');
  const stage = document.getElementById('playlist-stage');
  const player = new SignagePlayer(viewport, stage);
  window.playerInstance = player;
  player.start();
});
