import { loadSession, getJSON } from './api.js';
const { me } = await loadSession();
if (me.user) await getJSON('/api/me/profile');
