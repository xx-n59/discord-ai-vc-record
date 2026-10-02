import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './subprocess.js';
const script = fileURLToPath(new URL('../scripts/transcribe.py', import.meta.url));
export async function transcribeLocal(session, config) {
  const cacheDir = path.join(session.dir, 'transcripts');
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const segments = session.segments.map(segment => {
    const file = path.resolve(session.dir, segment.file);
    if (!file.startsWith(path.join(session.dir, 'audio') + path.sep)) throw new Error('音声ファイルのパスが不正です。');
    if (!Number.isSafeInteger(segment.id) || segment.id < 1) throw new Error('音声IDが不正です。');
    return { id: segment.id, file, cacheFile: path.join(cacheDir, `${segment.id}.json`) };
  });
  await runProcess(config.pythonPath, [script], {
    input: JSON.stringify({ model: config.whisperModel, language: config.language, modelDir: path.join(config.dataDir, 'models'), segments }),
    timeoutMs: 8 * 60 * 60 * 1000,
  });
  return session.segments.map((segment, i) => ({ ...segment, text: JSON.parse(fs.readFileSync(segments[i].cacheFile, 'utf8')).text }));
}
