import 'dotenv/config';
import path from 'node:path';

export function loadConfig(env = process.env, { required = [] } = {}) {
  for (const key of required) {
    if (!env[key]?.trim()) throw new Error(`.env に ${key} を設定してください。`);
  }
  const number = (key, fallback, min, max) => {
    const value = Number(env[key] || fallback);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${key} は ${min}〜${max} の数値にしてください。`);
    }
    return value;
  };
  for (const key of ['DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'ALLOWED_ROLE_ID']) {
    if (env[key]?.trim() && !/^\d{17,20}$/.test(env[key].trim())) {
      throw new Error(`${key} はDiscordのIDを指定してください。`);
    }
  }
  return {
    token: env.DISCORD_TOKEN?.trim(), clientId: env.DISCORD_CLIENT_ID?.trim(),
    guildId: env.DISCORD_GUILD_ID?.trim(),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    whisperModel: env.WHISPER_MODEL || 'small',
    pythonPath: env.PYTHON_PATH || path.resolve('.venv/bin/python'),
    codexPath: env.CODEX_PATH || 'codex',
    codexModel: env.CODEX_MODEL || '',
    codexTimeoutMs: number('CODEX_TIMEOUT_SECONDS', 600, 30, 3600) * 1000,
    language: env.TRANSCRIBE_LANGUAGE || 'ja',
    maxMinutes: number('MAX_RECORDING_MINUTES', 120, 1, 480),
    maxBytes: number('MAX_RECORDING_MB', 2048, 1, 10240) * 1024 * 1024,
    allowedRoleId: env.ALLOWED_ROLE_ID?.trim(),
  };
}
