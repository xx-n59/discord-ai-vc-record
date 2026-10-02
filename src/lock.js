import fs from 'node:fs';
import path from 'node:path';
export function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('ロックファイルが不正です。実行中のBotを確認してください。');
    try { process.kill(pid, 0); }
    catch (probe) {
      if (probe.code === 'ESRCH') { fs.unlinkSync(file); return acquireLock(file); }
      throw probe;
    }
    throw new Error('同じデータを処理中のプロセスがあります。');
  }
  return () => { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
}
