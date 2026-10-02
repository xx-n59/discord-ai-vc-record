import path from 'node:path';
import { loadConfig } from './config.js';
import { loadSession } from './storage.js';
import { processSession } from './ai.js';
import { acquireLock } from './lock.js';
let unlock;
try {
  const id = process.argv[2];
  if (!id) throw new Error('使用方法: npm run process -- 録音ID');
  const config = loadConfig();
  const session = loadSession(config.dataDir, id);
  if (['recording', 'stopping'].includes(session.status)) throw new Error('録音中のデータです。Botを正常停止、または再起動して中断状態を回復してください。');
  unlock = acquireLock(path.join(session.dir, '.processing.lock'));
  const result = await processSession(session, config);
  console.log(`保存しました: ${result.minutesPath}\n${result.transcriptPath}`);
} catch (error) {
  console.error(error.message);
  if (error.diagnostics) console.error(error.diagnostics);
  process.exitCode = 1;
} finally { unlock?.(); }
