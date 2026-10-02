import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { recordCommand } from './commands.js';
try {
  const config = loadConfig(process.env, { required: ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'] });
  await new REST({ version: '10' }).setToken(config.token).post(
    Routes.applicationGuildCommands(config.clientId, config.guildId), { body: recordCommand.toJSON() });
  console.log('/record を登録しました。npm start でBotを起動してください。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
