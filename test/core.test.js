import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import OpusScript from 'opusscript';
import { ChunkWriter, stereoToMono, RATE } from '../src/audio.js';
import { createSession, loadSession, recoverSessions } from '../src/storage.js';
import { processSession, renderTranscript, splitText, summarize } from '../src/ai.js';
import { loadConfig } from '../src/config.js';
import { codexEnvironment, runProcess } from '../src/subprocess.js';
import { codexArgs, checkCodexLogin } from '../src/codex.js';
import { acquireLock } from '../src/lock.js';
import { Recorder } from '../src/recorder.js';
import { mayStart, mayManage, recordCommand } from '../src/commands.js';
import { PermissionFlagsBits } from 'discord.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-bot-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = { ...loadConfig({}), dataDir };
  const session = createSession(config, { title: '開発会議', guildId: 'g', startedBy: 'owner', voiceChannelId: 'v' });
  return { config, session };
}

test('PCM downmix preserves sign and does not clip', () => {
  const pcm = Buffer.alloc(12);
  [32767, 32767, -32768, -32768, 30000, -30000].forEach((x, i) => pcm.writeInt16LE(x, i * 2));
  const mono = stereoToMono(pcm);
  assert.deepEqual([mono.readInt16LE(0), mono.readInt16LE(2), mono.readInt16LE(4)], [32767, -32768, 0]);
  assert.throws(() => stereoToMono(Buffer.alloc(3)));
});

test('WAV chunks have valid headers, bounded sizes and continuous offsets', async t => {
  const { session } = fixture(t); let id = 0; let counted = 0;
  const chunks = [];
  const writer = new ChunkWriter({ dir: session.dir, userId: '123', offsetMs: 5000,
    nextId: () => ++id, onChunk: x => chunks.push(x), onBytes: n => { counted += n; }, chunkSeconds: 0.02 });
  writer.end(Buffer.alloc(RATE * 4 * 0.05));
  await once(writer, 'finish');
  assert.equal(chunks.length, 3); assert.equal(counted, RATE * 2 * 0.05);
  assert.deepEqual(chunks.map(x => x.offsetMs), [5000, 5020, 5040]);
  for (const chunk of chunks) {
    const wav = fs.readFileSync(path.join(session.dir, chunk.file));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), RATE);
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    assert.ok(wav.length <= 44 + RATE * 2 * 0.02);
  }
});

test('Opus receiver decodes two users and stop drains all WAV files', async t => {
  const { config, session } = fixture(t);
  const speaking = new EventEmitter(); speaking.users = new Map();
  const streams = new Map();
  const connection = { receiver: { speaking, subscribe: id => {
    const stream = new PassThrough({ objectMode: true }); streams.set(id, stream); return stream;
  } } };
  const errors = [];
  const recorder = new Recorder(connection, session, config, id => ({ name: `user-${id}` }), error => errors.push(error));
  const encoder = new OpusScript(RATE, 2, OpusScript.Application.VOIP);
  t.after(() => encoder.delete());
  const packet = encoder.encode(Buffer.alloc(960 * 4), 960);
  for (const id of ['111', '222']) {
    speaking.emit('start', id);
    streams.get(id).write(Buffer.from(packet));
    streams.get(id).write(Buffer.from(packet));
  }
  await recorder.stop(); await recorder.stop();
  assert.equal(session.segments.length, 2);
  assert.equal(session.status, 'recorded');
  assert.deepEqual(errors, []);
  assert.deepEqual(session.warnings, []);
  assert.equal(speaking.listenerCount('start'), 0);
  assert.equal(fs.readFileSync(path.join(session.dir, session.segments[0].file)).length, 44 + 960 * 2 * 2);
});

test('capacity errors keep already recorded chunks and terminate reception', async t => {
  const { session } = fixture(t); const chunks = []; let calls = 0;
  const writer = new ChunkWriter({ dir: session.dir, userId: '1', offsetMs: 0,
    nextId: () => 1, onChunk: x => chunks.push(x), onBytes: () => { if (++calls > 1) throw new Error('limit'); } });
  writer.write(Buffer.alloc(3840));
  const errorPromise = once(writer, 'error');
  writer.write(Buffer.alloc(3840));
  assert.match((await errorPromise)[0].message, /limit/);
  assert.equal(chunks.length, 1);
  assert.equal(fs.readFileSync(path.join(session.dir, chunks[0].file)).length, 1964);
});

test('session traversal rejected and interrupted sessions recovered', t => {
  const { config, session } = fixture(t);
  assert.throws(() => loadSession(config.dataDir, '../secret'));
  recoverSessions(config.dataDir);
  const recovered = loadSession(config.dataDir, session.id);
  assert.equal(recovered.status, 'interrupted');
  assert.ok(recovered.warnings.length);
});

test('transcript sorts simultaneous speakers deterministically', t => {
  const { session } = fixture(t); session.participants = { a: '田中', b: '佐藤' };
  const text = renderTranscript(session, [{ id: 2, userId: 'b', offsetMs: 2000, text: '後' }, { id: 1, userId: 'a', offsetMs: 1000, text: '先' }]);
  assert.ok(text.indexOf('田中: 先') < text.indexOf('佐藤: 後'));
  assert.match(text, /00:00:01/);
});

test('local transcript survives Codex failure and succeeds on retry', async t => {
  const { config, session } = fixture(t); session.segments = [{ id: 1, userId: 'a', offsetMs: 0 }];
  const transcribe = async () => [{ ...session.segments[0], text: '田中が金曜までに確認します' }];
  const checkLogin = async () => {};
  await assert.rejects(processSession(session, config, { transcribe, checkLogin, generate: async () => { throw new Error('usage limit'); } }), /usage limit/);
  assert.equal(session.status, 'failed');
  assert.match(fs.readFileSync(path.join(session.dir, 'transcript.md'), 'utf8'), /金曜/);
  const result = await processSession(session, config, { transcribe, checkLogin, generate: async () => '## ToDo\n田中: 金曜までに確認' });
  assert.equal(session.status, 'complete');
  assert.match(fs.readFileSync(result.minutesPath, 'utf8'), /田中/);
});

test('empty recordings and empty transcription cannot fabricate minutes', async t => {
  const { config, session } = fixture(t);
  await assert.rejects(processSession(session, config), /音声を受信/);
  session.segments = [{ id: 1 }];
  await assert.rejects(processSession(session, config, { transcribe: async () => [{ id: 1, offsetMs: 0, text: '' }] }), /空/);
  assert.equal(session.status, 'failed');
  assert.ok(!fs.existsSync(path.join(session.dir, 'minutes.md')));
});

test('long transcript is summarized in bounded batches before final merge', async () => {
  const input = ('長い会議の発言です。\n').repeat(4000);
  assert.equal(splitText(input).join(''), input);
  const prompts = [];
  await summarize(async (config, prompt) => { prompts.push(prompt); return '決定事項: 来週確認'; }, {}, input);
  assert.ok(prompts.length > 2);
  assert.ok(prompts.every(prompt => prompt.length < 19000));
  assert.match(prompts.at(-1), /決定事項/);
});

test('API auth and inherited API keys are excluded from subscription path', async () => {
  const env = codexEnvironment({ HOME: '/home/user', PATH: '/bin', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', DISCORD_TOKEN: 'secret' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/user' });
  await assert.rejects(checkCodexLogin({ codexPath: 'codex' }, async () => ({ stdout: 'Logged in using an API key', stderr: '' })), /APIキー/);
  await checkCodexLogin({ codexPath: 'codex' }, async () => ({ stdout: '', stderr: 'Logged in using ChatGPT' }));
  const args = codexArgs({}, '/tmp/result', '/tmp/work');
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.ok(args.includes('read-only'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('subprocess stdin is literal text; timeout kills process', async () => {
  const input = '$(echo unsafe) `echo unsafe`\n日本語';
  const result = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input });
  assert.equal(result.stdout, input);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 }), /タイムアウト/);
});

test('exclusive lock rejects duplicate runs and releases cleanly', t => {
  const { session } = fixture(t); const file = path.join(session.dir, '.lock');
  const release = acquireLock(file);
  assert.throws(() => acquireLock(file), /処理中/);
  release(); const release2 = acquireLock(file); release2();
});

test('recording controls require configured role or manager, stop owner or manager', () => {
  const member = { id: 'owner', permissions: { has: permission => permission !== PermissionFlagsBits.ManageGuild }, roles: { cache: new Map([['r', {}]]) } };
  assert.equal(mayStart(member, {}), false);
  assert.equal(mayStart(member, { allowedRoleId: 'r' }), true);
  assert.equal(mayManage(member, { startedBy: 'owner' }), true);
  assert.equal(mayManage(member, { startedBy: 'someone-else' }), false);
  const command = recordCommand.toJSON();
  assert.deepEqual(command.options.map(option => option.name), ['start', 'stop', 'status', 'retry']);
  assert.equal(command.options[0].options[0].required, true);
});

test('invalid recording limits rejected before connecting', () => {
  assert.throws(() => loadConfig({ MAX_RECORDING_MINUTES: 'NaN' }));
  assert.throws(() => loadConfig({ MAX_RECORDING_MB: '-1' }));
  assert.throws(() => loadConfig({ DISCORD_GUILD_ID: 'not-an-id' }));
  assert.throws(() => loadConfig({}, { required: ['DISCORD_TOKEN'] }), /DISCORD_TOKEN/);
});

test('recovery does not change a session still being processed by another process', t => {
  const { config, session } = fixture(t);
  const release = acquireLock(path.join(session.dir, '.processing.lock'));
  try {
    recoverSessions(config.dataDir);
    assert.equal(loadSession(config.dataDir, session.id).status, 'recording');
  } finally { release(); }
});
