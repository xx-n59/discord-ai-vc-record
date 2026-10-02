import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ChannelType, Collection, Events, PermissionFlagsBits } from 'discord.js';
import { loadConfig } from '../src/config.js';
import { createBot } from '../src/bot.js';
import { loadSession, saveSession } from '../src/storage.js';
import { resolveOutputChannel, validateOutputChannel } from '../src/output-channel.js';

const member = { id: 'owner', permissions: { has: () => true }, user: { bot: false } };
const botMember = { id: 'bot' };
function channel(id, guild, type = ChannelType.GuildText) {
  return { id, guild, type, messages: [],
    permissionsFor: () => ({ has: () => true }),
    async send(message) { this.messages.push(message); },
  };
}
function targets() {
  const guild = { id: 'guild' };
  const voice = channel('voice', guild, ChannelType.GuildVoice);
  const output = channel('output', guild);
  guild.channels = { fetch: async id => id === output.id ? output : null };
  return { guild, voice, output };
}

test('output ID is optional, trimmed and validated as a Discord ID', () => {
  assert.equal(loadConfig({}).outputChannelId, undefined);
  assert.equal(loadConfig({ DISCORD_OUTPUT_CHANNEL_ID: '   ' }).outputChannelId, '');
  assert.equal(loadConfig({ DISCORD_OUTPUT_CHANNEL_ID: ' 1555443695719948361 ' }).outputChannelId, '1555443695719948361');
  assert.throws(() => loadConfig({ DISCORD_OUTPUT_CHANNEL_ID: '#議事録' }), /DISCORD_OUTPUT_CHANNEL_ID/);
});

test('an empty setting retains VC delivery and a configured setting resolves the text channel', async () => {
  const { guild, voice, output } = targets();
  const options = { guild, voiceChannel: voice, member, botMember };
  assert.equal(await resolveOutputChannel(options), voice);
  assert.equal(await resolveOutputChannel({ ...options, outputChannelId: output.id }), output);
});

test('missing, cross-guild, non-text or DM destinations fail without fallback', async () => {
  const { guild, voice, output } = targets();
  const options = { guild, voiceChannel: voice, member, botMember, outputChannelId: 'output' };
  await assert.rejects(resolveOutputChannel({ ...options, outputChannelId: 'missing' }), /テキストチャンネル/);
  for (const type of [ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.PublicThread, ChannelType.GuildForum, ChannelType.DM]) {
    output.type = type;
    await assert.rejects(resolveOutputChannel(options), /テキストチャンネル/);
  }
  output.type = ChannelType.GuildText; output.guild = { id: 'other-guild' };
  await assert.rejects(resolveOutputChannel(options), /同じサーバー/);
  assert.throws(() => validateOutputChannel({ type: ChannelType.DM }, { guildId: 'guild' }), /同じサーバー/);
});

test('destination access for the caller and each delivery permission for the bot are required', async () => {
  const { guild, voice, output } = targets();
  const options = { guild, voiceChannel: voice, member, botMember, outputChannelId: 'output' };
  output.permissionsFor = who => ({ has: () => who !== member });
  await assert.rejects(resolveOutputChannel(options), /アクセスできません/);
  for (const denied of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles]) {
    output.permissionsFor = who => ({ has: requested => who === member || !(Array.isArray(requested) ? requested : [requested]).includes(denied) });
    await assert.rejects(resolveOutputChannel(options), /送信先でBot/);
  }
});

async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  throw new Error('test timed out');
}
function setup(t, outputChannelId = 'output') {
  const { guild, voice, output } = targets();
  const other = channel('other', guild);
  const owner = { ...member, voice: { channel: voice } };
  voice.members = new Collection([[owner.id, owner]]);
  guild.members = { cache: new Collection([[owner.id, owner]]), fetchMe: async () => botMember, fetch: async () => owner };
  guild.channels.fetch = async id => [voice, output, other].find(c => c.id === id) || null;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-output-test-'));
  const config = { guildId: guild.id, dataDir, outputChannelId, maxMinutes: 120 };
  let connections = 0;
  const bot = createBot(config, {
    connectVoice: () => { connections++; const c = new EventEmitter(); c.destroy = () => {}; return c; },
    waitForVoice: async () => {},
    RecorderClass: class {
      constructor(connection, session) { this.session = session; this.bytes = 10; }
      async stop() { this.session.status = 'recorded'; saveSession(this.session); }
    },
    processRecording: async session => {
      const minutesPath = path.join(session.dir, 'minutes.md');
      const transcriptPath = path.join(session.dir, 'transcript.md');
      fs.writeFileSync(minutesPath, '議事録'); fs.writeFileSync(transcriptPath, '文字起こし');
      session.status = 'complete'; saveSession(session);
      return { minutesPath, transcriptPath };
    },
  });
  t.after(async () => { await bot.shutdown(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  async function command(action, id) {
    const replies = [];
    const interaction = {
      isChatInputCommand: () => true, commandName: 'record', guildId: guild.id, guild,
      user: { id: owner.id }, inGuild: () => true,
      options: { getSubcommand: () => action, getBoolean: () => true, getString: name => name === 'id' ? id : '会議' },
      deferReply: async function () { this.deferred = true; },
      editReply: async reply => { replies.push(reply); },
    };
    bot.client.emit(Events.InteractionCreate, interaction);
    await until(() => replies.length);
    return replies[0];
  }
  return { bot, config, guild, voice, output, other, command, connections: () => connections };
}

test('dedicated delivery keeps voice notifications and lifecycle in the recorded VC', async t => {
  const { bot, config, guild, voice, output, command } = setup(t);
  const reply = await command('start');
  assert.match(reply, /<#output>/);
  const session = bot.active.get(guild.id).session;
  assert.equal(loadSession(config.dataDir, session.id).textChannelId, output.id);
  assert.match(voice.messages[0].content, /送信先: <#output>/);
  assert.equal(output.messages.length, 0);
  bot.client.emit(Events.VoiceStateUpdate, { channelId: null }, { id: 'new-member', guild, channelId: voice.id, member: { user: { bot: false } } });
  await until(() => voice.messages.length === 2);
  assert.match(voice.messages[1].content, /<#output>/);
  assert.ok(bot.active.has(guild.id));
  await command('stop');
  await until(() => !bot.active.has(guild.id));
  assert.equal(voice.messages.length, 2);
  assert.equal(output.messages.length, 2);
  assert.equal(output.messages[1].files.length, 2);
  assert.deepEqual(output.messages[1].allowedMentions, { parse: [] });
});

test('retry uses the saved destination even after the configured channel changes', async t => {
  const { bot, config, output, other, command } = setup(t);
  await command('start'); const id = bot.active.get('guild').session.id;
  await command('stop'); await until(() => !bot.active.has('guild'));
  config.outputChannelId = other.id;
  const reply = await command('retry', id);
  await until(() => !bot.active.has('guild'));
  assert.match(reply, /<#output>/);
  assert.equal(output.messages.length, 4);
  assert.equal(other.messages.length, 0);
});

test('unset output preserves attachments to VC and legacy retry behavior', async t => {
  const { bot, config, voice, output, command } = setup(t, '');
  await command('start'); const id = bot.active.get('guild').session.id;
  await command('stop'); await until(() => !bot.active.has('guild'));
  assert.equal(voice.messages.at(-1).files.length, 2);
  config.outputChannelId = output.id;
  await command('retry', id); await until(() => !bot.active.has('guild'));
  assert.equal(voice.messages.at(-1).files.length, 2);
  assert.equal(voice.messages.length, 5);
  assert.equal(output.messages.length, 0);
});

test('invalid destination prevents connection and recording', async t => {
  const { bot, voice, command, connections } = setup(t, 'missing');
  const reply = await command('start');
  assert.match(reply.content, /DISCORD_OUTPUT_CHANNEL_ID/);
  assert.equal(connections(), 0);
  assert.equal(bot.active.size, 0);
  assert.equal(voice.messages.length, 0);
});

test('retry refuses a destination whose attachment permission was removed', async t => {
  const { bot, output, command } = setup(t);
  await command('start'); const id = bot.active.get('guild').session.id;
  await command('stop'); await until(() => !bot.active.has('guild'));
  output.permissionsFor = who => ({ has: () => who.id !== botMember.id });
  const reply = await command('retry', id);
  assert.match(reply.content, /送信先でBot/);
  assert.equal(bot.active.size, 0);
  assert.equal(output.messages.length, 2);
});

test('automatic stop checks VC membership even when results go to a text channel', async t => {
  const { bot, guild, voice, output, command } = setup(t);
  await command('start');
  voice.members.clear();
  bot.client.emit(Events.VoiceStateUpdate, { channelId: voice.id }, { id: 'owner', guild, channelId: null, member });
  await until(() => !bot.active.has(guild.id));
  assert.equal(output.messages.at(-1).files.length, 2);
  assert.equal(voice.messages.length, 1);
});
