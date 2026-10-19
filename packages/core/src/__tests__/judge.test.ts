import { describe, expect, it } from 'vitest';
import { judgeEnabled, openAiCompatible, parseJudgeReply, resolveProvider } from '../judge.js';

describe('AI judge', () => {
  it('is off unless enabled AND a key is configured', () => {
    const provider = { type: 'openai-compatible' as const, model: 'm', apiKeyEnv: 'RCPT_KEY' };
    expect(judgeEnabled(undefined, {})).toBeUndefined();
    expect(judgeEnabled({ provider }, { RCPT_KEY: 'k' })).toBeUndefined(); // not enabled
    expect(judgeEnabled({ provider, judge: { enabled: true } }, {})).toBeUndefined(); // no key
    expect(judgeEnabled({ provider, judge: { enabled: true } }, { RCPT_KEY: 'k' })?.name).toBe('openai-compatible:m');
    expect(resolveProvider({ provider: { name: 'custom', judge: async () => ({ verdict: 'pass', rationale: '' }) } })?.name).toBe('custom');
  });

  it('parses replies defensively', () => {
    expect(parseJudgeReply('```json\n{"verdict":"pass","rationale":"ok","confidence":"high"}\n```')).toEqual({ verdict: 'pass', rationale: 'ok', confidence: 'high' });
    expect(parseJudgeReply('nonsense').verdict).toBe('unsure');
    expect(parseJudgeReply('{"verdict":"maybe"}').verdict).toBe('unsure');
  });

  it('sends only the expectation + images to an OpenAI-compatible endpoint (mocked)', async () => {
    let sent: any;
    const fetchImpl = (async (url: string, init: any) => {
      sent = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"fail","rationale":"at 0:00"}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = openAiCompatible({ baseURL: 'http://llm.internal/v1', model: 'vision', apiKey: 'k', fetchImpl });
    const v = await p.judge!({ expectation: 'resumes near 0:42', images: [Buffer.from('png')] });
    expect(v.verdict).toBe('fail');
    expect(sent.url).toBe('http://llm.internal/v1/chat/completions');
    expect(sent.auth).toBe('Bearer k');
    expect(sent.body.messages[0].content[1].image_url.url).toBe('data:image/png;base64,cG5n');
  });
});
