import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function hasFfmpeg(): Promise<boolean> {
  try {
    await run('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/** WebM → MP4 (H.264, faststart) with chapter markers so players can jump between steps. */
export async function webmToMp4(src: string, dest: string, chapters: { title: string; startMs: number }[], totalMs: number): Promise<void> {
  const meta = `${dest}.ffmeta`;
  const lines = [';FFMETADATA1', 'title=Receipts evidence'];
  chapters.forEach((c, i) => {
    const end = i + 1 < chapters.length ? chapters[i + 1]!.startMs : Math.max(c.startMs + 1, totalMs);
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.max(0, Math.round(c.startMs))}`, `END=${Math.round(end)}`, `title=${c.title.replace(/[=;#\\\n]/g, ' ')}`);
  });
  await writeFile(meta, lines.join('\n') + '\n');
  await run(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-i', src, '-i', meta, '-map_metadata', '1', '-map_chapters', '1', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', '+faststart', '-an', dest],
    { maxBuffer: 1 << 24 },
  );
  const { rm } = await import('node:fs/promises');
  await rm(meta, { force: true });
}
