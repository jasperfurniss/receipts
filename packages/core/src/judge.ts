import type { AiConfig, AiProvider, JudgeRequest, JudgeVerdict } from './config.js';

/**
 * Resolve the configured AI provider. Returns undefined unless a provider is configured AND
 * (for the OpenAI-compatible provider) its API key env var is set. Nothing AI ever runs by default.
 */
export function resolveProvider(ai: AiConfig | undefined, env: NodeJS.ProcessEnv = process.env): AiProvider | undefined {
  const p = ai?.provider;
  if (!p) return undefined;
  if ('type' in p && p.type === 'openai-compatible') {
    const key = env[p.apiKeyEnv];
    if (!key) return undefined;
    return openAiCompatible({ baseURL: p.baseURL ?? 'https://api.openai.com/v1', model: p.model, apiKey: key });
  }
  return p as AiProvider;
}

export function judgeEnabled(ai: AiConfig | undefined, env: NodeJS.ProcessEnv = process.env): AiProvider | undefined {
  if (!ai?.judge?.enabled) return undefined;
  const p = resolveProvider(ai, env);
  return p?.judge ? p : undefined;
}

async function chat(opts: { baseURL: string; model: string; apiKey: string }, messages: unknown[], fetchImpl = fetch): Promise<string> {
  const res = await fetchImpl(`${opts.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({ model: opts.model, messages, temperature: 0 }),
  });
  if (!res.ok) throw new Error(`AI provider error ${res.status}`);
  const j = (await res.json()) as any;
  return j.choices?.[0]?.message?.content ?? '';
}

export function parseJudgeReply(text: string): JudgeVerdict {
  const m = /\{[\s\S]*\}/.exec(text);
  try {
    const j = JSON.parse(m ? m[0] : text);
    const verdict = ['pass', 'fail', 'unsure'].includes(j.verdict) ? j.verdict : 'unsure';
    return { verdict, rationale: String(j.rationale ?? ''), confidence: j.confidence };
  } catch {
    return { verdict: 'unsure', rationale: `unparseable judge reply: ${text.slice(0, 200)}` };
  }
}

export function openAiCompatible(opts: { baseURL: string; model: string; apiKey: string; fetchImpl?: typeof fetch }): AiProvider {
  return {
    name: `openai-compatible:${opts.model}`,
    async judge(req: JudgeRequest) {
      const content: unknown[] = [
        {
          type: 'text',
          text:
            'You verify UI behavior from screenshots. Personal data has been blurred on purpose; ignore it. ' +
            `Expectation: ${JSON.stringify(req.expectation)}. ` +
            'Reply with JSON only: {"verdict":"pass"|"fail"|"unsure","rationale":"...","confidence":"low"|"medium"|"high"}.',
        },
        ...req.images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b.toString('base64')}` } })),
      ];
      return parseJudgeReply(await chat(opts, [{ role: 'user', content }], opts.fetchImpl));
    },
    async compileStep(req) {
      const text = await chat(
        opts,
        [
          {
            role: 'system',
            content:
              'Write the body of an async function (page, context) using the Playwright library API that performs the instruction. ' +
              'Prefer getByRole/getByLabel locators. No imports, no test() wrapper, no assertions unless asked. Output only code.',
          },
          { role: 'user', content: `URL: ${req.url ?? 'unknown'}\nAccessibility snapshot:\n${(req.ariaSnapshot ?? '').slice(0, 12000)}\n\nInstruction: ${req.instruction}` },
        ],
        opts.fetchImpl,
      );
      return text.replace(/^```\w*\n?|```\s*$/g, '').trim();
    },
    async draftScenario(req) {
      const text = await chat(
        opts,
        [
          { role: 'system', content: 'Draft a Receipts scenario YAML (id, title, covers, persona, flags, steps with chapter/goto/click/fill/expect/capture). Output only YAML.' },
          { role: 'user', content: `Test Plan item: ${req.item}\n\nDiff (truncated):\n${(req.diff ?? '').slice(0, 15000)}\n\nIssue:\n${(req.issue ?? '').slice(0, 4000)}` },
        ],
        opts.fetchImpl,
      );
      return text.replace(/^```\w*\n?|```\s*$/g, '').trim();
    },
  };
}
