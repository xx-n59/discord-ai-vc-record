import fs from 'node:fs';
import path from 'node:path';
import { Client, GatewayIntentBits, Events, ChannelType, PermissionFlagsBits, MessageFlags, AttachmentBuilder } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import { createSession, loadSession, saveSession } from './storage.js';
import { Recorder } from './recorder.js';
import { processSession } from './ai.js';
import { acquireLock } from './lock.js';
import { mayStart, mayManage } from './commands.js';
import { resolveOutputChannel, validateOutputChannel } from './output-channel.js';

const noMentions = { parse: [] };
export function createBot(config, { connectVoice = joinVoiceChannel, waitForVoice = entersState, RecorderClass = Recorder, processRecording = processSession } = {}) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates], allowedMentions: noMentions });
  const active = new Map();
  let shuttingDown = false;
  async function send(channel, content, files = []) {
    return channel.send({ content, files, allowedMentions: noMentions });
  }
  async function publish(entry, result) {
    const files = [result.minutesPath, result.transcriptPath];
    const limit = entry.outputChannel.guild.maximumFileSize ?? 8 * 1024 * 1024;
    if (files.some(file => fs.statSync(file).size > limit)) {
      await send(entry.outputChannel, `議事録を保存しました。添付サイズ上限を超えたため、Botの data/${entry.session.id}/ を確認してください。`);
      return;
    }
    await send(entry.outputChannel, `📝 **議事録が完成しました**\n会議: ${entry.session.title}\n録音ID: \`${entry.session.id}\`\nAIの出力を確認してからご利用ください。`, files.map(file => new AttachmentBuilder(file)));
  }
  async function processEntry(entry) {
    let unlock;
    try {
      unlock = acquireLock(path.join(entry.session.dir, '.processing.lock'));
      await send(entry.outputChannel, `録音を終了しました。PC内で文字起こしを行い、ChatGPTサブスクのCodexで議事録を作成します。\n録音ID: \`${entry.session.id}\`\n処理には時間がかかることがあります。`);
      const result = await processRecording(entry.session, config);
      await publish(entry, result);
    } catch (error) {
      console.error('議事録処理:', error.message);
      if (error.diagnostics) console.error(error.diagnostics);
      if (entry.session.status !== 'complete') {
        entry.session.status = 'failed'; saveSession(entry.session);
      }
      const message = entry.session.status === 'complete'
        ? '議事録は保存済みですがDiscordへの投稿に失敗しました。'
        : `議事録の作成を完了できませんでした。${error.message}`;
      await send(entry.outputChannel, `${message}\n録音ID: \`${entry.session.id}\`\n設定や利用上限を確認し、\`/record retry\` の id に録音IDを指定してください。`).catch(() => {});
    } finally {
      unlock?.();
      if (active.get(entry.session.guildId) === entry) active.delete(entry.session.guildId);
    }
  }
  function stopEntry(entry, reason) {
    if (entry.stopPromise) return entry.stopPromise;
    entry.stopPromise = (async () => {
      clearTimeout(entry.timer);
      if (reason) entry.session.warnings.push(reason);
      entry.session.status = 'stopping';
      await entry.recorder.stop();
      entry.connection.destroy();
      if (shuttingDown) return;
      entry.session.status = 'processing';
      await processEntry(entry);
    })();
    // Automatic stops have no interaction awaiting them.
    entry.stopPromise.catch(error => {
      console.error('録音停止:', error.message);
      try { entry.connection.destroy(); } catch { /* already destroyed */ }
      entry.session.status = 'failed';
      try { saveSession(entry.session); } catch { /* disk may be unavailable */ }
      if (active.get(entry.session.guildId) === entry) active.delete(entry.session.guildId);
      void send(entry.outputChannel, `録音の終了処理に失敗しました。保存済みデータを確認してください。録音ID: ${entry.session.id}`).catch(() => {});
    });
    return entry.stopPromise;
  }
  async function start(interaction, member) {
    if (shuttingDown) throw new Error('Botを終了中です。');
    if (!mayStart(member, config)) throw new Error('開始にはサーバー管理権限またはALLOWED_ROLE_IDのロールが必要です。');
    if (!interaction.options.getBoolean('consent')) throw new Error('参加者への説明と同意を確認してから consent:True で開始してください。');
    const channel = member.voice.channel;
    if (channel?.type !== ChannelType.GuildVoice) throw new Error('通常のVCに参加してから実行してください。');
    if (active.has(interaction.guildId)) throw new Error('このサーバーでは録音または議事録作成が進行中です。');
    const botMember = await interaction.guild.members.fetchMe();
    const permissions = channel.permissionsFor(botMember);
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages];
    if (!permissions?.has(required)) throw new Error('VCでBotに「チャンネルを見る・接続・メッセージ送信」の権限を付けてください。');
    const outputChannel = await resolveOutputChannel({ guild: interaction.guild, voiceChannel: channel,
      outputChannelId: config.outputChannelId, member, botMember });
    // Recheck after the permission fetch, then reserve before the next await.
    if (active.has(interaction.guildId)) throw new Error('すでに録音・処理を開始しています。');
    const session = createSession(config, { title: interaction.options.getString('title') || 'VCミーティング',
      guildId: interaction.guildId, voiceChannelId: channel.id, textChannelId: outputChannel.id, startedBy: member.id });
    const entry = { session, channel, outputChannel };
    active.set(interaction.guildId, entry);
    try {
      await send(channel, `🔴 **録音を開始します**\n会議: ${session.title}\n音声はPC内で文字起こしし、文章をChatGPTのCodexに送信して議事録化します。\n終了: /record stop（開始者またはサーバー管理者）。最大${config.maxMinutes}分。\n議事録・文字起こしの送信先: <#${outputChannel.id}>。`);
      entry.connection = connectVoice({ channelId: channel.id, guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: false, selfMute: true });
      entry.connection.on('error', () => {
        if (entry.recorder && !entry.stopPromise) stopEntry(entry, '音声接続エラーにより途中で停止しました。');
      });
      await waitForVoice(entry.connection, VoiceConnectionStatus.Ready, 30000);
      if (shuttingDown) throw new Error('Botを終了中です。');
      // Count the meeting from the moment recording actually starts.
      session.startedAt = new Date().toISOString();
      entry.recorder = new RecorderClass(entry.connection, session, config, userId => {
        const user = channel.guild.members.cache.get(userId);
        return user && { bot: user.user.bot, name: user.displayName };
      }, () => { setImmediate(() => stopEntry(entry, '音声受信または録音容量上限のため自動停止しました。')); });
      entry.connection.on(VoiceConnectionStatus.Disconnected, () => {
        if (!entry.stopPromise) stopEntry(entry, 'VCから切断されたため途中で停止しました。');
      });
      entry.timer = setTimeout(() => stopEntry(entry, '設定された録音時間上限に達しました。'), config.maxMinutes * 60000);
      saveSession(session);
    } catch (error) {
      if (entry.recorder) await entry.recorder.stop();
      if (entry.connection) entry.connection.destroy();
      session.status = 'failed'; saveSession(session); active.delete(interaction.guildId);
      await send(channel, '録音を開始できませんでした。Botの権限・VC接続を確認してください。').catch(() => {});
      throw error;
    }
    await interaction.editReply(`録音中です。結果は <#${outputChannel.id}> に届きます。\n録音ID: \`${session.id}\``);
  }
  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'record') return;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!interaction.inGuild() || interaction.guildId !== config.guildId) throw new Error('設定されたサーバーで実行してください。');
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const action = interaction.options.getSubcommand();
      if (action === 'start') return await start(interaction, member);
      const entry = active.get(interaction.guildId);
      if (action === 'status') {
        await interaction.editReply(entry ? `状態: ${entry.session.status}\n録音ID: \`${entry.session.id}\`\n受信済み: ${Math.round((entry.recorder?.bytes || 0) / 1024)} KiB` : '録音・処理は行っていません。');
        return;
      }
      if (action === 'stop') {
        if (!entry?.recorder || entry.stopPromise) throw new Error('停止できる録音がありません。');
        if (!mayManage(member, entry.session)) throw new Error('録音開始者またはサーバー管理者だけが停止できます。');
        stopEntry(entry);
        await interaction.editReply(`録音を終了して議事録を作成します。完成後、<#${entry.session.textChannelId}> に投稿します。`);
        return;
      }
      if (action === 'retry') {
        if (active.has(interaction.guildId)) throw new Error('現在の録音・処理が終了してから再実行してください。');
        const session = loadSession(config.dataDir, interaction.options.getString('id'));
        if (session.guildId !== interaction.guildId || !mayManage(member, session)) throw new Error('この録音の再実行権限がありません。');
        const channel = await interaction.guild.channels.fetch(session.textChannelId);
        const botMember = await interaction.guild.members.fetchMe();
        validateOutputChannel(channel, { guildId: interaction.guildId, voiceChannelId: session.voiceChannelId, member, botMember });
        const voiceChannel = session.voiceChannelId === channel.id ? channel : await interaction.guild.channels.fetch(session.voiceChannelId);
        if (!voiceChannel?.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) throw new Error('元のVCにアクセスできません。');
        if (active.has(interaction.guildId)) throw new Error('現在の処理が終了してから再実行してください。');
        if (session.status === 'recording' || session.status === 'stopping') throw new Error('録音中です。Botを停止してから再実行してください。');
        const retryEntry = { session, outputChannel: channel };
        active.set(interaction.guildId, retryEntry);
        void processEntry(retryEntry);
        await interaction.editReply(`再処理を開始しました。結果は <#${channel.id}> に投稿します。`);
      }
    } catch (error) {
      console.error('コマンド:', error.message);
      const content = error.code === 'ENOENT' ? '録音IDが見つかりません。IDを確認してください。' : error.message;
      if (interaction.deferred) await interaction.editReply({ content: content.slice(0, 1900), allowedMentions: noMentions }).catch(() => {});
      else await interaction.reply({ content: 'コマンドの処理に失敗しました。', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });
  client.on(Events.VoiceStateUpdate, (before, after) => {
    const entry = active.get(after.guild.id);
    if (!entry?.recorder || entry.stopPromise) return;
    if (after.id === client.user?.id && (after.channelId !== entry.channel.id || after.serverDeaf)) {
      stopEntry(entry, 'Botの移動・退出・スピーカーミュートにより自動停止しました。'); return;
    }
    if (after.channelId === entry.channel.id && before.channelId !== after.channelId && !after.member?.user.bot) {
      void send(entry.channel, `🔴 このVCは録音中です。PC内で文字起こし後、文章をCodexに送信して議事録を作ります。送信先: <#${entry.session.textChannelId}>。`).catch(() => {});
    }
    if (!entry.channel.members.some(member => !member.user.bot)) stopEntry(entry, '参加者が全員退出したため自動停止しました。');
  });
  client.once(Events.ClientReady, ready => console.log(`ログイン完了: ${ready.user.tag}。/record start で開始できます。`));
  client.on(Events.Error, error => console.error('Discord:', error.message));
  async function shutdown() {
    shuttingDown = true;
    const recordings = [...active.values()].filter(entry => entry.recorder && !entry.stopPromise);
    await Promise.allSettled(recordings.map(entry => stopEntry(entry, 'Botの終了により停止しました。再起動後 /record retry で議事録を作成できます。')));
    client.destroy();
  }
  return { client, shutdown, active };
}
