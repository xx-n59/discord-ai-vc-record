import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Events } from 'discord.js';
import { createBot } from '../src/bot.js';
import { createSession } from '../src/storage.js';

function context(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-bot-commands-'));
  const config = { guildId: 'guild', dataDir };
  const bot = createBot(config);
  t.after(() => { bot.client.destroy(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const session = createSession(config, { guildId: 'guild', startedBy: 'owner', title: 'test' });
  return { bot, session };
}
function interaction(id, action) {
  const replies = [];
  return {
    replies, isChatInputCommand: () => true, commandName: 'record', guildId: 'guild',
    user: { id }, inGuild: () => true,
    guild: { members: { fetch: async () => ({ id, permissions: { has: () => false } }) } },
    options: { getSubcommand: () => action },
    deferReply: async function () { this.deferred = true; },
    editReply: async message => { replies.push(message); },
  };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); }
  throw new Error('test timed out');
}

test('unauthorized stop does not touch the recorder', async t => {
  const { bot, session } = context(t); let stops = 0;
  bot.active.set('guild', { session, recorder: { stop: async () => { stops++; } } });
  const command = interaction('stranger', 'stop');
  bot.client.emit(Events.InteractionCreate, command);
  await until(() => command.replies.length > 0);
  assert.equal(stops, 0);
  assert.match(command.replies[0].content, /録音開始者/);
});

test('two simultaneous stop commands finalize the recording only once', async t => {
  const { bot, session } = context(t); let stops = 0; let destroys = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  bot.active.set('guild', { session,
    recorder: { stop: async () => { stops++; await gate; } },
    connection: { destroy: () => { destroys++; } },
    channel: { send: async () => {} },
  });
  const a = interaction('owner', 'stop'); const b = interaction('owner', 'stop');
  bot.client.emit(Events.InteractionCreate, a); bot.client.emit(Events.InteractionCreate, b);
  await until(() => a.replies.length && b.replies.length);
  assert.equal(stops, 1); release();
  await until(() => !bot.active.has('guild'));
  assert.equal(destroys, 1);
  assert.equal(session.status, 'failed'); // Empty audio must never produce fabricated minutes.
});
