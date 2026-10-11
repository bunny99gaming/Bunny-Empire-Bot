import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import {
  Client, GatewayIntentBits, PermissionFlagsBits, SlashCommandBuilder,
  REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, UserSelectMenuBuilder, ChannelType,
  EmbedBuilder, AuditLogEvent, Events, ActivityType
} from 'discord.js';
import { classifyModerationAction, shouldMonitorActor, shouldTriggerProtection } from './security.js';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.BUNNY_ID;
const PORT = Number(process.env.PORT || 3000);
if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  throw new Error('DISCORD_TOKEN, CLIENT_ID, and BUNNY_ID are required.');
}

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'bunny-empire.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { dmSubscribers: [], guilds: {}, quarantines: {} };
try {
  if (fs.existsSync(DATA_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
} catch (error) {
  console.error('Could not read data file; starting with fresh data:', error.message);
}
db.dmSubscribers ||= [];
db.guilds ||= {};
db.quarantines ||= {};
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
const guildConfig = id => db.guilds[id] ||= { announcementChannelId: null, securityRoleId: null, securityEnabled: true };
const ownerOnly = i => i.user?.id === OWNER_ID;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quarantineTimers = new Map();
const actionHistory = new Map();
const pendingAnnouncements = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.DirectMessages
  ]
});

async function notifyOwner(content, components = []) {
  try {
    const owner = await client.users.fetch(OWNER_ID);
    await owner.send({ content, components });
    return true;
  } catch (error) {
    console.error('Could not DM bot owner:', error.message);
    return false;
  }
}

function ownerCommand(data, execute) {
  commands.push({ data, execute: async i => {
    if (!ownerOnly(i)) return i.reply({ content: '⛔ This command is restricted to the bot owner.', ephemeral: true });
    if (!i.guild && !['help'].includes(i.commandName)) return i.reply({ content: 'Use this command inside a server.', ephemeral: true });
    return execute(i);
  }});
}
const commands = [];

ownerCommand(new SlashCommandBuilder().setName('help').setDescription('Show Bunny Empire bot commands'), async i => {
  await i.reply({ ephemeral: true, content:
    '**BUNNY EMPIRE OFFICIAL BOT**\n\n' +
    '`/ann` — open the announcement destination panel\n' +
    '`/ann-channel` — set this server’s announcement channel\n' +
    '`/dm-panel` — post the opt-in DM subscription panel\n' +
    '`/ban`, `/kick`, `/timeout` — moderation actions\n' +
    '`/security-setup` — select the staff role monitored by anti-nuke\n' +
    '`/security-status` — view security configuration\n\n' +
    '**POWERED BY BUNNY EMPIRE**'
  });
});

ownerCommand(new SlashCommandBuilder()
  .setName('ann').setDescription('Create an announcement and choose where it is sent')
  .addStringOption(o => o.setName('message').setDescription('Announcement text').setRequired(true).setMaxLength(2000)), async i => {
    const message = i.options.getString('message', true);
    pendingAnnouncements.set(i.user.id, { message, guildId: i.guildId, target: null, selectedIds: [] });
    const menu = new StringSelectMenuBuilder().setCustomId('ann_target').setPlaceholder('Choose announcement destination').addOptions(
      { label: 'All Servers', value: 'all_servers', description: 'Post in each configured server channel' },
      { label: 'This Server', value: 'this_server', description: 'Post in this server’s configured channel' },
      { label: 'All Users (opt-in)', value: 'all_users', description: 'DM members who subscribed to announcements' },
      { label: 'Selected Users (opt-in)', value: 'selected_users', description: 'Choose up to 25 subscribed users' }
    );
    await i.reply({ ephemeral: true, content: `**BUNNY EMPIRE — ANNOUNCEMENT**\n\nPreview:\n${message}\n\nChoose the destination:`, components: [new ActionRowBuilder().addComponents(menu)] });
  }
);

ownerCommand(new SlashCommandBuilder().setName('ann-channel').setDescription('Set this server’s announcement destination')
  .addChannelOption(o => o.setName('channel').setDescription('Text or announcement channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)), async i => {
    const channel = i.options.getChannel('channel', true);
    guildConfig(i.guildId).announcementChannelId = channel.id;
    save();
    await i.reply({ content: `✅ Announcement channel set to ${channel}.`, ephemeral: true });
    await notifyOwner(`⚙️ **Announcement channel configured**\nServer: **${i.guild.name}**\nChannel: ${channel}`);
  }
);

ownerCommand(new SlashCommandBuilder().setName('dm-panel').setDescription('Post the opt-in announcement DM subscription panel')
  .addChannelOption(o => o.setName('channel').setDescription('Where to post the subscription panel').addChannelTypes(ChannelType.GuildText).setRequired(true)), async i => {
    const channel = i.options.getChannel('channel', true);
    await channel.send({
      embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Bunny Empire Announcements')
        .setDescription('Choose whether you want to receive Bunny Empire announcements by direct message. You can unsubscribe at any time.')
        .setFooter({ text: 'POWERED BY BUNNY EMPIRE' })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('dm_subscribe').setLabel('Subscribe to DMs').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('dm_unsubscribe').setLabel('Unsubscribe').setStyle(ButtonStyle.Secondary)
      )]
    });
    await i.reply({ content: `✅ Opt-in panel posted in ${channel}.`, ephemeral: true });
  }
);

ownerCommand(new SlashCommandBuilder().setName('security-setup').setDescription('Choose the staff role protected by anti-nuke')
  .addRoleOption(o => o.setName('staff_role').setDescription('Role to temporarily remove after suspicious mass actions').setRequired(true)), async i => {
    const role = i.options.getRole('staff_role', true);
    guildConfig(i.guildId).securityRoleId = role.id;
    guildConfig(i.guildId).securityEnabled = true;
    save();
    await i.reply({ content: `🛡️ Anti-nuke monitoring is enabled for ${role}.\nThe bot needs **View Audit Log** and **Manage Roles**, and its highest role must be above this role.`, ephemeral: true });
    await notifyOwner(`🛡️ **Anti-nuke configured**\nServer: **${i.guild.name}**\nProtected staff role: **${role.name}**`);
  }
);

ownerCommand(new SlashCommandBuilder().setName('security-status').setDescription('Show security settings for this server'), async i => {
  const cfg = guildConfig(i.guildId);
  await i.reply({ ephemeral: true, content:
    `**BUNNY EMPIRE SECURITY**\nServer: **${i.guild.name}**\nAnti-nuke: **${cfg.securityEnabled ? 'Enabled' : 'Disabled'}**\nMonitored staff role: ${cfg.securityRoleId ? `<@&${cfg.securityRoleId}>` : '**Not configured**'}\nDM subscribers: **${db.dmSubscribers.length}**`
  });
});

ownerCommand(new SlashCommandBuilder().setName('ban').setDescription('Ban a member')
  .addUserOption(o => o.setName('user').setDescription('Member to ban').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Reason for the ban').setMaxLength(500)), async i => {
    const user = i.options.getUser('user', true);
    const reason = i.options.getString('reason') || `Action by Bunny Empire owner (${i.user.tag})`;
    const member = await i.guild.members.fetch(user.id).catch(() => null);
    if (!member) return i.reply({ content: '❌ That user is not a current member of this server.', ephemeral: true });
    if (!member.bannable) return i.reply({ content: '❌ I cannot ban this member. Check my Ban Members permission and role position.', ephemeral: true });
    await member.ban({ reason });
    await i.reply({ content: `🔨 Banned **${user.tag}**.`, ephemeral: true });
    await notifyOwner(`🔨 **BAN ACTION**\nServer: **${i.guild.name}**\nTarget: **${user.tag}** (${user.id})\nBy: **${i.user.tag}**\nReason: ${reason}`);
  }
);

ownerCommand(new SlashCommandBuilder().setName('kick').setDescription('Kick a member')
  .addUserOption(o => o.setName('user').setDescription('Member to kick').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Reason for the kick').setMaxLength(500)), async i => {
    const user = i.options.getUser('user', true);
    const reason = i.options.getString('reason') || `Action by Bunny Empire owner (${i.user.tag})`;
    const member = await i.guild.members.fetch(user.id).catch(() => null);
    if (!member) return i.reply({ content: '❌ That user is not a current member of this server.', ephemeral: true });
    if (!member.kickable) return i.reply({ content: '❌ I cannot kick this member. Check my Kick Members permission and role position.', ephemeral: true });
    await member.kick(reason);
    await i.reply({ content: `👢 Kicked **${user.tag}**.`, ephemeral: true });
    await notifyOwner(`👢 **KICK ACTION**\nServer: **${i.guild.name}**\nTarget: **${user.tag}** (${user.id})\nBy: **${i.user.tag}**\nReason: ${reason}`);
  }
);

ownerCommand(new SlashCommandBuilder().setName('timeout').setDescription('Timeout a member')
  .addUserOption(o => o.setName('user').setDescription('Member to timeout').setRequired(true))
  .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes (1–40320)').setMinValue(1).setMaxValue(40320).setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Reason for the timeout').setMaxLength(500)), async i => {
    const user = i.options.getUser('user', true);
    const minutes = i.options.getInteger('minutes', true);
    const reason = i.options.getString('reason') || `Action by Bunny Empire owner (${i.user.tag})`;
    const member = await i.guild.members.fetch(user.id).catch(() => null);
    if (!member) return i.reply({ content: '❌ That user is not a current member of this server.', ephemeral: true });
    if (!member.moderatable) return i.reply({ content: '❌ I cannot timeout this member. Check my Moderate Members permission and role position.', ephemeral: true });
    await member.timeout(minutes * 60_000, reason);
    await i.reply({ content: `⏱️ Timed out **${user.tag}** for **${minutes} minutes**.`, ephemeral: true });
    await notifyOwner(`⏱️ **TIMEOUT ACTION**\nServer: **${i.guild.name}**\nTarget: **${user.tag}** (${user.id})\nDuration: **${minutes} minutes**\nBy: **${i.user.tag}**\nReason: ${reason}`);
  }
);

function announcementButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ann_send').setLabel('Send').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ann_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
}
function targetSummary(target) {
  return ({ all_servers: 'All Servers (configured announcement channels)', this_server: 'This Server (configured announcement channel)', all_users: 'All subscribed users by DM', selected_users: 'Selected subscribed users by DM' })[target] || 'Not selected';
}

client.on(Events.InteractionCreate, async i => {
  try {
    if (i.isChatInputCommand()) {
      const command = commands.find(c => c.data.name === i.commandName);
      if (command) return await command.execute(i);
      return;
    }

    if (i.isButton() && ['dm_subscribe', 'dm_unsubscribe'].includes(i.customId)) {
      const has = db.dmSubscribers.includes(i.user.id);
      if (i.customId === 'dm_subscribe') {
        if (!has) db.dmSubscribers.push(i.user.id);
        save();
        return i.reply({ content: '✅ You are subscribed to Bunny Empire announcement DMs. Use Unsubscribe any time to stop them.', ephemeral: true });
      }
      db.dmSubscribers = db.dmSubscribers.filter(id => id !== i.user.id);
      save();
      return i.reply({ content: 'You have been unsubscribed from Bunny Empire announcement DMs.', ephemeral: true });
    }

    if (i.isButton() && i.customId.startsWith('security_ban:')) {
      if (!ownerOnly(i)) return i.reply({ content: '⛔ Only Bunny can confirm this security action.', ephemeral: true });
      const [, guildId, actorId] = i.customId.split(':');
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      const member = guild ? await guild.members.fetch(actorId).catch(() => null) : null;
      if (!member) return i.update({ content: 'The flagged member is no longer in that server. No ban was needed.', components: [] });
      if (!member.bannable) return i.reply({ content: 'I cannot ban this member. Check bot permissions and role hierarchy.', ephemeral: true });
      await member.ban({ reason: 'Confirmed by Bunny after anti-nuke security alert.' });
      await i.update({ content: `✅ **${member.user.tag}** was banned from **${guild.name}** by your confirmation.`, components: [] });
      return;
    }

    if (i.isStringSelectMenu() && i.customId === 'ann_target') {
      if (!ownerOnly(i)) return i.reply({ content: '⛔ Only Bunny can use this panel.', ephemeral: true });
      const state = pendingAnnouncements.get(i.user.id);
      if (!state) return i.update({ content: 'This announcement panel expired. Run `/ann` again.', components: [] });
      state.target = i.values[0];
      if (state.target === 'selected_users') {
        const userMenu = new UserSelectMenuBuilder().setCustomId('ann_selected_users').setPlaceholder('Choose up to 25 users').setMinValues(1).setMaxValues(25);
        return i.update({ content: `**Destination:** ${targetSummary(state.target)}\n\nOnly users who subscribed to Bunny Empire DMs will receive this announcement.`, components: [new ActionRowBuilder().addComponents(userMenu), announcementButtons()] });
      }
      return i.update({ content: `**Destination:** ${targetSummary(state.target)}\n\n**Message:**\n${state.message}\n\nPress Send to continue.`, components: [announcementButtons()] });
    }

    if (i.isUserSelectMenu() && i.customId === 'ann_selected_users') {
      if (!ownerOnly(i)) return i.reply({ content: '⛔ Only Bunny can use this panel.', ephemeral: true });
      const state = pendingAnnouncements.get(i.user.id);
      if (!state) return i.update({ content: 'This announcement panel expired. Run `/ann` again.', components: [] });
      state.selectedIds = i.values;
      return i.update({ content: `**Destination:** Selected subscribed users\nSelected: **${i.values.length}**\nSubscribed among selected: **${i.values.filter(id => db.dmSubscribers.includes(id)).length}**\n\n**Message:**\n${state.message}\n\nPress Send to continue.`, components: [announcementButtons()] });
    }

    if (i.isButton() && ['ann_send', 'ann_cancel'].includes(i.customId)) {
      if (!ownerOnly(i)) return i.reply({ content: '⛔ Only Bunny can use this panel.', ephemeral: true });
      const state = pendingAnnouncements.get(i.user.id);
      if (!state) return i.update({ content: 'This announcement panel expired. Run `/ann` again.', components: [] });
      if (i.customId === 'ann_cancel') {
        pendingAnnouncements.delete(i.user.id);
        return i.update({ content: '❎ Announcement cancelled.', components: [] });
      }
      await i.deferUpdate();
      let sent = 0, failed = 0, skipped = 0;
      if (state.target === 'all_servers' || state.target === 'this_server') {
        const guilds = state.target === 'this_server' ? [client.guilds.cache.get(state.guildId)].filter(Boolean) : [...client.guilds.cache.values()];
        for (const guild of guilds) {
          const channelId = guildConfig(guild.id).announcementChannelId;
          if (!channelId) { skipped++; continue; }
          const channel = await guild.channels.fetch(channelId).catch(() => null);
          if (!channel?.isTextBased() || !channel.permissionsFor(client.user)?.has(PermissionFlagsBits.SendMessages)) { failed++; continue; }
          try { await channel.send({ content: state.message, allowedMentions: { parse: [] } }); sent++; }
          catch { failed++; }
        }
      } else {
        const ids = state.target === 'all_users' ? [...db.dmSubscribers] : state.selectedIds.filter(id => db.dmSubscribers.includes(id));
        skipped = state.target === 'selected_users' ? state.selectedIds.length - ids.length : 0;
        const uniqueIds = [...new Set(ids)].slice(0, 500);
        if (ids.length > 500) skipped += ids.length - 500;
        for (const id of uniqueIds) {
          try {
            const user = await client.users.fetch(id);
            await user.send({ content: state.message, allowedMentions: { parse: [] } });
            sent++;
          } catch { failed++; }
          await sleep(150);
        }
      }
      pendingAnnouncements.delete(i.user.id);
      await i.editReply({ content: `✅ **Announcement run completed**\nDestination: **${targetSummary(state.target)}**\nSent: **${sent}**\nFailed: **${failed}**\nSkipped / not subscribed / not configured: **${skipped}**`, components: [] });
      await notifyOwner(`📣 **Announcement report**\nDestination: ${targetSummary(state.target)}\nSent: ${sent} | Failed: ${failed} | Skipped: ${skipped}`);
      return;
    }
  } catch (error) {
    console.error(error);
    if (i.isRepliable() && !i.replied && !i.deferred) await i.reply({ content: '❌ Something went wrong. Check the bot logs.', ephemeral: true }).catch(() => {});
    else if (i.isRepliable() && i.deferred) await i.editReply({ content: '❌ Something went wrong while processing this action.', components: [] }).catch(() => {});
  }
});

async function restoreQuarantine(record) {
  const { guildId, actorId, roleId, until } = record;
  const key = `${guildId}:${actorId}`;
  const delay = Math.max(0, until - Date.now());
  const timer = setTimeout(async () => {
    try {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      const member = guild ? await guild.members.fetch(actorId).catch(() => null) : null;
      const role = guild ? await guild.roles.fetch(roleId).catch(() => null) : null;
      if (member && role && !member.roles.cache.has(roleId)) await member.roles.add(role, 'End of temporary Bunny Empire anti-nuke quarantine.');
      await notifyOwner(`🛡️ Anti-nuke quarantine period ended for **${actorId}** in **${guild?.name || guildId}**. The monitored role was restored if the member was still present.`);
    } catch (error) { console.error('Role restore error:', error.message); }
    delete db.quarantines[key];
    quarantineTimers.delete(key);
    save();
  }, Math.min(delay, 2_147_000_000));
  quarantineTimers.set(key, timer);
}

client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
  try {
    const moderationAction = classifyModerationAction(entry, AuditLogEvent);
    const isBotAdd = entry.action === AuditLogEvent.BotAdd;
    if (isBotAdd && entry.targetId && entry.targetId !== client.user.id) {
      await notifyOwner(`🚨 **A BOT WAS ADDED**\nServer: **${guild.name}** (${guild.id})\nBot added: <@${entry.targetId}> (${entry.targetId})\nAdded by: ${entry.executor ? `${entry.executor.tag} (${entry.executor.id})` : 'Unknown'}\nPlease review this server’s bot list and permissions.`);
      return;
    }
    if (!moderationAction) return;
    const actorId = entry.executorId;
    if (!actorId || actorId === client.user.id || actorId === OWNER_ID || actorId === guild.ownerId) return;
    const cfg = guildConfig(guild.id);
    const roleId = cfg.securityRoleId;
    if (!cfg.securityEnabled || !roleId) return;
    const quarantineKey = `${guild.id}:${actorId}`;
    const alreadyQuarantined = Boolean(db.quarantines[quarantineKey]);
    const actor = await guild.members.fetch(actorId).catch(() => null);
    if (!actor || !shouldMonitorActor(actor.roles.cache.has(roleId), alreadyQuarantined)) return;
    const now = Date.now();
    const historyKey = `${guild.id}:${actorId}`;
    const history = (actionHistory.get(historyKey) || []).filter(t => now - t < 5 * 60_000);
    history.push(now);
    actionHistory.set(historyKey, history);
    const burst = history.length >= 2 && history.at(-1) - history.at(-2) <= 10_000;
    if (!shouldTriggerProtection(history)) {
      await notifyOwner(`⚠️ **Moderation action observed**\nServer: **${guild.name}**\nAction: **${moderationAction.label}**\nModerator: **${actor.user.tag}** (${actorId})\nTarget ID: ${entry.targetId || 'Unknown'}\nNo automatic action taken.`);
      return;
    }
    if (!alreadyQuarantined) {
      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (!role || !actor.manageable) {
        await notifyOwner(`🚨 **ANTI-NUKE ALERT — ACTION NEEDED**\nServer: **${guild.name}**\nModerator: **${actor.user.tag}** (${actorId})\nRepeated moderation actions detected, but I could not remove the monitored role. Check role hierarchy and Manage Roles permission.`);
        return;
      }
      await actor.roles.remove(role, 'Bunny Empire anti-nuke: suspicious rapid/repeated member moderation.');
      db.quarantines[quarantineKey] = { guildId: guild.id, actorId, roleId, until: now + 60 * 60_000 };
      save();
      await restoreQuarantine(db.quarantines[quarantineKey]);
      await notifyOwner(`🚨 **ANTI-NUKE PROTECTION ACTIVATED**\nServer: **${guild.name}**\nModerator: **${actor.user.tag}** (${actorId})\nPattern: ${history.length} moderation actions in 5 minutes (rapid burst: ${burst ? 'yes' : 'no'})\nAction: monitored staff role removed for **1 hour**.\nIf you confirm malicious activity, use the button below to ban this moderator.`, [
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`security_ban:${guild.id}:${actorId}`).setLabel('Confirm Ban').setStyle(ButtonStyle.Danger))
      ]);
    } else {
      await notifyOwner(`🚨 **ANTI-NUKE REPEAT ALERT**\nServer: **${guild.name}**\nThe quarantined moderator **${actor.user.tag}** (${actorId}) performed another ${moderationAction.label.toLowerCase()} while their monitored role is removed. Review and confirm whether to ban them.`, [
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`security_ban:${guild.id}:${actorId}`).setLabel('Confirm Ban').setStyle(ButtonStyle.Danger))
      ]);
    }
  } catch (error) {
    console.error('Audit log security handler error:', error);
    await notifyOwner(`⚠️ Bunny Empire security handler error in **${guild?.name || 'unknown server'}**: ${error.message}`);
  }
});

client.on(Events.GuildCreate, async guild => {
  await notifyOwner(`🚨 **BUNNY EMPIRE BOT ADDED TO A SERVER**\nServer: **${guild.name}** (${guild.id})\nMembers: **${guild.memberCount ?? 'Unknown'}**\nPlease confirm this server is authorized.`);
});

client.once(Events.ClientReady, async readyClient => {
  console.log(`Bunny Empire Official Bot ready as ${readyClient.user.tag}`);
  readyClient.user.setPresence({ activities: [{ name: 'POWERED BY BUNNY EMPIRE', type: ActivityType.Playing }], status: 'online' });
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands.map(c => c.data.toJSON()) });
  console.log(`Registered ${commands.length} Bunny Empire slash commands.`);
  for (const record of Object.values(db.quarantines)) await restoreQuarantine(record);
  await notifyOwner(`✅ **Bunny Empire Official Bot is online.**\nServers connected: **${readyClient.guilds.cache.size}**\nCommands registered: **${commands.length}**`);
});

const web = express();
web.get('/health', (_req, res) => res.json({ status: 'ok', bot: client.isReady(), name: 'Bunny Empire Official Bot', poweredBy: 'Bunny Empire' }));
web.listen(PORT, '0.0.0.0', () => console.log(`Health server listening on ${PORT}`));
client.login(TOKEN);
