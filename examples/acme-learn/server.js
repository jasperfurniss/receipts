// Acme Learn: a tiny fictional course site used to exercise Receipts end to end.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 4173);
const LEARNER = { id: 'u_ada', name: 'Ada Lovelace', email: 'ada@acme.test', phone: '+1 (864) 555-0147', password: 'correct-horse' };
const LESSONS = {
  'intro-to-typography': { title: 'Intro to Typography', minutes: 3 },
  'color-theory': { title: 'Color Theory Basics', minutes: 3 },
};
const DEFAULT_FLAGS = { 'resume-playback': false, 'new-nav': false };
const sessions = new Map(); // token -> userId
const progress = new Map(); // `${userId}:${slug}` -> seconds

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const tok = parseCookies(req).acme_session;
  return tok && sessions.has(tok) ? LEARNER : null;
}
function flagsFor(req) {
  const flags = { ...DEFAULT_FLAGS };
  try {
    const override = parseCookies(req).acme_flags;
    if (override) Object.assign(flags, JSON.parse(override));
  } catch {
    /* ignore malformed override */
  }
  const q = req.query.flags; // ?flags=resume-playback:on,new-nav:off
  if (typeof q === 'string')
    for (const kv of q.split(',')) {
      const [k, v] = kv.split(':');
      if (k) flags[k] = v === 'on' || v === 'true';
    }
  return flags;
}
const requireUser = (req, res, next) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'signed out' });
  req.user = u;
  next();
};

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// --- API -------------------------------------------------------------------
app.post('/api/session', (req, res) => {
  const { email, password } = req.body ?? {};
  if (email !== LEARNER.email || password !== LEARNER.password) return res.status(401).json({ error: 'bad credentials' });
  const token = 'sess_' + randomBytes(16).toString('hex');
  sessions.set(token, LEARNER.id);
  res.setHeader('Set-Cookie', `acme_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});
app.post('/api/session/logout', (req, res) => {
  sessions.delete(parseCookies(req).acme_session);
  res.setHeader('Set-Cookie', 'acme_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  // Signed out is a normal state, so 200 + null (a 401 here would log a console error).
  if (!u) return res.json({ user: null });
  // A fake JWT the client uses as a bearer token, to prove the scrubber removes it from traces.
  const payload = Buffer.from(JSON.stringify({ sub: u.id, iat: 1760000000 })).toString('base64url');
  res.json({ user: { id: u.id, name: u.name, email: u.email }, apiToken: `eyJhbGciOiJIUzI1NiJ9.${payload}.c2lnbmF0dXJlLW5vdC1yZWFs` });
});
app.get('/api/me/profile', requireUser, (req, res) => res.json({ phone: req.user.phone, email: req.user.email }));
app.get('/api/flags', (req, res) => res.json(flagsFor(req)));
app.get('/api/me/progress/lessons/:slug', requireUser, (req, res) => res.json({ seconds: progress.get(`${req.user.id}:${req.params.slug}`) ?? 0 }));
app.put('/api/me/progress/lessons/:slug', requireUser, (req, res) => {
  const s = Number(req.body?.seconds);
  if (!Number.isFinite(s) || s < 0) return res.status(400).json({ error: 'seconds required' });
  progress.set(`${req.user.id}:${req.params.slug}`, s);
  res.json({ ok: true, seconds: s });
});
app.delete('/api/me/progress/lessons/:slug', requireUser, (req, res) => {
  progress.delete(`${req.user.id}:${req.params.slug}`);
  res.json({ ok: true });
});

// --- Pages -----------------------------------------------------------------
app.use('/static', express.static(join(here, 'public')));
app.get('/media/lesson.webm', (_req, res) => {
  const f = join(here, 'media', 'lesson.webm');
  if (!existsSync(f)) return res.status(404).send('run `npm run media` first');
  res.sendFile(f);
});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function layout(req, title, body, script = '') {
  const u = currentUser(req);
  const account = u
    ? `<div class="account" data-testid="account-menu"><span class="avatar">AL</span><span>${esc(u.name)}</span> <span class="learner-email">${esc(u.email)}</span></div>`
    : `<a class="signin" href="/signin">Sign in</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Acme Learn</title>
<link rel="stylesheet" href="/static/app.css"></head><body>
<header><a class="logo" href="/">Acme Learn</a><nav><a href="/courses">Courses</a></nav>${account}</header>
<main>${body}</main>${script ? `<script type="module" src="/static/${script}"></script>` : ''}</body></html>`;
}

app.get('/', (req, res) => res.send(layout(req, 'Home', `<h1>Learn design, one lesson at a time</h1><p><a href="/courses">Browse courses →</a></p>`)));
app.get('/signin', (req, res) =>
  res.send(
    layout(
      req,
      'Sign in',
      `<h1>Sign in</h1><form id="signin" class="card">
  <label>Email <input type="email" name="email" autocomplete="username" data-receipts-redact></label>
  <label>Password <input type="password" name="password" autocomplete="current-password"></label>
  <button type="submit">Sign in</button><p class="error" role="alert"></p></form>`,
      'signin.js',
    ),
  ),
);
app.get('/courses', (req, res) => {
  const u = currentUser(req);
  const list = Object.entries(LESSONS)
    .map(([slug, l]) => `<li><a href="/lessons/${slug}">${esc(l.title)}</a> <span class="muted">${l.minutes} min</span></li>`)
    .join('');
  const profile = u ? `<aside class="card profile"><h2>Your profile</h2><p>Phone: <span class="learner-phone" data-receipts-redact>${esc(u.phone)}</span></p></aside>` : '';
  res.send(layout(req, 'Courses', `<h1>Courses</h1><ul class="lessons">${list}</ul>${profile}`, 'courses.js'));
});
app.get('/lessons/:slug', (req, res) => {
  const l = LESSONS[req.params.slug];
  if (!l) return res.status(404).send(layout(req, 'Not found', '<h1>Lesson not found</h1>'));
  res.send(
    layout(
      req,
      l.title,
      `<h1>${esc(l.title)}</h1>
<section class="player" role="region" aria-label="Lesson video" data-slug="${esc(req.params.slug)}">
  <video id="lesson-video" src="/media/lesson.webm" controls preload="auto" playsinline muted></video>
  <p class="resume" aria-live="polite"></p>
</section>
<p class="muted">Signed-in learners pick up where they left off (flag <code>resume-playback</code>).</p>`,
      'lesson.js',
    ),
  );
});

app.listen(PORT, () => console.log(`Acme Learn on http://localhost:${PORT}`));
