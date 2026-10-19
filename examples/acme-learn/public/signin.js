const form = document.getElementById('signin');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const r = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (r.ok) location.href = '/courses';
  else form.querySelector('.error').textContent = 'That email and password did not match.';
});
