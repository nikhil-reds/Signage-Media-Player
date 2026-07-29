// SignLink unattended digital-signage player.
//
// Plays every item in config.json's `playlist` in a loop (videos play to the
// end, images show for `durationMs`). The config is re-read on an interval so
// media synced in by the cms-worker starts playing automatically — no restart.
class SignagePlayer {
  constructor(viewport) {
    this.viewport = viewport;
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
  }

  async start() {
    const config = await this.loadConfig();
    this.applyConfig(config, { restart: true });
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

    const key = JSON.stringify(
      {
        playbackMode,
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
    this.failedSources.clear();

    if (restart || this.index >= this.playlist.length) {
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

      this.applyConfig(update, { restart: true });
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

  applyLayout(element, item) {
    element.style.objectFit = item.fit || 'scale-down';
    element.style.objectPosition = item.position || 'center';
    if (Number.isFinite(item.width) && item.width > 0 && Number.isFinite(item.height) && item.height > 0) {
      const ratio = item.width / item.height;
      element.style.width = `min(100vw, calc(100vh * ${ratio}))`;
      element.style.height = `min(100vh, calc(100vw / ${ratio}))`;
    } else {
      element.style.width = '100vw';
      element.style.height = '100vh';
    }
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
      this.viewport.appendChild(element);
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
      if (this.playbackMode === 'scheduled') {
        console.warn('Scheduled media failed; retrying scheduled video instead of playing default.');
        this.retryTimer = setTimeout(() => {
          this.failedSources.clear();
          this.playCurrent();
        }, 1000);
        return;
      }

      console.warn('No configured media could be loaded; playing default video.');
      this.applyConfig({ playlist: [this.defaultItem] }, { restart: true });
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
    video.src = item.src;
    this.applyLayout(video, item);
    video.autoplay = true;
    video.muted = item.muted;
    video.defaultMuted = video.muted;
    video.playsInline = true;
    video.preload = 'auto';
    video.controls = false;
    video.disablePictureInPicture = true;
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('controlsList', 'nodownload nofullscreen noremoteplayback');

    const loopAlone = this.playlist.length === 1 && item.loop !== false;
    video.loop = loopAlone;

    video.addEventListener('ended', () => {
      console.info(`Video ended: ${item.src} (mode=${item.playbackMode}, loopAlone=${loopAlone})`);
      if (!loopAlone) {
        this.next();
        return;
      }

      video.currentTime = 0;
      video.play().catch(() => {
        this.retryTimer = setTimeout(() => this.playCurrent(), 500);
      });
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
    this.viewport.appendChild(video);
    video.load();
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

    this.viewport.appendChild(img);

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
    this.viewport.replaceChildren(error);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const viewport = document.getElementById('viewport');
  const player = new SignagePlayer(viewport);
  window.playerInstance = player;
  player.start();
});
