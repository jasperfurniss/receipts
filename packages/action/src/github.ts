import { STICKY_MARKER, type CheckSummary } from '@receipts/core';

/** Minimal GitHub REST client: sticky comment upsert + check run. Injected fetch so tests never hit the network. */
export class GitHubClient {
  constructor(
    private token: string,
    private repo: string,
    private apiUrl = 'https://api.github.com',
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async req(method: string, path: string, body?: unknown) {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'receipts-action',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}`);
    return res.status === 204 ? undefined : res.json();
  }

  async findStickyComment(pr: number): Promise<{ id: number; body: string } | undefined> {
    for (let page = 1; page <= 10; page++) {
      const list = (await this.req('GET', `/repos/${this.repo}/issues/${pr}/comments?per_page=100&page=${page}`)) as { id: number; body: string }[];
      const hit = list.find((c) => c.body?.includes(STICKY_MARKER));
      if (hit) return hit;
      if (list.length < 100) return undefined;
    }
    return undefined;
  }

  /** One comment per PR, edited in place, never spammed. */
  async upsertComment(pr: number, body: string): Promise<{ id: number; created: boolean }> {
    const existing = await this.findStickyComment(pr);
    if (existing) {
      await this.req('PATCH', `/repos/${this.repo}/issues/comments/${existing.id}`, { body });
      return { id: existing.id, created: false };
    }
    const c = (await this.req('POST', `/repos/${this.repo}/issues/${pr}/comments`, { body })) as { id: number };
    return { id: c.id, created: true };
  }

  /** Flip the existing comment to "stale" while a new run is in progress. */
  async markStale(pr: number, headSha: string) {
    const existing = await this.findStickyComment(pr);
    if (!existing || existing.body.includes('⏳ Receipts: stale')) return;
    const body = existing.body.replace(STICKY_MARKER, `${STICKY_MARKER}\n### ⏳ Receipts: stale (head is \`${headSha.slice(0, 7)}\`), re-running…`);
    await this.req('PATCH', `/repos/${this.repo}/issues/comments/${existing.id}`, { body });
  }

  async createCheck(headSha: string, check: CheckSummary, detailsUrl?: string) {
    return this.req('POST', `/repos/${this.repo}/check-runs`, {
      name: check.name,
      head_sha: headSha,
      status: 'completed',
      conclusion: check.conclusion,
      details_url: detailsUrl,
      output: { title: check.title, summary: check.summary.slice(0, 65000) },
    });
  }

  async updatePrBody(pr: number, body: string) {
    return this.req('PATCH', `/repos/${this.repo}/pulls/${pr}`, { body });
  }
}
