const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { REST } = require('discord.js');
const { Routes } = require('discord.js');
const dotenv = require('dotenv');
const axios = require('axios');
const express = require('express');
const fs = require('fs');
const path = require('path');

dotenv.config();

// Express server for webhook
const app = express();
app.use(express.json());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Data persistence
const DATA_DIR = path.join(__dirname, 'data');
const QUESTS_FILE = path.join(DATA_DIR, 'known_quests.json');
const GUILDS_FILE = path.join(DATA_DIR, 'guild_settings.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Track known quests to detect new ones
let knownQuests = new Map();
let guildSettings = new Map(); // { guildId: { channelId: '...' } }
let scanInterval;

const SCAN_INTERVAL = process.env.SCAN_INTERVAL || 60000; // 1 minute default

// Load persistent data
function loadData() {
  try {
    if (fs.existsSync(QUESTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUESTS_FILE, 'utf-8'));
      knownQuests = new Map(data);
      console.log(`✅ Loaded ${knownQuests.size} known quests from file`);
    }
  } catch (error) {
    console.error('⚠️  Error loading quests file:', error.message);
  }

  try {
    if (fs.existsSync(GUILDS_FILE)) {
      const data = JSON.parse(fs.readFileSync(GUILDS_FILE, 'utf-8'));
      guildSettings = new Map(data);
      console.log(`✅ Loaded ${guildSettings.size} guild settings from file`);
    }
  } catch (error) {
    console.error('⚠️  Error loading guild settings file:', error.message);
  }
}

// Save persistent data
function saveData() {
  try {
    fs.writeFileSync(QUESTS_FILE, JSON.stringify(Array.from(knownQuests.entries())), 'utf-8');
    fs.writeFileSync(GUILDS_FILE, JSON.stringify(Array.from(guildSettings.entries())), 'utf-8');
  } catch (error) {
    console.error('❌ Error saving data:', error.message);
  }
}

// Get guild's notification channel
function getGuildChannel(guildId) {
  return guildSettings.get(guildId)?.channelId || process.env.NOTIFICATION_CHANNEL_ID;
}

// Set guild's notification channel
function setGuildChannel(guildId, channelId) {
  if (!guildSettings.has(guildId)) {
    guildSettings.set(guildId, {});
  }
  guildSettings.get(guildId).channelId = channelId;
  saveData();
}

client.once('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  console.log(`🔄 Starting quest scanner with ${SCAN_INTERVAL}ms interval`);
  
  // Load persistent data
  loadData();
  
  // Register slash commands
  registerSlashCommands();
  
  // Start scanning for quests
  startQuestScanner();
});

async function registerSlashCommands() {
  const commands = [
    {
      name: 'setup-channel',
      description: 'Set the channel where quest notifications will be posted',
      options: [
        {
          name: 'channel',
          description: 'The channel to post quest notifications',
          type: 7, // CHANNEL type
          required: true,
        },
        {
          name: 'filter',
          description: 'Filter quests by type (default: all)',
          type: 3, // STRING type
          required: false,
          choices: [
            { name: 'All Quests', value: 'all' },
            { name: 'Orbs Only', value: 'orbs' },
            { name: 'No Orbs', value: 'no_orbs' },
          ],
        },
      ],
      default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    },
    {
      name: 'questpingrole',
      description: 'Set the role to ping when new quests are detected',
      options: [
        {
          name: 'role',
          description: 'The role to ping for new quests',
          type: 8, // ROLE type
          required: true,
        },
      ],
      default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    },
    {
      name: 'serverconfig',
      description: 'Check the current server configuration',
    },
  ];

  // Only add spoofguide if enabled
  if (process.env.ENABLE_SPOOFGUIDE !== 'false') {
    commands.push({
      name: 'spoofguide',
      description: 'Get a guide on how to spoof Discord quests',
    });
  }

  // Add remaining commands
  commands.push(
    {
      name: 'latestquest',
      description: 'Show the latest detected quest',
    },
    {
      name: 'activequests',
      description: 'Show all active quests',
    },
    {
      name: 'help',
      description: 'Show all available commands',
    },
    {
      name: 'stats',
      description: 'Show bot statistics',
    },
    {
      name: 'remove',
      description: 'Remove a channel or ping role',
      options: [
        {
          name: 'type',
          description: 'What to remove',
          type: 3, // STRING type
          required: true,
          choices: [
            { name: 'Remove Channel', value: 'channel' },
            { name: 'Remove Ping Role', value: 'pingrole' },
          ],
        },
        {
          name: 'channel',
          description: 'The channel to remove',
          type: 3, // STRING type for autocomplete
          required: false,
          autocomplete: true,
        },
      ],
      default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    }
  );

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('📝 Registering slash commands...');
    // Register global commands
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (error) {
    console.error('❌ Error registering slash commands:', error);
  }
}

function startQuestScanner() {
  // Periodic scanning
  scanInterval = setInterval(scanForQuests, SCAN_INTERVAL);
}

async function scanForQuests() {
  try {
    console.log('🔍 Scanning for new quests...');
  } catch (error) {
    console.error('❌ Error scanning for quests:', error);
  }
}

// Listen for slash commands
client.on('interactionCreate', async (interaction) => {
  // Handle autocomplete
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'remove') {
      const focusedOption = interaction.options.getFocused(true);
      
      if (focusedOption.name === 'channel') {
        const type = interaction.options.getString('type');
        
        // Only show channels if type is 'channel'
        if (type === 'channel') {
          const settings = guildSettings.get(interaction.guildId);
          const channels = settings?.channels || [];
          
          const choices = channels.map(ch => ({
            name: `#${interaction.guild?.channels.cache.get(ch.id)?.name || 'unknown'}`,
            value: ch.id
          }));
          
          await interaction.respond(choices.slice(0, 25)); // Max 25 choices
        } else {
          await interaction.respond([]);
        }
      }
    }
    return;
  }

  if (!interaction.isCommand()) return;

  try {
    if (interaction.commandName === 'setup-channel') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return await interaction.reply({
          content: '❌ You need the Manage Guild permission to use this command',
          ephemeral: true,
        });
      }

      const channel = interaction.options.getChannel('channel');
      const filter = interaction.options.getString('filter') || 'all';
      
      if (!guildSettings.has(interaction.guildId)) {
        guildSettings.set(interaction.guildId, {});
      }
      
      // Initialize channels array if it doesn't exist
      if (!guildSettings.get(interaction.guildId).channels) {
        guildSettings.get(interaction.guildId).channels = [];
      }
      
      // Remove if this channel already exists (for update)
      const channels = guildSettings.get(interaction.guildId).channels;
      const existingIndex = channels.findIndex(c => c.id === channel.id);
      if (existingIndex !== -1) {
        channels.splice(existingIndex, 1);
      }
      
      // Add the new channel with filter
      channels.push({
        id: channel.id,
        filter: filter
      });
      
      saveData();

      const filterText = { 'all': 'All Quests', 'orbs': 'Orbs Only', 'no_orbs': 'No Orbs' }[filter];

      const embed = {
        color: 0x5865F2,
        title: '✅ Channel Added',
        description: `<#${channel.id}> has been added to receive quest notifications`,
        fields: [
          {
            name: 'Filter',
            value: filterText,
            inline: true
          }
        ],
        footer: {
          text: 'QuestHunter',
          icon_url: 'https://i.imgur.com/yTgBkjM.png'
        },
        timestamp: new Date().toISOString()
      };

      await interaction.reply({
        embeds: [embed],
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'questpingrole') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return await interaction.reply({
          content: '❌ You need the Manage Guild permission to use this command',
          ephemeral: true,
        });
      }

      const role = interaction.options.getRole('role');
      
      if (!guildSettings.has(interaction.guildId)) {
        guildSettings.set(interaction.guildId, {});
      }
      guildSettings.get(interaction.guildId).questPingRoleId = role.id;
      saveData();

      const embed = {
        color: 0x5865F2,
        title: '✅ Ping Role Set',
        description: `The role <@&${role.id}> will now be mentioned when new quests are detected`,
        fields: [
          {
            name: 'Role',
            value: `<@&${role.id}>`,
            inline: true
          }
        ],
        footer: {
          text: 'QuestHunter',
          icon_url: 'https://i.imgur.com/yTgBkjM.png'
        },
        timestamp: new Date().toISOString()
      };

      await interaction.reply({
        embeds: [embed],
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'serverconfig') {
      const settings = guildSettings.get(interaction.guildId);
      const pingRoleId = settings?.questPingRoleId;
      const channels = settings?.channels || [];

      const fields = [];
      
      if (channels.length === 0) {
        fields.push({
          name: '📍 Notification Channels',
          value: 'Not configured',
          inline: false
        });
      } else {
        const channelList = channels.map((ch, idx) => {
          const filterText = { 'all': 'All Quests', 'orbs': 'Orbs Only', 'no_orbs': 'No Orbs' }[ch.filter];
          return `${idx + 1}. <#${ch.id}> - ${filterText}`;
        }).join('\n');
        fields.push({
          name: '📍 Notification Channels',
          value: channelList,
          inline: false
        });
      }
      
      fields.push({
        name: '📢 Quest Ping Role',
        value: pingRoleId ? `<@&${pingRoleId}>` : 'Not configured',
        inline: false
      });

      const embed = {
        color: 0x5865F2,
        title: '📋 Server Configuration',
        description: 'Current settings for QuestHunter',
        fields: fields,
        footer: {
          text: 'QuestHunter',
          icon_url: 'https://i.imgur.com/yTgBkjM.png'
        },
        timestamp: new Date().toISOString()
      };

      await interaction.reply({
        embeds: [embed],
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'spoofguide') {
      // Check if spoofguide is enabled
      if (process.env.ENABLE_SPOOFGUIDE === 'false') {
        await interaction.reply({
          content: '❌ This command is currently disabled.',
          ephemeral: true,
        });
        return;
      }

      const guide = `**📖 How to Spoof Discord Quests - QuestPhantom Guide**

**⚙️ Installation Steps:**

1. **Open Discord Desktop App** (not the web version - this is IMPORTANT!)
2. **Press \`Ctrl+Shift+I\`** (Windows) or **\`Cmd+Option+I\`** (Mac)
3. **Click on the "Console" tab**
4. **Copy the entire script** from: https://raw.githubusercontent.com/SimpliAj/QuestPhantom/refs/heads/main/main.js
5. **Paste** it into the console
6. **Press Enter** to execute

**📌 Important Notes:**

⚠️ **Use at your own risk** - This violates Discord's Terms of Service
🚫 Discord may detect and ban accounts using this method
🎮 Game quests only work on the **Discord Desktop App**
👆 **Manually activate quests** in your quest menu first
🔍 Keep the console open while the script runs
✅ The script will auto-complete all active quests

**📖 Full Documentation:**
https://github.com/SimpliAj/QuestPhantom/blob/main/README.md

**🎯 Quest Types Supported:**
- WATCH_VIDEO (Video quests)
- WATCH_VIDEO_ON_MOBILE (Mobile video quests)
- PLAY_ON_DESKTOP (Game quests)
- STREAM_ON_DESKTOP (Streaming quests)
- PLAY_ACTIVITY (Discord Activity quests)`;

      await interaction.reply({
        content: guide,
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'latestquest') {
      if (knownQuests.size === 0) {
        return await interaction.reply({
          content: '❌ No quests detected yet.',
          ephemeral: true,
        });
      }

      // Get the most recently detected quest (by detectedAt timestamp)
      const lastQuest = Array.from(knownQuests.values()).sort((a, b) => {
        const timeA = new Date(a.detectedAt || 0).getTime();
        const timeB = new Date(b.detectedAt || 0).getTime();
        return timeB - timeA; // Sort descending (newest first)
      })[0];

      const questLink = `https://discord.com/quests/${lastQuest.id}`;

      await interaction.reply({ 
        content: questLink, 
        ephemeral: true 
      });
    }

    if (interaction.commandName === 'activequests') {
      if (knownQuests.size === 0) {
        return await interaction.reply({
          content: '❌ No quests tracked yet.',
          ephemeral: true,
        });
      }

      const quests = Array.from(knownQuests.values());
      const questLinks = quests.map((q, i) => `${i + 1}. https://discord.com/quests/${q.id}`).join('\n');

      await interaction.reply({ 
        content: `📋 **Active Quests (${quests.length} total)**\n\n${questLinks}`, 
        ephemeral: true 
      });
    }

    if (interaction.commandName === 'help') {
      const helpEmbed = {
        color: 0x5865F2,
        title: '❓ QuestHunter Commands',
        description: 'All available commands for QuestHunter',
        fields: [
          {
            name: '⚙️ Admin Commands',
            value: '`/setup-channel` - Add a channel for quest notifications\n`/questpingrole` - Set a role to mention for quests\n`/remove` - Remove a channel or ping role',
            inline: false
          },
          {
            name: '📋 Info Commands',
            value: '`/serverconfig` - View server configuration\n`/help` - Show this message\n`/stats` - View bot statistics',
            inline: false
          },
          {
            name: '🎯 Quest Commands',
            value: '`/latestquest` - Show latest detected quest\n`/activequests` - List all active quests\n`/spoofguide` - Get QuestPhantom guide',
            inline: false
          },
          {
            name: '🗳️ Support QuestHunter',
            value: '[Vote on top.gg](https://top.gg/de/bot/1474123878002462801/vote)',
            inline: false
          }
        ],
        footer: {
          text: 'QuestHunter',
          icon_url: 'https://i.imgur.com/yTgBkjM.png'
        },
        timestamp: new Date().toISOString()
      };

      await interaction.reply({
        embeds: [helpEmbed],
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'stats') {
      const totalServers = guildSettings.size;
      const totalChannels = Array.from(guildSettings.values()).reduce((sum, settings) => sum + (settings.channels?.length || 0), 0);
      const totalQuests = knownQuests.size;

      const statsEmbed = {
        color: 0x5865F2,
        title: '📊 Bot Statistics',
        description: 'QuestHunter Performance Metrics',
        fields: [
          {
            name: '🌐 Servers',
            value: totalServers.toString(),
            inline: true
          },
          {
            name: '📍 Configured Channels',
            value: totalChannels.toString(),
            inline: true
          },
          {
            name: '📋 Tracked Quests',
            value: totalQuests.toString(),
            inline: true
          },
          {
            name: '⏱️ Scan Interval',
            value: `${Math.round(process.env.SCRAPER_INTERVAL / 60000)} minutes`,
            inline: true
          },
          {
            name: '🤖 Bot Version',
            value: 'v1.0.0',
            inline: true
          },
          {
            name: '📡 Status',
            value: '🟢 Online',
            inline: true
          }
        ],
        footer: {
          text: 'QuestHunter',
          icon_url: 'https://i.imgur.com/yTgBkjM.png'
        },
        timestamp: new Date().toISOString()
      };

      await interaction.reply({
        embeds: [statsEmbed],
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'remove') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return await interaction.reply({
          content: '❌ You need the Manage Guild permission to use this command',
          ephemeral: true,
        });
      }

      const type = interaction.options.getString('type');
      const settings = guildSettings.get(interaction.guildId);

      if (type === 'channel') {
        const channelId = interaction.options.getString('channel');
        if (!channelId) {
          return await interaction.reply({
            content: '❌ Please specify a channel to remove',
            ephemeral: true,
          });
        }

        const channels = settings?.channels || [];
        const channelIndex = channels.findIndex(c => c.id === channelId);

        if (channelIndex === -1) {
          return await interaction.reply({
            content: `❌ <#${channelId}> is not configured for quest notifications`,
            ephemeral: true,
          });
        }

        channels.splice(channelIndex, 1);
        saveData();

        const embed = {
          color: 0x5865F2,
          title: '✅ Channel Removed',
          description: `<#${channelId}> has been removed from quest notifications`,
          footer: {
            text: 'QuestHunter',
            icon_url: 'https://i.imgur.com/yTgBkjM.png'
          },
          timestamp: new Date().toISOString()
        };

        await interaction.reply({
          embeds: [embed],
          ephemeral: true,
        });
      } else if (type === 'pingrole') {
        if (!settings?.questPingRoleId) {
          return await interaction.reply({
            content: '❌ No ping role is currently configured',
            ephemeral: true,
          });
        }

        const roleId = settings.questPingRoleId;
        delete settings.questPingRoleId;
        saveData();

        const embed = {
          color: 0x5865F2,
          title: '✅ Ping Role Removed',
          description: `The quest ping role has been removed`,
          footer: {
            text: 'QuestHunter',
            icon_url: 'https://i.imgur.com/yTgBkjM.png'
          },
          timestamp: new Date().toISOString()
        };

        await interaction.reply({
          embeds: [embed],
          ephemeral: true,
        });
      }
    }
  } catch (error) {
    console.error('❌ Error handling slash command:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '❌ Error processing your request',
          ephemeral: true,
        });
      }
    } catch (replyError) {
      console.error('❌ Failed to send error reply:', replyError);
    }
  }
});

async function notifyNewQuest(channelId, questData, guildId, questFilter = 'all') {
  try {
    console.log(`  📤 Attempting to send to channel ${channelId} with filter: ${questFilter}`);
    
    const channel = await client.channels.fetch(channelId);
    
    if (!channel) {
      console.error(`  ❌ Channel ${channelId} not found`);
      return;
    }
    
    // Check if quest matches the filter
    const hasOrbs = questData.reward && questData.reward.includes('Orbs');
    
    if (questFilter === 'orbs' && !hasOrbs) {
      console.log(`  ⏭️  Skipping - quest has no orbs (channel filter: Orbs Only)`);
      return;
    }
    
    if (questFilter === 'no_orbs' && hasOrbs) {
      console.log(`  ⏭️  Skipping - quest has orbs (channel filter: No Orbs)`);
      return;
    }
    
    // Create message with quest link - Discord will auto-embed it
    const questLink = `https://discord.com/quests/${questData.id}`;
    
    // Get the quest ping role if set for this guild
    let pingContent = '🎯 New quest detected!\n';
    if (guildId) {
      const questPingRoleId = guildSettings.get(guildId)?.questPingRoleId;
      if (questPingRoleId) {
        pingContent += `<@&${questPingRoleId}>\n`;
      }
    }
    
    const message = await channel.send(pingContent + questLink);
    
    console.log(`  ✅ Sent to <#${channelId}>`);
    
    // Track this quest
    knownQuests.set(questData.id, {
      id: questData.id,
      name: questData.name,
      reward: questData.reward,
      type: questData.type,
      buttonLabel: questData.buttonLabel,
      expiresAt: questData.expiresAt,
      detectedAt: questData.detectedAt || new Date().toLocaleString(),
      messageId: message.id,
      notified: true,
    });
    
    // Save data after adding quest
    saveData();
    
  } catch (error) {
    console.error(`  ❌ Error sending to channel ${channelId}:`, error.message);
  }
}

// Handle button interactions
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  
  try {
    if (interaction.customId === 'inject_script') {
      await interaction.reply({
        content: `✅ **QuestPhantom Script - Auto Complete Discord Quests**

**How to use:**

1. **Open Discord Desktop App** (not the web version - this is IMPORTANT!)
2. **Press \`Ctrl+Shift+I\`** (Windows) or **\`Cmd+Option+I\`** (Mac) to open Developer Tools
3. **Click on the "Console" tab**
4. **Copy the entire script** from here: https://raw.githubusercontent.com/SimpliAj/QuestPhantom/refs/heads/main/main.js
5. **Paste** the script into the console and press **Enter**
6. **The script will auto-complete all your active quests!**

**Important Notes:**
- ⚠️ **Use at your own risk** - This violates Discord's ToS and can result in account suspension
- 🎮 Game quests only work on the **Discord Desktop App**
- 👆 **Manually activate quests** in your quest menu first
- 🔍 Keep the console open while the script runs
- 📌 Check the full README here: https://github.com/SimpliAj/QuestPhantom/blob/main/README.md`,
        ephemeral: true,
      });
      return;
    }
    
  } catch (error) {
    console.error('❌ Error handling interaction:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '❌ Error processing your request. Please try again.',
          ephemeral: true,
        });
      }
    } catch (replyError) {
      console.error('❌ Failed to send error reply:', replyError);
    }
  }
});

function getQuestScript() {
  return `delete window.$;
let wpRequire = webpackChunkdiscord_app.push([[Symbol()], {}, r => r]);
webpackChunkdiscord_app.pop();

let ApplicationStreamingStore = Object.values(wpRequire.c).find(x => x?.exports?.Z?.__proto__?.getStreamerActiveStreamMetadata)?.exports?.Z;
let RunningGameStore, QuestsStore, ChannelStore, GuildChannelStore, FluxDispatcher, api;

if(!ApplicationStreamingStore) {
  ApplicationStreamingStore = Object.values(wpRequire.c).find(x => x?.exports?.A?.__proto__?.getStreamerActiveStreamMetadata)?.exports?.A;
  RunningGameStore = Object.values(wpRequire.c).find(x => x?.exports?.Ay?.getRunningGames)?.exports?.Ay;
  QuestsStore = Object.values(wpRequire.c).find(x => x?.exports?.A?.__proto__?.getQuest)?.exports?.A;
  ChannelStore = Object.values(wpRequire.c).find(x => x?.exports?.A?.__proto__?.getAllThreadsForParent)?.exports?.A;
  GuildChannelStore = Object.values(wpRequire.c).find(x => x?.exports?.Ay?.getSFWDefaultChannel)?.exports?.Ay;
  FluxDispatcher = Object.values(wpRequire.c).find(x => x?.exports?.h?.__proto__?.flushWaitQueue)?.exports?.h;
  api = Object.values(wpRequire.c).find(x => x?.exports?.Bo?.get)?.exports?.Bo;
} else {
  RunningGameStore = Object.values(wpRequire.c).find(x => x?.exports?.ZP?.getRunningGames)?.exports?.ZP;
  QuestsStore = Object.values(wpRequire.c).find(x => x?.exports?.Z?.__proto__?.getQuest)?.exports?.Z;
  ChannelStore = Object.values(wpRequire.c).find(x => x?.exports?.Z?.__proto__?.getAllThreadsForParent)?.exports?.Z;
  GuildChannelStore = Object.values(wpRequire.c).find(x => x?.exports?.ZP?.getSFWDefaultChannel)?.exports?.ZP;
  FluxDispatcher = Object.values(wpRequire.c).find(x => x?.exports?.Z?.__proto__?.flushWaitQueue)?.exports?.Z;
  api = Object.values(wpRequire.c).find(x => x?.exports?.tn?.get)?.exports?.tn;
}

const supportedTasks = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"];
let allQuests = QuestsStore?.quests ? [...QuestsStore?.quests.values()].filter(x => x.id !== "1412491570820812933" && x.userStatus?.enrolledAt && !x.userStatus?.completedAt && new Date(x.config.expiresAt).getTime() > Date.now() && supportedTasks.find(y => Object.keys((x.config.taskConfig ?? x.config.taskConfigV2).tasks).includes(y))) : [];

if(!QuestsStore) {
  console.log("❌ QuestsStore not found! Cannot proceed.");
} else if(!allQuests || allQuests.length === 0) {
  console.log("ℹ️ You don't have any uncompleted quests!");
} else {
  console.log("✅ Found " + allQuests.length + " active quest(s). Starting to process them...");
}`;
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down bot...');
  saveData();
  if (scanInterval) clearInterval(scanInterval);
  client.destroy();
  process.exit(0);
});

// Webhook endpoint to receive quest data
app.post('/webhook/quests', async (req, res) => {
  try {
    const { quests } = req.body;
    
    if (!quests || quests.length === 0) {
      return res.status(400).json({ error: 'No quests provided' });
    }
    
    console.log(`\n📥 Received ${quests.length} quest(s) from scraper`);
    
    // Get the first configured guild (or use all)
    let targetGuildId = null;
    for (const [guildId, settings] of guildSettings) {
      if (settings.channels && settings.channels.length > 0) {
        targetGuildId = guildId;
        break;
      }
    }
    
    // Process each quest
    let newQuestCount = 0;
    for (const quest of quests) {
      // Check if this is a truly new quest
      if (!knownQuests.has(quest.id)) {
        newQuestCount++;
        console.log(`  🆕 NEW: ${quest.name} (${quest.reward}, Expires: ${quest.expiresAt})`);
        
        try {
          if (targetGuildId) {
            // Get all configured channels for this guild
            const guildChannels = guildSettings.get(targetGuildId)?.channels || [];
            
            if (guildChannels.length > 0) {
              // Send to all configured channels with matching filters
              for (const ch of guildChannels) {
                try {
                  await notifyNewQuest(ch.id, quest, targetGuildId, ch.filter);
                } catch (chError) {
                  console.error(`⚠️  Error sending to channel ${ch.id}:`, chError.message);
                }
              }
            }
          } else {
            // Fallback to default channel if configured
            const defaultChannelId = process.env.NOTIFICATION_CHANNEL_ID;
            if (defaultChannelId) {
              try {
                const channel = await client.channels.fetch(defaultChannelId);
                const guildId = channel.guildId;
                await notifyNewQuest(defaultChannelId, quest, guildId, 'all');
              } catch (err) {
                console.error(`⚠️  Could not use default channel:`, err.message);
              }
            }
          }
        } catch (error) {
          console.error(`⚠️  Could not send notification for quest ${quest.id}:`, error.message);
        }
      } else {
        console.log(`  ℹ️  EXISTING: ${quest.name}`);
      }
      
      // Always update the quest data
      knownQuests.set(quest.id, {
        id: quest.id,
        name: quest.name,
        reward: quest.reward,
        type: quest.type,
        buttonLabel: quest.buttonLabel,
        expiresAt: quest.expiresAt,
        detectedAt: quest.detectedAt || new Date().toLocaleString(),
      });
    }
    
    // Save data after processing
    saveData();
    
    console.log(`✅ Processed ${quests.length} quests (${newQuestCount} new)\n`);
    
    res.status(200).json({ 
      success: true, 
      processed: quests.length, 
      newQuests: newQuestCount,
      totalTracked: knownQuests.size
    });
    
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'Bot is running', timestamp: new Date() });
});

// Start Express server
const PORT = process.env.WEBHOOK_PORT || 3001;
app.listen(PORT, () => {
  console.log(`🌐 Webhook server running on http://localhost:${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);
