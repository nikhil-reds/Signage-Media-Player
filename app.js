// SignLink unattended digital-signage player.
//
// Plays every item in config.json's `playlist` in a loop (videos play to the
// end, images show for `durationMs`). The config is re-read on an interval so
// media synced in by the cms-worker starts playing automatically — no restart.
class SignagePlayer {
  constructor(viewport, stage) {
    this.viewport = viewport;
    this.stage = stage;
    this.defaultRenderSize = { width: 1920, height: 1080 };
    this.renderSize = this.defaultRenderSize;
    this.verticalAlign = 'top';
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
    this.htmlLoadTimer = null;
    this.refreshTimer = null;
    this.refreshIntervalMs = 1000;
    this.resizeObserver = null;
    this.htmlViewport = null;
    this.zones = [];
    this.multiZonePlayers = [];
    this.isMultiZone = false;
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
        playlist: scheduledPlaylist,
        zones: this.zones
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
    this.verticalAlign = config.verticalAlign === 'center' ? 'center' : 'top';

    const playbackMode = config.playbackMode === 'scheduled' ? 'scheduled' : 'default';
    let playlist = (Array.isArray(config.playlist) ? config.playlist : [])
      .filter((item) => item && typeof item.src === 'string')
      .map((item) => this.normalizeItem(item, playbackMode));

    if (playlist.length === 0) {
      playlist = [this.normalizeItem(this.defaultItem, 'default')];
    }

    const renderSize = this.resolveRenderSize(config, playlist);
    const zones = this.normalizeZones(config.zones, renderSize);
    const isMultiZone = zones.length > 1 || playlist.some((item) => item.zoneId && item.zoneId !== 'full-screen');

    const key = JSON.stringify(
      {
        playbackMode,
        renderSize,
        zones,
        playlist: playlist.map((item) => [
          item.src,
          item.type,
          item.durationMs,
          item.fit,
          item.position,
          item.width,
          item.height,
          item.muted,
          item.loop,
          item.sourceType,
          item.navigationPolicy,
          item.reloadPolicy,
          item.scrollY,
          item.htmlScrollY,
          item.zoneId,
          item.x,
          item.y
        ])
      }
    );
    const changed = key !== this.playlistKey;

    if (!changed && !restart) return;

    this.playlistKey = key;
    this.playbackMode = playbackMode;
    this.playlist = playlist;
    this.zones = zones;
    this.isMultiZone = isMultiZone;
    this.setRenderSize(renderSize);
    this.failedSources.clear();

    if (changed || restart || this.index >= this.playlist.length) {
      this.index = 0;
    }
    console.info(`Playlist updated: ${this.playbackMode}, ${this.playlist.length} item(s), multiZone=${this.isMultiZone}.`);
    if (this.isMultiZone) {
      this.startMultiZonePlayback();
    } else {
      this.stopMultiZonePlayback();
      this.playCurrent();
    }
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
      zoneId: item.zoneId || 'full-screen',
      muted: item.muted !== false,
      sourceType: item.sourceType === 'external_url' ? 'external_url' : item.sourceType === 'upload' ? 'upload' : undefined,
      navigationPolicy: ['same_origin', 'allowlist', 'allow_all'].includes(item.navigationPolicy)
        ? item.navigationPolicy
        : 'same_origin',
      reloadPolicy: ['on_each_play', 'once_per_playlist', 'interval', 'never'].includes(item.reloadPolicy)
        ? item.reloadPolicy
        : 'on_each_play',
      scrollY: Number.isFinite(Number(item.scrollY ?? item.htmlScrollY))
        ? Math.max(0, Number(item.scrollY ?? item.htmlScrollY))
        : undefined
    };
  }

  resolveRenderSize(config, playlist) {
    const candidates = [
      config?.playlistResolution,
      this.readNamedSize(config),
      this.derivePlaylistSize(playlist)
    ];

    for (const candidate of candidates) {
      const size = this.readSize(candidate);
      if (size) return size;
    }

    console.warn('Playlist canvas is missing; using the fixed 1920x1080 default canvas.');
    return this.defaultRenderSize;
  }

  derivePlaylistSize(playlist) {
    const items = playlist.filter((item) => !item.default);
    if (items.length === 0) return null;

    let width = 0;
    let height = 0;
    for (const item of items) {
      const itemWidth = Number(item.width);
      const itemHeight = Number(item.height);
      const x = Number(item.x ?? item.left ?? 0);
      const y = Number(item.y ?? item.top ?? 0);
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

  normalizeZones(rawZones, renderSize) {
    const fallback = {
      id: 'full-screen',
      name: 'Full Screen',
      x: 0,
      y: 0,
      width: renderSize.width,
      height: renderSize.height
    };

    if (!Array.isArray(rawZones) || rawZones.length === 0) return [fallback];

    const zones = rawZones
      .map((zone) => {
        const id = String(zone?.id || '').trim();
        const x = Number(zone?.x ?? zone?.left ?? 0);
        const y = Number(zone?.y ?? zone?.top ?? 0);
        const width = Number(zone?.width ?? zone?.w);
        const height = Number(zone?.height ?? zone?.h);
        if (!id || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          return null;
        }
        return {
          id,
          name: String(zone?.name || id),
          x,
          y,
          width,
          height
        };
      })
      .filter(Boolean);

    return zones.length > 0 ? zones : [fallback];
  }
  readNamedSize(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;

    const width = Number(candidate.playlistWidth);
    const height = Number(candidate.playlistHeight);

    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }

    return { width, height };
  }

  readSize(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;

    const width = Number(candidate.width ?? candidate.w ?? candidate.playlistWidth);
    const height = Number(candidate.height ?? candidate.h ?? candidate.playlistHeight);

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
    this.stage.dataset.verticalAlign = this.verticalAlign;
    this.scaleStageToViewport();
    console.info(`Internal playlist canvas: ${size.width}x${size.height}.`);
  }

  listenForViewportChanges() {
    window.addEventListener('resize', () => {
      this.scaleStageToViewport();
      this.sizeHtmlViewport();
    });

    if (!window.ResizeObserver) {
      this.scaleStageToViewport();
      return;
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.scaleStageToViewport();
      this.sizeHtmlViewport();
    });
    this.resizeObserver.observe(this.viewport);
  }

  sizeHtmlViewport() {
    if (!this.htmlViewport?.frame?.isConnected || !this.htmlViewport?.webview?.isConnected) return;

    const width = Math.round(this.viewport.clientWidth);
    const height = Math.round(this.viewport.clientHeight);
    if (width <= 0 || height <= 0) return;

    const { frame, webview } = this.htmlViewport;
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    webview.style.width = `${width}px`;
    webview.style.height = `${height}px`;
  }

  scaleStageToViewport() {
    const viewportWidth = this.viewport.clientWidth;
    const viewportHeight = this.viewport.clientHeight;
    const { width, height } = this.renderSize;

    if (viewportWidth <= 0 || viewportHeight <= 0 || width <= 0 || height <= 0) return;

    const scale = Math.min(viewportWidth / width, viewportHeight / height);
    this.stage.style.setProperty('--playlist-scale', String(scale));
  }

  applyHtmlViewportReset(webview, item) {
    if (!webview?.executeJavaScript) return;
    const scrollY = Math.max(0, Number(item.scrollY ?? item.htmlScrollY ?? 0) || 0);
    webview.executeJavaScript(`
      (() => {
        const styleId = 'signlink-html-viewport-reset';
        let style = document.getElementById(styleId);
        if (!style) {
          style = document.createElement('style');
          style.id = styleId;
          document.head.appendChild(style);
        }
        style.textContent = 'html, body { margin: 0 !important; width: 100% !important; height: 100% !important; } html, body, * { cursor: none !important; }';
        window.scrollTo(0, ${scrollY});

        // Some HTML experiences measure the viewport during hydration. A webview
        // can be attached after that initial measurement, so notify it once the
        // native player surface has its final dimensions.
        const refreshViewport = () => {
          window.dispatchEvent(new Event('resize'));
          window.dispatchEvent(new Event('orientationchange'));
        };
        requestAnimationFrame(refreshViewport);
        setTimeout(refreshViewport, 100);
        setTimeout(refreshViewport, 350);
      })();
    `).catch((error) => {
      console.warn('Unable to inject HTML viewport reset.', error);
    });
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

  stopMultiZonePlayback() {
    for (const zonePlayer of this.multiZonePlayers) {
      zonePlayer.stop();
    }
    this.multiZonePlayers = [];
    this.stage.replaceChildren();
    if (this.htmlViewport?.frame?.isConnected) {
      this.htmlViewport.frame.remove();
    }
    this.htmlViewport = null;
  }

  startMultiZonePlayback() {
    clearTimeout(this.advanceTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.htmlLoadTimer);
    this.currentElement = null;
    this.pendingElement = null;
    this.stopMultiZonePlayback();

    const zoneMap = new Map(this.zones.map((zone) => [zone.id, zone]));
    const fallbackZone = this.zones[0] || {
      id: 'full-screen',
      name: 'Full Screen',
      x: 0,
      y: 0,
      width: this.renderSize.width,
      height: this.renderSize.height
    };
    const itemsByZone = new Map();

    for (const item of this.playlist) {
      if (item.type === 'html') {
        console.warn(`Skipping HTML item in multi-zone mode: ${item.src}`);
        continue;
      }
      const zone = zoneMap.get(item.zoneId) || fallbackZone;
      if (!itemsByZone.has(zone.id)) itemsByZone.set(zone.id, []);
      itemsByZone.get(zone.id).push({
        ...item,
        zoneId: zone.id,
        x: 0,
        y: 0,
        width: zone.width,
        height: zone.height
      });
    }

    for (const zone of this.zones) {
      const items = itemsByZone.get(zone.id) || [];
      if (items.length === 0) continue;
      const zoneElement = document.createElement('div');
      zoneElement.className = 'media-zone';
      zoneElement.dataset.zoneId = zone.id;
      zoneElement.style.position = 'absolute';
      zoneElement.style.overflow = 'hidden';
      zoneElement.style.background = '#000';
      zoneElement.style.left = `${zone.x}px`;
      zoneElement.style.top = `${zone.y}px`;
      zoneElement.style.width = `${zone.width}px`;
      zoneElement.style.height = `${zone.height}px`;
      this.stage.appendChild(zoneElement);

      const zonePlayer = new ZonePlayer(this, zoneElement, zone, items);
      this.multiZonePlayers.push(zonePlayer);
      zonePlayer.play();
    }

    if (this.multiZonePlayers.length === 0) {
      console.warn('No playable zone items found; falling back to default playback.');
      this.applyConfig({ playbackMode: 'default', playlist: [this.defaultItem] }, { restart: true });
    }
  }
  playCurrent() {
    clearTimeout(this.advanceTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.htmlLoadTimer);

    const item = this.playlist[this.index];
    if (!item) {
      this.index = 0;
      return;
    }

    if (item.type === 'image') {
      this.mountImage(item);
    } else if (item.type === 'html') {
      this.mountHtml(item);
    } else {
      this.mountVideo(item); // video and audio both use a media element
    }
  }

  swapToReadyElement(element) {
    if (this.currentElement && this.currentElement !== element) {
      this.currentElement.remove();
    }

    if (!element.isConnected) {
      const host = element.classList.contains('media-html-frame--viewport')
        ? this.viewport
        : this.stage;
      host.appendChild(element);
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

  isRemoteUrl(src) {
    return typeof src === 'string' && /^https?:\/\//i.test(src);
  }

  isNavigationAllowed(item, targetUrl) {
    if (item.navigationPolicy === 'allow_all') return true;
    if (!this.isRemoteUrl(targetUrl)) return false;

    if (Array.isArray(item.navigationAllowlist) && item.navigationAllowlist.length > 0) {
      return item.navigationAllowlist.some((allowed) => targetUrl.startsWith(allowed));
    }

    try {
      return new URL(targetUrl).origin === new URL(item.src).origin;
    } catch {
      return false;
    }
  }

  createHtmlFrame(item) {
    const frame = document.createElement('div');
    frame.className = 'media-element media-html-frame media-html-frame--viewport media-element--pending';
    frame.style.overflow = 'hidden';
    frame.style.background = '#000';
    frame.style.objectFit = '';
    frame.style.objectPosition = '';
    return frame;
  }

  mountHtml(item) {
    if (this.pendingElement) {
      this.pendingElement.remove();
      this.pendingElement = null;
    }

    const durationMs = Number.isFinite(item.durationMs) && item.durationMs > 0
      ? item.durationMs
      : 20000;
    const loadTimeoutMs = Number.isFinite(item.loadTimeoutMs) && item.loadTimeoutMs > 0
      ? item.loadTimeoutMs
      : 15000;
    const isRemote = item.sourceType === 'external_url' || this.isRemoteUrl(item.src);
    const frame = this.createHtmlFrame(item);
    // A normal iframe provides external responsive sites their true layout
    // viewport. Local HTML packages retain the isolated Electron webview path.
    const html = document.createElement(isRemote ? 'iframe' : 'webview');
    html.className = 'media-html-webview';
    html.style.position = 'absolute';
    html.style.inset = '0';
    html.style.width = '100%';
    html.style.height = '100%';
    html.style.border = '0';
    html.style.background = '#000';
    if (isRemote) {
      html.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      html.setAttribute('allow', 'autoplay; fullscreen');
    } else {
      html.setAttribute('allowpopups', 'false');
      html.setAttribute('partition', `persist:signlink-html-${item.id || 'default'}`);
    }
    this.htmlViewport = { frame, webview: html };

    let ready = false;
    const complete = () => {
      if (ready) return;
      ready = true;
      clearTimeout(this.htmlLoadTimer);
      window.removeEventListener('message', readyListener);
      this.swapToReadyElement(frame);
      this.advanceTimer = setTimeout(() => this.next(), durationMs);
    };

    const readyListener = (event) => {
      if (event?.data?.type === 'PLAYER_READY') complete();
    };

    if (isRemote) {
      html.addEventListener('load', complete);
      html.addEventListener('error', () => this.handleMediaError(item));
    } else {
      html.addEventListener('dom-ready', () => {
        this.applyHtmlViewportReset(html, item);
        complete();
      });
      html.addEventListener('did-finish-load', () => {
        this.applyHtmlViewportReset(html, item);
        complete();
      });
      html.addEventListener('did-fail-load', (event) => {
        if (event.errorCode === -3) return;
        window.removeEventListener('message', readyListener);
        this.handleMediaError(item);
      });
      html.addEventListener('will-navigate', (event) => {
        if (!this.isNavigationAllowed(item, event.url)) {
          event.preventDefault();
        }
      });
      html.addEventListener('new-window', (event) => {
        event.preventDefault();
      });
    }
    window.addEventListener('message', readyListener);

    this.pendingElement = frame;
    frame.appendChild(html);
    // A webview must not live inside the playlist canvas transform. Chromium
    // otherwise reports the untransformed guest viewport to responsive pages.
    this.viewport.appendChild(frame);
    this.sizeHtmlViewport();
    requestAnimationFrame(() => this.sizeHtmlViewport());
    this.htmlLoadTimer = setTimeout(() => {
      console.warn(`HTML load timed out: ${item.src}`);
      window.removeEventListener('message', readyListener);
      if (isRemote) {
        complete();
      } else {
        this.handleMediaError(item);
      }
    }, loadTimeoutMs);
    html.src = item.src;
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
    if (!video.isConnected) this.stage.appendChild(video);
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

    if (!img.isConnected) this.stage.appendChild(img);

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

class ZonePlayer {
  constructor(player, host, zone, items) {
    this.player = player;
    this.host = host;
    this.zone = zone;
    this.items = items;
    this.index = 0;
    this.timer = null;
    this.currentElement = null;
    this.failedSources = new Set();
  }

  stop() {
    clearTimeout(this.timer);
    this.host.remove();
  }

  play() {
    clearTimeout(this.timer);
    const item = this.items[this.index];
    if (!item) return;
    if (item.type === 'image') {
      this.mountImage(item);
    } else {
      this.mountVideo(item);
    }
  }

  next() {
    if (this.items.length === 0) return;
    this.index = (this.index + 1) % this.items.length;
    this.play();
  }

  swap(element) {
    if (this.currentElement && this.currentElement !== element) {
      this.currentElement.remove();
    }
    element.classList.remove('media-element--pending');
    this.currentElement = element;
  }

  handleError(item) {
    console.warn(`Zone ${this.zone.id} failed to load ${item.src}; skipping.`);
    this.failedSources.add(item.src);
    if (this.failedSources.size >= this.items.length) {
      this.host.replaceChildren();
      return;
    }
    this.timer = setTimeout(() => this.next(), 2000);
  }

  mountVideo(item) {
    const video = document.createElement('video');
    video.className = 'media-element media-element--pending';
    this.player.applyLayout(video, item);
    video.autoplay = true;
    video.muted = item.muted !== false;
    video.defaultMuted = video.muted;
    video.playsInline = true;
    video.preload = 'auto';
    video.controls = false;
    video.disablePictureInPicture = true;
    video.disableRemotePlayback = true;
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('controlsList', 'nodownload nofullscreen noremoteplayback');
    video.loop = this.items.length === 1 && item.loop !== false;
    video.addEventListener('ended', () => {
      if (!video.loop) this.next();
    });
    video.addEventListener('error', () => this.handleError(item));
    video.addEventListener('canplay', () => {
      video.play().then(() => this.swap(video)).catch(() => {
        this.timer = setTimeout(() => this.play(), 2000);
      });
    });
    this.host.appendChild(video);
    video.src = item.src;
  }

  mountImage(item) {
    const img = document.createElement('img');
    img.className = 'media-element media-element--pending';
    img.alt = '';
    this.player.applyLayout(img, item);
    img.addEventListener('error', () => this.handleError(item));
    img.addEventListener('load', () => {
      this.swap(img);
      const durationMs = Number.isFinite(item.durationMs) && item.durationMs > 0 ? item.durationMs : 8000;
      this.timer = setTimeout(() => this.next(), durationMs);
    });
    this.host.appendChild(img);
    img.src = item.src;
  }
}
document.addEventListener('DOMContentLoaded', () => {
  const viewport = document.getElementById('viewport');
  const stage = document.getElementById('playlist-stage');
  const player = new SignagePlayer(viewport, stage);
  window.playerInstance = player;
  player.start();
});
