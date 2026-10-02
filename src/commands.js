import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
export const recordCommand = new SlashCommandBuilder().setName('record').setDescription('VCの録音と議事録作成')
  .setDMPermission(false)
  .addSubcommand(sub => sub.setName('start').setDescription('参加中のVCの録音を開始')
    .addBooleanOption(option => option.setName('consent').setDescription('参加者へ録音・文字起こし・Codexへの文章送信を説明し同意を得た').setRequired(true))
    .addStringOption(option => option.setName('title').setDescription('会議名').setMaxLength(100)))
  .addSubcommand(sub => sub.setName('stop').setDescription('録音を終了し、文字起こし・議事録作成'))
  .addSubcommand(sub => sub.setName('status').setDescription('現在の録音・処理状況'))
  .addSubcommand(sub => sub.setName('retry').setDescription('保存済み録音から議事録作成を再実行')
    .addStringOption(option => option.setName('id').setDescription('録音ID').setRequired(true)));

export function mayStart(member, config) {
  return member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    Boolean(config.allowedRoleId && member.roles.cache.has(config.allowedRoleId));
}
export function mayManage(member, session) {
  return member.id === session.startedBy || member.permissions.has(PermissionFlagsBits.ManageGuild);
}
