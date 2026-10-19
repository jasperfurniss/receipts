export async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  return r.json();
}
export async function loadSession() {
  const [flags, me] = await Promise.all([getJSON('/api/flags'), getJSON('/api/me')]);
  window.__acmeFlags = flags; // test hook: resolved flag state
  return { flags, me };
}
