import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { runProcess } from './subprocess.js';
try {
  const config = loadConfig();
  console.log(`文字起こしモデル ${config.whisperModel} を準備します。初回はダウンロードが必要です。`);
  const result = await runProcess(config.pythonPath, [fileURLToPath(new URL('../scripts/transcribe.py', import.meta.url)),
    '--download-model', config.whisperModel, '--cache-dir', path.join(config.dataDir, 'models')], { timeoutMs: 30 * 60000 });
  console.log(result.stdout.trim());
} catch (error) {
  console.error(error.message);
  if (error.diagnostics) console.error(error.diagnostics);
  process.exitCode = 1;
}
