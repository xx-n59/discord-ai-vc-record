import { ChannelType, PermissionFlagsBits } from 'discord.js';

export function validateOutputChannel(channel, { guildId, voiceChannelId, member, botMember }) {
  const supported = channel?.type === ChannelType.GuildText ||
    (channel?.type === ChannelType.GuildVoice && channel.id === voiceChannelId);
  if (!channel || !supported || channel.guild?.id !== guildId) {
    throw new Error('送信先が見つからないか、対応していません。同じサーバーのテキストチャンネルを指定してください。');
  }
  if (!channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
    throw new Error('議事録の送信先チャンネルにアクセスできません。');
  }
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles];
  if (!channel.permissionsFor(botMember)?.has(required)) {
    throw new Error('送信先でBotに「チャンネルを見る・メッセージ送信・ファイル添付」の権限を付けてください。');
  }
  return channel;
}

export async function resolveOutputChannel({ guild, voiceChannel, outputChannelId, member, botMember }) {
  const channel = outputChannelId ? await guild.channels.fetch(outputChannelId) : voiceChannel;
  if (outputChannelId && channel?.type !== ChannelType.GuildText) {
    throw new Error('DISCORD_OUTPUT_CHANNEL_IDには通常のテキストチャンネルのIDを指定してください。');
  }
  return validateOutputChannel(channel, { guildId: guild.id, voiceChannelId: voiceChannel.id, member, botMember });
}
