// SignLink unattended digital-signage player.
class SignagePlayer {
  constructor(viewport) {
    this.viewport = viewport;
    this.video = null;
    this.retryTimer = null;
  }

  async start() {
    try {
      const config = await this.loadConfig();
      const defaultVideo = this.findDefaultVideo(config);

      if (!defaultVideo) {
        throw new Error('No video is configured for startup playback.');
      }

      this.mountVideo(defaultVideo);
      await this.play();
    } catch (error) {
      console.error('Unable to start the SignLink player:', error);
      this.showError('Unable to play the default video.');
    }
  }

  async loadConfig() {
    try {
      const response = await fetch('config.json', { cache: 'no-store' });

      if (!response.ok) {
        throw new Error(`Unable to load config.json (${response.status}).`);
      }

      return response.json();
    } catch (error) {
      // Some desktop file:// runtimes restrict fetch. Keep the installed player
      // functional by falling back to the bundled video at the same relative path.
      console.warn('Using bundled startup configuration.', error);
      return {
        playlist: [{
          type: 'video',
          src: 'media/videos/default-video.mp4',
          default: true,
          muted: true,
          loop: true
        }]
      };
    }
  }

  findDefaultVideo(config) {
    const playlist = Array.isArray(config.playlist) ? config.playlist : [];
    return playlist.find((item) => item.type === 'video' && item.default === true)
      || playlist.find((item) => item.type === 'video');
  }

  mountVideo(item) {
    this.viewport.replaceChildren();

    const video = document.createElement('video');
    video.className = 'media-element';
    video.src = item.src;
    video.autoplay = true;
    video.loop = true;
    video.muted = item.muted !== false;
    video.defaultMuted = video.muted;
    video.playsInline = true;
    video.preload = 'auto';
    video.controls = false;
    video.disablePictureInPicture = true;
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('controlsList', 'nodownload nofullscreen noremoteplayback');

    video.addEventListener('canplay', () => this.play());
    video.addEventListener('pause', () => this.scheduleRetry());
    video.addEventListener('error', () => this.scheduleRetry(true));

    this.video = video;
    this.viewport.appendChild(video);
    video.load();
  }

  async play() {
    if (!this.video) return;

    clearTimeout(this.retryTimer);

    try {
      await this.video.play();
    } catch (error) {
      console.warn('Playback was interrupted; retrying.', error);
      this.scheduleRetry();
    }
  }

  scheduleRetry(reload = false) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (!this.video) return;
      if (reload) this.video.load();
      this.play();
    }, 2000);
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
