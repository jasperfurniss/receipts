// Writes a fake `pull_request` event for local dry runs of `receipts ci` (never sent anywhere).
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const sha = execSync('git rev-parse HEAD').toString().trim();
mkdirSync('.receipts/ci', { recursive: true });
const event = {
  action: 'synchronize',
  number: 123,
  repository: { full_name: 'acme/acme-learn' },
  pull_request: { number: 123, head: { sha, ref: 'feature/resume-playback' }, base: { sha: '0'.repeat(40), ref: 'main' }, body: readFileSync('pr-body.md', 'utf8') },
};
writeFileSync('.receipts/ci/event.json', JSON.stringify(event, null, 2));
console.log(`wrote .receipts/ci/event.json (head ${sha.slice(0, 7)})`);
