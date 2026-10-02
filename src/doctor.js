import { loadConfig } from './config.js';
import { checkCodexLogin } from './codex.js';
import { generateDependencyReport } from '@discordjs/voice';
import { runProcess } from './subprocess.js';
const config = loadConfig();
console.log(`Node.js: ${process.version}`);
console.log(generateDependencyReport());
for (const key of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID']) console.log(`${key}: ${process.env[key]?.trim() ? '設定済み' : '未設定'}`);
console.log(`議事録の送信先: ${config.outputChannelId ? `専用チャンネル (${config.outputChannelId})` : '録音したVCのチャット'}`);
for (const [label, check] of [
  ['ChatGPTサブスク認証', () => checkCodexLogin(config)],
  ['ローカル文字起こし', () => runProcess(config.pythonPath, ['-c', `import io, wave
from faster_whisper.audio import decode_audio
b = io.BytesIO()
with wave.open(b, 'wb') as w:
 w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(bytes(3200))
b.seek(0)
assert len(decode_audio(b)) == 1600
print('OK')`], { timeoutMs: 30000 })],
]) {
  try { await check(); console.log(`${label}: OK`); }
  catch (error) { console.error(`${label}: ${error.message}`); process.exitCode = 1; }
}
