import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLock } from './lock.js';

export function writeJson(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function saveSession(session) {
  writeJson(path.join(session.dir, 'session.json'), session);
}
export function createSession(config, metadata) {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const dir = path.join(config.dataDir, id);
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true, mode: 0o700 });
  const session = {
    ...metadata, id, dir, startedAt: new Date().toISOString(), endedAt: null,
    status: 'recording', segments: [], warnings: [], participants: {},
  };
  saveSession(session);
  return session;
}
export function loadSession(dataDir, id) {
  if (!/^[\w-]+$/.test(id)) throw new Error('録音IDが不正です。');
  const dir = path.join(dataDir, id);
  const session = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  // Do not trust a persisted absolute directory when moving recordings to another host.
  session.dir = dir;
  return session;
}
export function listSessions(dataDir) {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      try { return [loadSession(dataDir, entry.name)]; } catch { return []; }
    });
}
export function recoverSessions(dataDir) {
  for (const session of listSessions(dataDir)) {
    if (['recording', 'processing', 'stopping'].includes(session.status)) {
      let unlock;
      try { unlock = acquireLock(path.join(session.dir, '.processing.lock')); }
      catch { continue; }
      session.status = 'interrupted';
      session.warnings.push('前回のBot終了により中断しました。最後の未確定音声は含まれない可能性があります。');
      try { saveSession(session); } finally { unlock(); }
    }
  }
}
