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
      loop: true
    };
    this.playlist = [];
    this.playlistKey = '';
    this.index = 0;
    this.failedSources = new Set();
    this.currentElement = null;
    this.advanceTimer = null;
    this.retryTimer = null;
    this.refreshTimer = null;
    this.refreshIntervalMs = 15000;
  }

  async start() {
    const config = await this.loadConfig();
    this.applyConfig(config, { restart: true });
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
    return {
      refreshIntervalMs: this.refreshIntervalMs,
      playlist: [this.defaultItem]
    };
  }

  applyConfig(config, { restart = false } = {}) {
    if (Number.isFinite(config.refreshIntervalMs) && config.refreshIntervalMs >= 2000) {
      this.refreshIntervalMs = config.refreshIntervalMs;
    }

    let playlist = (Array.isArray(config.playlist) ? config.playlist : [])
      .filter((item) => item && typeof item.src === 'string');

    if (playlist.length === 0) {
      playlist = [this.defaultItem];
    }

    const key = JSON.stringify(playlist.map((item) => [item.src, item.type, item.durationMs]));
    const changed = key !== this.playlistKey;

    if (!changed && !restart) return;

    this.playlistKey = key;
    this.playlist = playlist;
    this.failedSources.clear();

    if (restart || this.index >= this.playlist.length) {
      this.index = 0;
    }

    console.info(`Playlist updated: ${this.playlist.length} item(s).`);
    this.playCurrent();
  }

  watchConfig() {
    clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(async () => {
      const config = await this.loadConfig();
      this.applyConfig(config); // only re-renders when the playlist changed
    }, this.refreshIntervalMs);
  }

  // ---------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------

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

  next() {
    if (this.playlist.length === 0) return;
    this.index = (this.index + 1) % this.playlist.length;
    this.playCurrent();
  }

  handleMediaError(item) {
    console.warn(`Failed to load ${item.src}; skipping to next item.`);
    this.failedSources.add(item.src);

    if (this.failedSources.size >= this.playlist.length) {
      const fallbackKey = JSON.stringify([[this.defaultItem.src, this.defaultItem.type, this.defaultItem.durationMs]]);
      if (this.playlistKey !== fallbackKey) {
        console.warn('No configured media could be loaded; playing default video.');
        this.applyConfig({ playlist: [this.defaultItem] }, { restart: true });
        return;
      }
    }

    this.retryTimer = setTimeout(() => this.next(), 2000);
  }

  mountVideo(item) {
    this.viewport.replaceChildren();

    const video = document.createElement('video');
    video.className = 'media-element';
    video.src = item.src;
    video.autoplay = true;
    video.muted = item.muted !== false;
    video.defaultMuted = video.muted;
    video.playsInline = true;
    video.preload = 'auto';
    video.controls = false;
    video.disablePictureInPicture = true;
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('controlsList', 'nodownload nofullscreen noremoteplayback');

    // Single-item playlists loop the video itself; otherwise advance on end.
    const loopAlone = this.playlist.length === 1 && item.loop !== false;
    video.loop = loopAlone;

    if (!loopAlone) {
      video.addEventListener('ended', () => this.next());
    }

    video.addEventListener('error', () => {
      this.handleMediaError(item);
    });

    video.addEventListener('canplay', () => {
      video.play().catch(() => {
        this.retryTimer = setTimeout(() => this.playCurrent(), 2000);
      });
    });

    this.currentElement = video;
    this.viewport.appendChild(video);
    video.load();
  }

  mountImage(item) {
    this.viewport.replaceChildren();

    const img = document.createElement('img');
    img.className = 'media-element';
    img.src = item.src;
    img.alt = '';

    img.addEventListener('error', () => {
      this.handleMediaError(item);
    });

    this.currentElement = img;
    this.viewport.appendChild(img);

    const durationMs = Number.isFinite(item.durationMs) && item.durationMs > 0
      ? item.durationMs
      : 8000;
    this.advanceTimer = setTimeout(() => this.next(), durationMs);
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
