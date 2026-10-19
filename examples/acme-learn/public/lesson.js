import { loadSession } from './api.js';

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const region = document.querySelector('[aria-label="Lesson video"]');
const video = document.getElementById('lesson-video');
const note = region.querySelector('.resume');
const slug = region.dataset.slug;
const url = `/api/me/progress/lessons/${slug}`;

const { flags, me } = await loadSession();
if (me.user) {
  const auth = { Authorization: `Bearer ${me.apiToken}`, 'Content-Type': 'application/json' };
  if (flags['resume-playback']) {
    const { seconds } = await (await fetch(url, { headers: auth })).json();
    if (seconds > 1) {
      const apply = () => {
        video.currentTime = seconds;
        note.textContent = `Resuming from ${fmt(seconds)}`;
      };
      video.readyState >= 1 ? apply() : video.addEventListener('loadedmetadata', apply, { once: true });
    }
  }
  let last = 0;
  const save = (keepalive = false) => {
    if (video.currentTime < 1) return;
    last = Date.now();
    fetch(url, { method: 'PUT', headers: auth, body: JSON.stringify({ seconds: Math.round(video.currentTime * 10) / 10 }), keepalive });
  };
  video.addEventListener('timeupdate', () => Date.now() - last > 2000 && !video.paused && save());
  video.addEventListener('seeked', () => save());
  video.addEventListener('pause', () => save());
  window.addEventListener('pagehide', () => save(true));
}
