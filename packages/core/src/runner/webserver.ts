import { spawn, type ChildProcess } from 'node:child_process';

export async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

export async function waitForUrl(url: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await isUp(url)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export interface StartedServer {
  stop(): Promise<void>;
  reused: boolean;
}

export async function startWebServer(
  ws: { command: string; url: string; timeout?: number; reuseExisting?: boolean; cwd?: string; env?: Record<string, string> },
  root: string,
  log: (s: string) => void,
): Promise<StartedServer> {
  if ((ws.reuseExisting ?? true) && (await isUp(ws.url))) {
    log(`webServer: reusing ${ws.url}`);
    return { reused: true, stop: async () => {} };
  }
  log(`webServer: starting \`${ws.command}\``);
  const child: ChildProcess = spawn(ws.command, {
    shell: true,
    cwd: ws.cwd ?? root,
    env: { ...process.env, ...ws.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let out = '';
  child.stdout?.on('data', (d) => (out = (out + d).slice(-4000)));
  child.stderr?.on('data', (d) => (out = (out + d).slice(-4000)));
  const ok = await waitForUrl(ws.url, ws.timeout ?? 60_000);
  const stop = async () => {
    if (child.exitCode !== null) return;
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  };
  if (!ok) {
    await stop();
    throw new Error(`webServer did not become ready at ${ws.url}\n${out}`);
  }
  return { reused: false, stop };
}
