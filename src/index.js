import path from 'node:path';
import { loadConfig } from './config.js';
import { checkCodexLogin } from './codex.js';
import { recoverSessions } from './storage.js';
import { acquireLock } from './lock.js';
import { createBot } from './bot.js';
import { terminateSubprocesses } from './subprocess.js';

let unlock;
let bot;
try {
  const config = loadConfig(process.env, { required: ['DISCORD_TOKEN', 'DISCORD_GUILD_ID'] });
  await checkCodexLogin(config);
  unlock = acquireLock(path.join(config.dataDir, '.bot.lock'));
  recoverSessions(config.dataDir);
  bot = createBot(config);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      console.log('録音を保存して終了します。');
      terminateSubprocesses();
      await bot.shutdown(); unlock(); process.exit(0);
    });
  }
  await bot.client.login(config.token);
} catch (error) {
  console.error(error.message);
  terminateSubprocesses(); bot?.client.destroy();
  unlock?.(); process.exitCode = 1;
}
