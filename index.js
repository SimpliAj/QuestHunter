const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, ActivityType, MessageFlags } = require('discord.js');
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
  ],
});

// Data persistence
const DATA_DIR = path.join(__dirname, 'data');
const QUESTS_FILE = path.join(DATA_DIR, 'known_quests.json');
const EXPIRED_QUESTS_FILE = path.join(DATA_DIR, 'expired_quests.json');
const GUILDS_FILE = path.join(DATA_DIR, 'guild_settings.json');
const USER_PREFS_FILE = path.join(DATA_DIR, 'user_preferences.json');
const SHARED_CODES_FILE = path.join(DATA_DIR, 'shared_codes.json');

// Channel ID for sharing codes
const SHARE_CHANNEL_ID = process.env.SHARE_CHANNEL_ID || '1478482005598539959';

// Track shared codes for button persistence
let sharedCodes = new Map(); // { messageId: { questId, questName, code, sharedBy, sharedAt } }

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Track known quests to detect new ones
let knownQuests = new Map();
let expiredQuests = new Map();
let guildSettings = new Map(); // { guildId: { channelId: '...' } }
let userPreferences = new Map(); // { userId: { dmNotifications: boolean } }
let scanInterval;
let botReady = false; // Flag to prevent sending notifications during startup
let paginationState = new Map(); // Track pagination state: messageId -> { page, totalPages, quests }

const SCAN_INTERVAL = process.env.SCAN_INTERVAL || 60000; // 1 minute default

// Version from environment variable
const BOT_VERSION = process.env.BOT_VERSION || '1.0.0'; // Get from .env or use fallback
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '774679828594163802'; // Admin user ID from .env

// Load persistent data
function loadData() {
  try {
    if (fs.existsSync(QUESTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUESTS_FILE, 'utf-8'));
      knownQuests = new Map(data);
      console.log(`✅ Loaded ${knownQuests.size} active quests from file`);
    }
  } catch (error) {
    console.error('⚠️  Error loading quests file:', error.message);
  }

  try {
    if (fs.existsSync(EXPIRED_QUESTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(EXPIRED_QUESTS_FILE, 'utf-8'));
      expiredQuests = new Map(data);
      console.log(`✅ Loaded ${expiredQuests.size} expired quests from file`);
    }
  } catch (error) {
    console.error('⚠️  Error loading expired quests file:', error.message);
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

  try {
    if (fs.existsSync(USER_PREFS_FILE)) {
      const data = JSON.parse(fs.readFileSync(USER_PREFS_FILE, 'utf-8'));
      userPreferences = new Map(data);
      console.log(`✅ Loaded ${userPreferences.size} user preferences from file`);
    }
  } catch (error) {
    console.error('⚠️  Error loading user preferences file:', error.message);
  }

  try {
    if (fs.existsSync(SHARED_CODES_FILE)) {
      const data = JSON.parse(fs.readFileSync(SHARED_CODES_FILE, 'utf-8'));
      sharedCodes = new Map(data);
      console.log(`✅ Loaded ${sharedCodes.size} shared codes from file`);
    }
  } catch (error) {
    console.error('⚠️  Error loading shared codes file:', error.message);
  }
}

// Save persistent data
function saveData() {
  try {
    fs.writeFileSync(QUESTS_FILE, JSON.stringify(Array.from(knownQuests.entries())), 'utf-8');
    fs.writeFileSync(EXPIRED_QUESTS_FILE, JSON.stringify(Array.from(expiredQuests.entries())), 'utf-8');
    fs.writeFileSync(GUILDS_FILE, JSON.stringify(Array.from(guildSettings.entries())), 'utf-8');
    fs.writeFileSync(USER_PREFS_FILE, JSON.stringify(Array.from(userPreferences.entries())), 'utf-8');
    fs.writeFileSync(SHARED_CODES_FILE, JSON.stringify(Array.from(sharedCodes.entries())), 'utf-8');
  } catch (error) {
    console.error('❌ Error saving data:', error.message);
  }
}

// Get guild's notification channel
function getGuildChannel(guildId) {
  return guildSettings.get(guildId)?.channelId || process.env.NOTIFICATION_CHANNEL_ID;
}

// Format date from MM/DD or MM/DD/YYYY to DD.MM. (without year for current year)
function formatDate(dateStr) {
  if (!dateStr || dateStr === 'Unknown' || dateStr === 'Deleted by Discord') {
    return dateStr;
  }
  
  // Input format: MM/DD or MM/DD/YYYY
  const parts = dateStr.split('/');
  if (parts.length === 2) {
    // MM/DD - no year
    const month = parts[0];
    const day = parts[1];
    return `${day}.${month}.`;
  } else if (parts.length === 3) {
    // MM/DD/YYYY - with year
    const month = parts[0];
    const day = parts[1];
    const year = parts[2];
    // Only show year if it's NOT the current year (2026)
    if (year !== '2026') {
      return `${day}.${month}.${year}`;
    }
    return `${day}.${month}.`;
  }
  
  return dateStr;
}

// Set guild's notification channel
function setGuildChannel(guildId, channelId) {
  if (!guildSettings.has(guildId)) {
    guildSettings.set(guildId, {});
  }
  guildSettings.get(guildId).channelId = channelId;
  saveData();
}

// Check permissions when bot joins a guild
client.on('guildCreate', async (guild) => {
  try {
    console.log(`🆕 Bot joined guild: ${guild.name}`);
    
    // Get the guild owner
    const owner = await guild.fetchOwner();
    
    // Required permissions for the bot
    const requiredPermissions = [
      'SendMessages',
      'EmbedLinks',
      'ReadMessageHistory'
    ];
    
    // Check which permissions are missing
    const botMember = guild.members.me;
    const missingPermissions = requiredPermissions.filter(perm => !botMember.permissions.has(perm));
    
    if (missingPermissions.length > 0) {
      // Send DM to guild owner
      try {
        const dmEmbed = {
          color: 0xFF0000,
          title: '⚠️ Missing Bot Permissions',
          description: `QuestHunter is missing the following permissions in **${guild.name}**:`,
          fields: [
            {
              name: 'Missing Permissions',
              value: missingPermissions.map(p => `• ${p}`).join('\n'),
              inline: false
            },
            {
              name: '🔧 How to Fix',
              value: `1. Go to Server Settings → Roles\n2. Find the **QuestHunter** role\n3. Enable the missing permissions\n4. The bot will work once permissions are granted`,
              inline: false
            }
          ],
          footer: {
            text: 'QuestHunter',
            icon_url: 'https://i.imgur.com/yTgBkjM.png'
          },
          timestamp: new Date().toISOString()
        };
        
        await owner.send({ embeds: [dmEmbed] });
        console.log(`📨 Sent permission warning DM to ${owner.user.tag}`);
      } catch (dmError) {
        console.error(`⚠️ Could not send DM to ${owner.user.tag}:`, dmError.message);
      }
    } else {
      console.log(`✅ All permissions OK in ${guild.name}`);
    }
  } catch (error) {
    console.error('❌ Error checking guild permissions:', error);
  }
});

client.once('ready', () => {
  // Load persistent data when bot is ready
  loadData();
  
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  console.log(`🔄 Starting quest scanner with ${SCAN_INTERVAL}ms interval`);
  
  // Set bot status to watching quests
  client.user.setPresence({
    activities: [
      {
        name: 'Searching for quests',
        type: ActivityType.Streaming
      }
    ],
    status: 'online'
  });
  
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
    {
      name: 'setup-expired-channel',
      description: 'Set the channel for expired quest notifications',
      options: [
        {
          name: 'channel',
          description: 'The channel to post expired quest alerts',
          type: 7, // CHANNEL type
          required: true,
        },
      ],
      default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    },
    {
      name: 'expiredquests',
      description: 'View all expired quests',
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
      description: 'Show all active quests with pagination',
      options: [
        {
          name: 'filter',
          description: 'Filter quests by reward type (optional)',
          type: 3, // STRING type
          required: false,
          choices: [
            { name: 'All Quests', value: 'all' },
            { name: 'Orbs Only', value: 'orbs' },
            { name: 'Decorations Only', value: 'decorations' },
            { name: 'Game Items Only', value: 'items' },
          ],
        },
      ],
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
      name: 'announce',
      description: 'Broadcast an announcement to all configured guild channels (Admin only)',
      options: [
        {
          name: 'title',
          description: 'Announcement title',
          type: 3, // STRING type
          required: true,
        },
        {
          name: 'message',
          description: 'Announcement message',
          type: 3, // STRING type
          required: true,
        },
      ],
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
    },
    {
      name: 'feedback',
      description: 'Submit a bug report or feature request',
      options: [
        {
          name: 'type',
          description: 'Type of feedback',
          type: 3, // STRING type
          required: true,
          choices: [
            { name: '🐛 Bug Report', value: 'bug' },
            { name: '💡 Feature Request', value: 'feature' },
          ],
        },
        {
          name: 'message',
          description: 'Your feedback message',
          type: 3, // STRING type
          required: true,
        },
      ],
    },
    {
      name: 'dm-notifications',
      description: 'Configure DM notifications for new quests',
      options: [
        {
          name: 'filter',
          description: 'Filter which quests to receive DM notifications for',
          type: 3, // STRING type
          required: true,
          choices: [
            { name: 'All Quests', value: 'all' },
            { name: 'Orbs Only', value: 'orbs' },
            { name: 'Decorations Only', value: 'decorations' },
            { name: 'Game Items Only', value: 'items' },
            { name: 'Disabled', value: 'disabled' },
          ],
        },
      ],
    },
    {
      name: 'share',
      description: 'Share game codes or items from active quests',
      options: [
        {
          name: 'quest',
          description: 'Select the quest for the game code',
          type: 3, // STRING type for autocomplete
          required: true,
          autocomplete: true,
        },
        {
          name: 'code',
          description: 'The game code or reward to share',
          type: 3, // STRING type
          required: true,
        },
      ],
    }
  );

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('📝 Registering slash commands...');
    // Register global commands
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands registered');
    
    // Mark bot as ready to receive webhooks and send notifications
    botReady = true;
    console.log('🟢 Bot is fully initialized and ready to send quest notifications');
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
    } else if (interaction.commandName === 'share') {
      const focusedOption = interaction.options.getFocused(true);
      
      if (focusedOption.name === 'quest') {
        // Filter quests to only show game items (not Orbs or Profile Decorations)
        const gameItemQuests = Array.from(knownQuests.values()).filter(q => {
          const reward = q.reward?.toLowerCase() || '';
          // Exclude typical non-game items
          return !reward.includes('orb') && !reward.includes('decoration') && !reward.includes('badge');
        });
        
        const choices = gameItemQuests.map(q => ({
          name: `${q.name} - ${q.reward}`.substring(0, 100), // Max 100 chars
          value: q.id
        }));
        
        await interaction.respond(choices.slice(0, 25)); // Max 25 choices
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

      // Check bot permissions
      const botMember = interaction.guild.members.me;
      const requiredPermissions = ['SendMessages', 'EmbedLinks', 'ReadMessageHistory'];
      const missingPermissions = requiredPermissions.filter(perm => !botMember.permissions.has(perm));
      
      if (missingPermissions.length > 0) {
        return await interaction.reply({
          content: `❌ **Bot is missing permissions!**\n\nThe bot needs the following permissions to work:\n${missingPermissions.map(p => `• ${p}`).join('\n')}\n\nPlease give the bot these permissions and try again.`,
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

    if (interaction.commandName === 'setup-expired-channel') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return await interaction.reply({
          content: '❌ You need the Manage Guild permission to use this command',
          ephemeral: true,
        });
      }

      // Check bot permissions
      const botMember = interaction.guild.members.me;
      const requiredPermissions = ['SendMessages', 'EmbedLinks', 'ReadMessageHistory'];
      const missingPermissions = requiredPermissions.filter(perm => !botMember.permissions.has(perm));
      
      if (missingPermissions.length > 0) {
        return await interaction.reply({
          content: `❌ **Bot is missing permissions!**\n\nThe bot needs the following permissions to work:\n${missingPermissions.map(p => `• ${p}`).join('\n')}\n\nPlease give the bot these permissions and try again.`,
          ephemeral: true,
        });
      }

      const channel = interaction.options.getChannel('channel');
      
      if (!guildSettings.has(interaction.guildId)) {
        guildSettings.set(interaction.guildId, {});
      }
      
      guildSettings.get(interaction.guildId).expiredChannelId = channel.id;
      saveData();

      const embed = {
        color: 0x5865F2,
        title: '✅ Expired Quest Channel Set',
        description: `<#${channel.id}> will now receive notifications when quests expire`,
        fields: [
          {
            name: 'Channel',
            value: `<#${channel.id}>`,
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
      const expiredChannelId = settings?.expiredChannelId;
      const channels = settings?.channels || [];

      const fields = [];
      
      // Notification Channels
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
      
      // Quest Ping Role
      fields.push({
        name: '📢 Quest Ping Role',
        value: pingRoleId ? `<@&${pingRoleId}>` : 'Not configured',
        inline: false
      });

      // Expired Quest Channel
      fields.push({
        name: '🗑️ Expired Quest Channel',
        value: expiredChannelId ? `<#${expiredChannelId}>` : 'Not configured',
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

      // Get the most recently added quest (by detectedAt timestamp - most recent first)
      const lastQuest = Array.from(knownQuests.values()).sort((a, b) => {
        const timeA = new Date(a.detectedAt || 0).getTime();
        const timeB = new Date(b.detectedAt || 0).getTime();
        return timeB - timeA; // Sort descending (newest first)
      })[0];

      const questLink = `https://discord.com/quests/${lastQuest.id}`;

      await interaction.reply({ 
        content: `**Latest Quest Added**: ${lastQuest.name}\n${questLink}`, 
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

      // Get filter option
      const filterOption = interaction.options.getString('filter') || 'all';
      
      // Filter quests based on option
      let quests = Array.from(knownQuests.values());
      
      if (filterOption !== 'all') {
        quests = quests.filter(quest => {
          const rewardLower = quest.reward?.toLowerCase() || '';
          
          if (filterOption === 'orbs') {
            return rewardLower.includes('orb') || /\d+\s*(discord)?\s*orb/i.test(quest.reward || '');
          } else if (filterOption === 'decorations') {
            return rewardLower.includes('decoration') || rewardLower.includes('dekoration');
          } else if (filterOption === 'items') {
            return quest.reward && !rewardLower.includes('orb') && !rewardLower.includes('decoration') && !rewardLower.includes('dekoration');
          }
          return true;
        });
      }
      
      if (quests.length === 0) {
        const filterText = {
          'orbs': 'Orb',
          'decorations': 'Decoration',
          'items': 'In-Game Item'
        }[filterOption] || 'quest';
        
        return await interaction.reply({
          content: `❌ No active ${filterText} quests found.`,
          ephemeral: true,
        });
      }
      
      // Sort by expiration date (earliest first)
      quests.sort((a, b) => {
        const parseDate = (dateStr) => {
          if (!dateStr || dateStr === 'Unknown') return new Date(0);
          
          // Handle both formats: "3.3." (German) and "3/3" or "3/3/2026" (English)
          let day, month, year = new Date().getFullYear();
          
          if (dateStr.includes('.')) {
            // German format: "3.3." or "3.3"
            const parts = dateStr.split('.');
            if (parts.length < 2) return new Date(0);
            day = parseInt(parts[0]);
            month = parseInt(parts[1]);
          } else if (dateStr.includes('/')) {
            // English format: "3/3" or "3/3/2026" (MM/DD or MM/DD/YYYY)
            const parts = dateStr.split('/');
            if (parts.length < 2) return new Date(0);
            month = parseInt(parts[0]);
            day = parseInt(parts[1]);
            if (parts.length === 3) {
              year = parseInt(parts[2]);
            }
          } else {
            return new Date(0);
          }
          
          return new Date(year, month - 1, day);
        };
        return parseDate(a.expiresAt) - parseDate(b.expiresAt);
      });
      
      const QUESTS_PER_PAGE = 10;
      const totalPages = Math.ceil(quests.length / QUESTS_PER_PAGE);
      
      // Function to create page embed
      function createPageEmbed(pageNum) {
        const startIdx = (pageNum - 1) * QUESTS_PER_PAGE;
        const endIdx = Math.min(startIdx + QUESTS_PER_PAGE, quests.length);
        const pageQuests = quests.slice(startIdx, endIdx);
        
        const questFields = pageQuests.map((q, i) => {
          const globalIdx = startIdx + i + 1;
          const questLink = `https://discord.com/quests/${q.id}`;
          return {
            name: `${globalIdx}. Quest`,
            value: `[${q.name}](${questLink})\nReward: ${q.reward}\nExpires: ${formatDate(q.expiresAt) || 'Unknown'}`,
            inline: false
          };
        });
        
        const filterText = {
          'all': 'All Quests',
          'orbs': 'Orbs Only',
          'decorations': 'Decorations Only',
          'items': 'Game Items Only'
        }[filterOption];
        
        const embed = {
          color: 0x5865F2,
          title: `📋 Active Quests - ${filterText}`,
          description: `Page ${pageNum} of ${totalPages} (${quests.length} total quests)`,
          fields: questFields,
          footer: {
            text: 'QuestHunter',
            icon_url: 'https://i.imgur.com/yTgBkjM.png'
          },
          timestamp: new Date().toISOString()
        };
        
        return embed;
      }
      
      // Create initial embed
      const firstEmbed = createPageEmbed(1);
      
      // Create buttons if there are multiple pages
      let components = [];
      if (totalPages > 1) {
        components = [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`activequests_prev_${interaction.user.id}`)
              .setLabel('← Previous')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId(`activequests_next_${interaction.user.id}`)
              .setLabel('Next →')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`activequests_close_${interaction.user.id}`)
              .setLabel('Close')
              .setStyle(ButtonStyle.Secondary)
          )
        ];
      }
      
      const message = await interaction.reply({
        embeds: [firstEmbed],
        components: components,
        ephemeral: true,
      });
      
      // Store pagination state
      paginationState.set(message.id, {
        page: 1,
        totalPages: totalPages,
        quests: quests,
        createPageEmbed: createPageEmbed,
        userId: interaction.user.id,
        filterOption: filterOption
      });
    }

    if (interaction.commandName === 'expiredquests') {
      if (expiredQuests.size === 0) {
        return await interaction.reply({
          content: '❌ No expired quests tracked yet.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // Sort quests from latest to oldest by expiration date
      const quests = Array.from(expiredQuests.values()).sort((a, b) => {
        // Parse dates - handle both old (DD.MM.) and new (MM/DD or MM/DD/YYYY) formats
        const parseDate = (dateStr) => {
          // Handle special cases - return -Infinity so they sort to the END (descending)
          if (dateStr === 'Deleted by Discord' || dateStr === 'Unknown' || !dateStr) {
            return -Infinity; // Will sort to the end with descending order
          }
          
          // New format: MM/DD or MM/DD/YYYY
          if (dateStr.includes('/')) {
            const parts = dateStr.split('/');
            if (parts.length === 2) {
              const month = parseInt(parts[0]);
              const day = parseInt(parts[1]);
              const year = 2026;
              return new Date(year, month - 1, day).getTime();
            } else if (parts.length === 3) {
              return new Date(dateStr).getTime();
            }
          }
          
          // Old format: DD.MM. or DD.MM
          if (dateStr.includes('.')) {
            const parts = dateStr.split('.');
            if (parts.length >= 2) {
              const day = parseInt(parts[0]);
              const month = parseInt(parts[1]);
              const year = 2026;
              return new Date(year, month - 1, day).getTime();
            }
          }
          
          return -Infinity;
        };
        return parseDate(b.expiresAt) - parseDate(a.expiresAt); // Descending (latest first)
      });
      const QUESTS_PER_PAGE = 20;
      const totalPages = Math.ceil(quests.length / QUESTS_PER_PAGE);
      
      // Function to create page embed
      function createPageEmbed(pageNum) {
        const startIdx = (pageNum - 1) * QUESTS_PER_PAGE;
        const endIdx = Math.min(startIdx + QUESTS_PER_PAGE, quests.length);
        const pageQuests = quests.slice(startIdx, endIdx);
        
        const fields = pageQuests.map((q, i) => {
          let expiryText = formatDate(q.expiresAt);
          if (q.deletedByDiscord) {
            expiryText = "Deleted by Discord";
          }
          const value = `**Reward:** ${q.reward || 'Unknown'}\n**Expired:** ${expiryText}`;
          return {
            name: `${startIdx + i + 1}. ${q.name}`,
            value: value,
            inline: false
          };
        });
        
        const embed = {
          color: 0xFF5733,
          title: '🗑️ Expired Quests',
          description: `Page ${pageNum} of ${totalPages} (${quests.length} total quests)`,
          fields: fields,
          footer: {
            text: 'QuestHunter',
            icon_url: 'https://i.imgur.com/yTgBkjM.png'
          },
          timestamp: new Date().toISOString()
        };
        
        return embed;
      }
      
      // Create initial embed
      const firstEmbed = createPageEmbed(1);
      
      // Create buttons if there are multiple pages
      let components = [];
      if (totalPages > 1) {
        components = [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`expired_prev_${interaction.user.id}`)
              .setLabel('← Previous')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(true), // Disabled on first page
            new ButtonBuilder()
              .setCustomId(`expired_next_${interaction.user.id}`)
              .setLabel('Next →')
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`expired_close_${interaction.user.id}`)
              .setLabel('Close')
              .setStyle(ButtonStyle.Secondary)
          )
        ];
      }
      
      const message = await interaction.reply({
        embeds: [firstEmbed],
        components: components,
        flags: MessageFlags.Ephemeral,
      });
      
      // Store pagination state
      paginationState.set(message.id, {
        page: 1,
        totalPages: totalPages,
        quests: quests,
        createPageEmbed: createPageEmbed,
        userId: interaction.user.id
      });
    }

    if (interaction.commandName === 'help') {
      // Build quest commands field based on spoofguide setting
      let questCommandsValue = '`/latestquest` - Show latest detected quest\n`/activequests` - List all active quests\n`/expiredquests` - List all expired quests';
      
      if (process.env.ENABLE_SPOOFGUIDE !== 'false') {
        questCommandsValue += '\n`/spoofguide` - Get QuestPhantom guide';
      }

      const helpEmbed = {
        color: 0x5865F2,
        title: '❓ QuestHunter Commands',
        description: process.env.ENABLE_SPOOFGUIDE === 'false' 
          ? '✨ QuestHunter is optimized for **QuestPhantom** users\n\nAll available commands for QuestHunter'
          : 'All available commands for QuestHunter',
        fields: [
          {
            name: '⚙️ Admin Commands',
            value: '`/setup-channel` - Add a channel for quest notifications\n`/setup-expired-channel` - Set channel for expired quest notifications\n`/questpingrole` - Set a role to mention for quests\n`/remove` - Remove a channel or ping role',
            inline: false
          },
          {
            name: '📋 Info Commands',
            value: '`/serverconfig` - View server configuration\n`/help` - Show this message\n`/stats` - View bot statistics',
            inline: false
          },
          {
            name: '🎯 Quest Commands',
            value: questCommandsValue,
            inline: false
          },
          {
            name: '🗳️ Support QuestHunter',
            value: '[Vote on top.gg](https://top.gg/de/bot/1474123878002462801/vote)',
            inline: false
          },
          {
            name: '💬 Support Discord',
            value: '[Join our Discord](https://discord.gg/X5YKZBh9xV)',
            inline: false
          },
          {
            name: '💻 Source Code',
            value: '[GitHub Repository](https://github.com/SimpliAj/QuestHunter)',
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
      const totalServers = client.guilds.cache.size;
      const totalChannels = Array.from(guildSettings.values()).reduce((sum, settings) => sum + (settings.channels?.length || 0), 0);
      const totalTrackedQuests = knownQuests.size + expiredQuests.size; // All quests ever
      const activeQuests = knownQuests.size; // Only active quests
      
      // Calculate available orbs, decorations, and game items from ACTIVE quests only
      let availableOrbs = 0;
      let availableDecorations = 0;
      let availableGameItems = 0;
      const gameItemsMap = new Map(); // Track unique game items
      
      for (const quest of knownQuests.values()) {
        const rewardLower = quest.reward?.toLowerCase() || '';
        if (rewardLower.includes('decoration') || rewardLower.includes('dekoration')) {
          availableDecorations++;
        } else if (rewardLower.includes('orb') || /\d+\s*(discord)?\s*orb/i.test(quest.reward || '')) {
          const orbMatch = quest.reward?.match(/(\d+)/);
          if (orbMatch) {
            availableOrbs += parseInt(orbMatch[1]);
          }
        } else if (quest.reward && !rewardLower.includes('orb')) {
          // It's a game item (anything that's not orbs or decorations)
          gameItemsMap.set(quest.reward, (gameItemsMap.get(quest.reward) || 0) + 1);
          availableGameItems++;
        }
      }
      
      // Calculate total tracked orbs, decorations, and game items from ALL quests (active + expired)
      let totalTrackedOrbs = 0;
      let totalTrackedDecorations = 0;
      let totalTrackedGameItems = 0;
      const totalGameItemsMap = new Map();
      
      // Count from active quests
      for (const quest of knownQuests.values()) {
        const rewardLower = quest.reward?.toLowerCase() || '';
        if (rewardLower.includes('decoration') || rewardLower.includes('dekoration')) {
          totalTrackedDecorations++;
        } else if (rewardLower.includes('orb') || /\d+\s*(discord)?\s*orb/i.test(quest.reward || '')) {
          // Extract orb amount from reward string like "700 Discord Orbs" or "200 Discord Orbs"
          const orbMatch = quest.reward?.match(/(\d+)/);
          if (orbMatch) {
            totalTrackedOrbs += parseInt(orbMatch[1]);
          }
        } else if (quest.reward && !rewardLower.includes('orb')) {
          totalGameItemsMap.set(quest.reward, (totalGameItemsMap.get(quest.reward) || 0) + 1);
          totalTrackedGameItems++;
        }
      }
      
      // Also count from expired quests
      for (const [, quest] of expiredQuests) {
        const rewardLower = quest.reward?.toLowerCase() || '';
        if (rewardLower.includes('decoration') || rewardLower.includes('dekoration')) {
          totalTrackedDecorations++;
        } else if (rewardLower.includes('orb') || /\d+\s*(discord)?\s*orb/i.test(quest.reward || '')) {
          // Extract orb amount from reward string like "700 Discord Orbs" or "200 Discord Orbs"
          const orbMatch = quest.reward?.match(/(\d+)/);
          if (orbMatch) {
            totalTrackedOrbs += parseInt(orbMatch[1]);
          }
        } else if (quest.reward && !rewardLower.includes('orb')) {
          totalGameItemsMap.set(quest.reward, (totalGameItemsMap.get(quest.reward) || 0) + 1);
          totalTrackedGameItems++;
        }
      }
      
      const statsEmbed = {
        color: 0x5865F2,
        title: '📊 Bot Statistics',
        description: 'QuestHunter Performance Metrics',
        fields: [
          {
            name: '═══ QUESTS ═══',
            value: '** **',
            inline: false
          },
          {
            name: '✨ Active Quests',
            value: activeQuests.toString(),
            inline: true
          },
          {
            name: '📚 Tracked Quests',
            value: totalTrackedQuests.toString(),
            inline: true
          },
          {
            name: '═══ Available to Earn ═══',
            value: '** **',
            inline: false
          },
          {
            name: '<:orbs:1476345614412288040> Orbs',
            value: availableOrbs.toLocaleString(),
            inline: true
          },
          {
            name: '🎨 Decorations',
            value: availableDecorations.toString(),
            inline: true
          },
          {
            name: '🎮 Game Items',
            value: availableGameItems.toString(),
            inline: true
          },
          {
            name: '═══ Total Tracked ═══',
            value: '** **',
            inline: false
          },
          {
            name: '<:orbs:1476345614412288040> Orbs',
            value: totalTrackedOrbs.toLocaleString(),
            inline: true
          },
          {
            name: '🎨 Decorations',
            value: totalTrackedDecorations.toString(),
            inline: true
          },
          {
            name: '🎮 Game Items',
            value: totalTrackedGameItems.toString(),
            inline: true
          }
        ],
        footer: {
          text: `QuestHunter v${BOT_VERSION} • Helping ${totalServers} Servers`,
          icon_url: 'https://i.imgur.com/yTgBkjM.png'
        },
        timestamp: new Date().toISOString()
      };

      await interaction.reply({
        embeds: [statsEmbed],
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'announce') {
      // Check if user is the admin
      if (interaction.user.id !== ADMIN_USER_ID) {
        return await interaction.reply({
          content: '❌ Only the bot admin can use this command',
          ephemeral: true,
        });
      }

      const title = interaction.options.getString('title');
      const message = interaction.options.getString('message');

      // Create announcement embed
      const announcementEmbed = {
        color: 0x5865F2,
        title: `📢 ${title}`,
        description: message,
        footer: {
          text: 'QuestHunter Announcement',
          icon_url: 'https://i.imgur.com/yTgBkjM.png'
        },
        timestamp: new Date().toISOString()
      };

      // Broadcast to all configured channels
      let broadcastCount = 0;
      const failedChannels = [];

      for (const [guildId, settings] of guildSettings) {
        const guildChannels = settings.channels || [];

        if (guildChannels.length > 0) {
          for (const ch of guildChannels) {
            try {
              const channel = await client.channels.fetch(ch.id);
              if (channel) {
                await channel.send({ embeds: [announcementEmbed] });
                broadcastCount++;
              }
            } catch (error) {
              failedChannels.push(ch.id);
            }
          }
        }
      }

      // Send confirmation
      const confirmEmbed = {
        color: broadcastCount > 0 ? 0x00FF00 : 0xFF0000,
        title: '✅ Announcement Broadcast Complete',
        description: `Successfully sent announcement to **${broadcastCount}** channel(s)`,
        fields: [
          {
            name: 'Title',
            value: title,
            inline: false
          },
          {
            name: 'Message',
            value: message,
            inline: false
          }
        ],
        footer: {
          text: 'QuestHunter Admin',
          icon_url: 'https://i.imgur.com/yTgBkjM.png'
        },
        timestamp: new Date().toISOString()
      };

      await interaction.reply({
        embeds: [confirmEmbed],
        ephemeral: true
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

    if (interaction.commandName === 'feedback') {
      const type = interaction.options.getString('type');
      const message = interaction.options.getString('message');
      const feedbackWebhook = process.env.FEEDBACK_WEBHOOK;

      if (!feedbackWebhook) {
        return await interaction.reply({
          content: '❌ Feedback system is not configured',
          ephemeral: true,
        });
      }

      try {
        const typeEmoji = type === 'bug' ? '🐛' : '💡';
        const typeText = type === 'bug' ? 'Bug Report' : 'Feature Request';
        
        const embed = {
          color: type === 'bug' ? 0xFF0000 : 0x00FF00,
          title: `${typeEmoji} ${typeText}`,
          description: message,
          fields: [
            {
              name: 'User',
              value: `${interaction.user.username}#${interaction.user.discriminator}`,
              inline: true
            },
            {
              name: 'User ID',
              value: interaction.user.id,
              inline: true
            },
            {
              name: 'Server',
              value: interaction.guild?.name || 'DM',
              inline: true
            }
          ],
          footer: {
            text: 'QuestHunter Feedback',
            icon_url: 'https://i.imgur.com/yTgBkjM.png'
          },
          timestamp: new Date().toISOString()
        };

        // Send to webhook
        await axios.post(feedbackWebhook, {
          username: 'Feedback',
          avatar_url: client.user.displayAvatarURL(),
          embeds: [embed]
        });

        const confirmEmbed = {
          color: 0x5865F2,
          title: '✅ Feedback Sent',
          description: `Thank you for your ${typeText.toLowerCase()}! We appreciate your input.`,
          footer: {
            text: 'QuestHunter',
            icon_url: 'https://i.imgur.com/yTgBkjM.png'
          },
          timestamp: new Date().toISOString()
        };

        await interaction.reply({
          embeds: [confirmEmbed],
          ephemeral: true,
        });
      } catch (error) {
        console.error('❌ Error sending feedback:', error.message);
        await interaction.reply({
          content: '❌ Failed to send feedback. Please try again later.',
          ephemeral: true,
        });
      }
    }

    if (interaction.commandName === 'share') {
      const questId = interaction.options.getString('quest');
      const code = interaction.options.getString('code');
      
      // Get quest details
      const quest = knownQuests.get(questId);
      if (!quest) {
        return await interaction.reply({
          content: '❌ Quest not found. Please select a valid quest.',
          ephemeral: true,
        });
      }
      
      const questName = quest.name;
      const questReward = quest.reward || 'Unknown Reward';
      
      // Create the embed for the channel
      const shareEmbed = {
        color: 0x2ECC71, // Green color for sharing
        title: '🎁 Code Shared!',
        description: `**Quest:** ${questName}\n**Reward:** ${questReward}`,
        fields: [
          {
            name: '🔑 Code',
            value: `\`\`\`${code}\`\`\``,
            inline: false
          },
          {
            name: '👤 Shared by',
            value: `${interaction.user.username}#${interaction.user.discriminator}`,
            inline: true
          },
          {
            name: '⏰ Time',
            value: new Date().toLocaleString(),
            inline: true
          }
        ],
        thumbnail: {
          url: interaction.user.displayAvatarURL()
        },
        footer: {
          text: 'QuestHunter Code Share',
          icon_url: 'https://i.imgur.com/yTgBkjM.png'
        },
        timestamp: new Date().toISOString()
      };
      
      try {
        // Send to channel
        const channel = await client.channels.fetch(SHARE_CHANNEL_ID);
        if (channel && channel.isTextBased()) {
          // Create claim button
          const claimButton = new ButtonBuilder()
            .setCustomId(`claim_code_${questId}`)
            .setLabel('🎁 Claim Code')
            .setStyle(ButtonStyle.Success);

          const row = new ActionRowBuilder().addComponents(claimButton);

          const message = await channel.send({ embeds: [shareEmbed], components: [row] });
          
          // Save shared code info for button persistence after restart
          sharedCodes.set(message.id, {
            questId: questId,
            questName: questName,
            code: code,
            sharedBy: `${interaction.user.username}#${interaction.user.discriminator}`,
            sharedAt: new Date().toLocaleString()
          });
          saveData();
        } else {
          throw new Error('Channel not found or is not a text channel');
        }
        
        // Confirm to user
        const confirmEmbed = {
          color: 0x2ECC71,
          title: '✅ Code Shared Successfully',
          description: `Your code for **${questName}** has been shared with the community!\n\n[Join our Discord](https://discord.gg/X5YKZBh9xV) to see shared codes and connect with other players!`,
          fields: [
            {
              name: '🔑 Shared Code',
              value: `\`\`\`${code}\`\`\``,
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
          embeds: [confirmEmbed],
          ephemeral: true,
        });
        
        console.log(`✅ Code shared for quest "${questName}" by ${interaction.user.tag}`);
      } catch (error) {
        console.error('❌ Error sharing code:', error.message);
        await interaction.reply({
          content: '❌ Failed to share code. Please try again later.',
          ephemeral: true,
        });
      }
    }

    if (interaction.commandName === 'dm-notifications') {
      const userId = interaction.user.id;
      const filterOption = interaction.options.getString('filter');
      
      const userPrefs = userPreferences.get(userId) || { dmNotifications: false, dmFilter: 'all' };
      
      // Update preferences
      if (filterOption === 'disabled') {
        userPrefs.dmNotifications = false;
        userPrefs.dmFilter = 'all'; // Reset filter when disabled
      } else {
        userPrefs.dmNotifications = true;
        userPrefs.dmFilter = filterOption;
      }
      
      userPreferences.set(userId, userPrefs);
      saveData();
      
      // Get filter text
      const filterText = {
        'all': 'All Quests',
        'orbs': 'Orbs Only',
        'decorations': 'Decorations Only',
        'items': 'Game Items Only',
        'disabled': 'Disabled'
      }[filterOption];
      
      const embed = {
        color: 0x5865F2,
        title: '💬 DM Notifications',
        description: `Direct message notifications for new quests have been configured.`,
        fields: [
          {
            name: 'Status',
            value: filterOption === 'disabled' ? '❌ **DISABLED**' : '✅ **ENABLED**',
            inline: false
          },
          {
            name: 'Filter',
            value: filterText,
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
        embeds: [embed],
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'dm-notifications-old') {
      // This is the old button-based handler - kept for backward compatibility with existing buttons
      // New users will use the command above instead
      const userId = interaction.user.id;
      
      // Check if the button was pressed by the user who initiated the command
      if (interaction.user.id !== userId) {
        return await interaction.reply({
          content: '❌ Only the user who initiated this command can use these buttons',
          ephemeral: true,
        });
      }

      // Toggle the setting
      const userPrefs = userPreferences.get(userId) || { dmNotifications: false, dmFilter: 'all' };
      userPrefs.dmNotifications = !userPrefs.dmNotifications;
      userPreferences.set(userId, userPrefs);
      saveData();

      const isEnabled = userPrefs.dmNotifications;

      const embed = {
        color: 0x5865F2,
        title: '💬 DM Notifications',
        description: `You will receive direct messages when new quests are detected.`,
        fields: [
          {
            name: 'Current Status',
            value: isEnabled ? '✅ **ENABLED**' : '❌ **DISABLED**',
            inline: false
          },
          {
            name: 'Status',
            value: isEnabled ? 'You will now receive DM notifications for all new quests' : 'You will no longer receive DM notifications',
            inline: false
          }
        ],
        footer: {
          text: 'QuestHunter',
          icon_url: 'https://i.imgur.com/yTgBkjM.png'
        },
        timestamp: new Date().toISOString()
      };

      const button = new ButtonBuilder()
        .setCustomId(`toggle_dm_${userId}`)
        .setLabel(isEnabled ? '🔔 Disable' : '🔕 Enable')
        .setStyle(isEnabled ? ButtonStyle.Danger : ButtonStyle.Success);

      const row = new ActionRowBuilder().addComponents(button);

      await interaction.update({
        embeds: [embed],
        components: [row],
      });
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

async function sendDMNotifications(questData) {
  try {
    let sentCount = 0;
    const usersToNotify = [];

    // Find all users with DM notifications enabled and filter quests by their preference
    for (const [userId, prefs] of userPreferences) {
      if (prefs.dmNotifications) {
        // Check if quest matches user's filter
        const dmFilter = prefs.dmFilter || 'all'; // Backward compatibility: default to 'all'
        const rewardLower = questData.reward?.toLowerCase() || '';
        
        let shouldNotify = true;
        
        if (dmFilter === 'orbs') {
          shouldNotify = rewardLower.includes('orb') || /\d+\s*(discord)?\s*orb/i.test(questData.reward || '');
        } else if (dmFilter === 'decorations') {
          shouldNotify = rewardLower.includes('decoration') || rewardLower.includes('dekoration');
        } else if (dmFilter === 'items') {
          shouldNotify = questData.reward && !rewardLower.includes('orb') && !rewardLower.includes('decoration') && !rewardLower.includes('dekoration');
        }
        // else dmFilter === 'all', shouldNotify stays true
        
        if (shouldNotify) {
          usersToNotify.push(userId);
        }
      }
    }

    if (usersToNotify.length === 0) {
      return;
    }

    console.log(`  💬 Sending DM to ${usersToNotify.length} user(s)...`);

    for (const userId of usersToNotify) {
      try {
        const user = await client.users.fetch(userId);
        const questLink = `https://discord.com/quests/${questData.id}`;
        const dmMessage = `🎯 **New Quest Detected!**\n\n**${questData.name}**\n${questData.reward}\n\n${questLink}`;
        
        await user.send(dmMessage);
        sentCount++;
      } catch (error) {
        console.log(`  ⚠️  Could not send DM to user ${userId}: ${error.message}`);
      }
    }

    if (sentCount > 0) {
      console.log(`  ✅ Sent DM to ${sentCount} user(s)`);
    }
  } catch (error) {
    console.error(`  ❌ Error sending DM notifications:`, error.message);
  }
}

async function notifyExpiredQuest(channelId, questData) {
  try {
    console.log(`  📤 Attempting to send expired notification to channel ${channelId}`);
    
    const channel = await client.channels.fetch(channelId);
    
    if (!channel) {
      console.error(`  ❌ Channel ${channelId} not found`);
      return;
    }
    
    const embed = {
      color: 0xFF5733,
      title: '⏰ Quest Expired',
      description: `A quest has expired and is no longer available`,
      fields: [
        {
          name: 'Quest Name',
          value: questData.name,
          inline: true
        },
        {
          name: 'Reward',
          value: questData.reward || 'Unknown',
          inline: true
        },
        {
          name: 'Expired Date',
          value: formatDate(questData.expiresAt),
          inline: false
        }
      ],
      footer: {
        text: 'QuestHunter',
        icon_url: 'https://i.imgur.com/yTgBkjM.png'
      },
      timestamp: new Date().toISOString()
    };
    
    await channel.send({ embeds: [embed] });
    
    console.log(`  ✅ Expired notification sent to <#${channelId}>`);
    
  } catch (error) {
    console.error(`  ❌ Error sending expired notification to channel ${channelId}:`, error.message);
  }
}

// Handle button interactions
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  
  try {
    if (interaction.customId.startsWith('claim_code_')) {
      const questId = interaction.customId.split('_')[2];
      const messageId = interaction.message.id;
      
      // Get quest from knownQuests or from saved shared codes
      let quest = knownQuests.get(questId);
      let questName = 'Unknown Quest';
      
      if (quest) {
        questName = quest.name;
      } else if (sharedCodes.has(messageId)) {
        // Quest might be expired, but we have the info saved
        questName = sharedCodes.get(messageId).questName;
      } else {
        return await interaction.reply({
          content: '❌ Quest information not found.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // Get current embed
      const currentEmbed = interaction.message.embeds[0];
      
      // Separate inline and non-inline fields from original embed
      const originalFields = currentEmbed.fields || [];
      const nonInlineFields = originalFields.filter(f => !f.inline);
      const inlineFields = originalFields.filter(f => f.inline);
      
      // Create updated embed with claimed info - preserve description, title, color, etc
      const claimedEmbed = {
        title: currentEmbed.title,
        description: currentEmbed.description, // Keep original description with quest name and reward
        color: 0x9B59B6, // Purple color for claimed
        fields: [
          ...nonInlineFields, // Non-inline fields first (like Code)
          ...inlineFields, // Then original inline fields (Shared by, Time)
          {
            name: '✅ Claimed by',
            value: `${interaction.user.username}#${interaction.user.discriminator}`,
            inline: true
          },
          {
            name: '⏰ Claimed at',
            value: new Date().toLocaleString(),
            inline: true
          }
        ],
        thumbnail: currentEmbed.thumbnail,
        footer: currentEmbed.footer,
        timestamp: currentEmbed.timestamp
      };

      // Remove button and update message
      await interaction.update({
        embeds: [claimedEmbed],
        components: []
      });

      // Send confirmation to user
      await interaction.followUp({
        content: `✅ You claimed the code for **${questName}**!`,
        ephemeral: true,
      });

      console.log(`✅ Code claimed for quest "${questName}" by ${interaction.user.tag}`);
      return;
    }

    if (interaction.customId.startsWith('toggle_dm_')) {
      const userId = interaction.customId.split('_')[2];
      
      // Check if the button was pressed by the user who initiated the command
      if (interaction.user.id !== userId) {
        return await interaction.reply({
          content: '❌ You cannot toggle this setting.',
          flags: MessageFlags.Ephemeral,
        });
      }

      // Toggle the setting
      const userPrefs = userPreferences.get(userId) || { dmNotifications: false };
      userPrefs.dmNotifications = !userPrefs.dmNotifications;
      userPreferences.set(userId, userPrefs);
      saveData();

      const isEnabled = userPrefs.dmNotifications;

      const embed = {
        color: 0x5865F2,
        title: '💬 DM Notifications',
        description: `You will receive direct messages when new quests are detected.`,
        fields: [
          {
            name: 'Current Status',
            value: isEnabled ? '✅ **ENABLED**' : '❌ **DISABLED**',
            inline: false
          },
          {
            name: 'Status',
            value: isEnabled ? 'You will now receive DM notifications for all new quests' : 'You will no longer receive DM notifications',
            inline: false
          }
        ],
        footer: {
          text: 'QuestHunter',
          icon_url: 'https://i.imgur.com/yTgBkjM.png'
        },
        timestamp: new Date().toISOString()
      };

      const button = new ButtonBuilder()
        .setCustomId(`toggle_dm_${userId}`)
        .setLabel(isEnabled ? '🔔 Disable' : '🔕 Enable')
        .setStyle(isEnabled ? ButtonStyle.Danger : ButtonStyle.Success);

      const row = new ActionRowBuilder().addComponents(button);

      await interaction.update({
        embeds: [embed],
        components: [row],
      });
      return;
    }

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

    // Handle expired quests pagination buttons
    if (interaction.customId.startsWith('expired_prev_') || 
        interaction.customId.startsWith('expired_next_') ||
        interaction.customId.startsWith('expired_close_')) {
      
      const userId = interaction.customId.split('_')[2];
      
      // Check if the button was pressed by the user who initiated the command
      if (interaction.user.id !== userId) {
        return await interaction.reply({
          content: '❌ You cannot use this pagination.',
          flags: MessageFlags.Ephemeral,
        });
      }
      
      const messageId = interaction.message.id;
      const state = paginationState.get(messageId);
      
      if (!state) {
        return await interaction.reply({
          content: '❌ Pagination state not found. Please use the command again.',
          flags: MessageFlags.Ephemeral,
        });
      }
      
      if (interaction.customId.startsWith('expired_close_')) {
        // Delete the pagination state
        paginationState.delete(messageId);
        await interaction.deferUpdate();
        return;
      }
      
      // Update page number
      if (interaction.customId.startsWith('expired_next_')) {
        if (state.page < state.totalPages) {
          state.page++;
        }
      } else if (interaction.customId.startsWith('expired_prev_')) {
        if (state.page > 1) {
          state.page--;
        }
      }
      
      // Create new embed for current page
      const embed = state.createPageEmbed(state.page);
      
      // Update buttons state
      const components = [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`expired_prev_${userId}`)
            .setLabel('← Previous')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(state.page === 1), // Disable on first page
          new ButtonBuilder()
            .setCustomId(`expired_next_${userId}`)
            .setLabel('Next →')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(state.page === state.totalPages), // Disable on last page
          new ButtonBuilder()
            .setCustomId(`expired_close_${userId}`)
            .setLabel('Close')
            .setStyle(ButtonStyle.Secondary)
        )
      ];
      
      await interaction.update({
        embeds: [embed],
        components: components,
      });
      
      return;
    }

    // Handle active quests pagination buttons
    if (interaction.customId.startsWith('activequests_prev_') || 
        interaction.customId.startsWith('activequests_next_') ||
        interaction.customId.startsWith('activequests_close_')) {
      
      const userId = interaction.customId.split('_')[2];
      
      // Check if the button was pressed by the user who initiated the command
      if (interaction.user.id !== userId) {
        return await interaction.reply({
          content: '❌ You cannot use this pagination.',
          flags: MessageFlags.Ephemeral,
        });
      }
      
      const messageId = interaction.message.id;
      const state = paginationState.get(messageId);
      
      if (!state) {
        return await interaction.reply({
          content: '❌ Pagination state not found. Please use the command again.',
          flags: MessageFlags.Ephemeral,
        });
      }
      
      if (interaction.customId.startsWith('activequests_close_')) {
        // Delete the pagination state
        paginationState.delete(messageId);
        await interaction.deferUpdate();
        return;
      }
      
      // Update page number
      if (interaction.customId.startsWith('activequests_next_')) {
        if (state.page < state.totalPages) {
          state.page++;
        }
      } else if (interaction.customId.startsWith('activequests_prev_')) {
        if (state.page > 1) {
          state.page--;
        }
      }
      
      // Create new embed for current page
      const embed = state.createPageEmbed(state.page);
      
      // Update buttons state
      const components = [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`activequests_prev_${userId}`)
            .setLabel('← Previous')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(state.page === 1),
          new ButtonBuilder()
            .setCustomId(`activequests_next_${userId}`)
            .setLabel('Next →')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(state.page === state.totalPages),
          new ButtonBuilder()
            .setCustomId(`activequests_close_${userId}`)
            .setLabel('Close')
            .setStyle(ButtonStyle.Secondary)
        )
      ];
      
      await interaction.update({
        embeds: [embed],
        components: components,
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
    
    // Skip processing if bot is still starting up
    if (!botReady) {
      console.log('⏳ Bot still initializing, loading quests without sending notifications...');
    }
    
    // Helper function to check if a quest is actually expired based on the date
    function isQuestActuallyExpired(expiresAt) {
      // expiresAt format: "9.3." (Day.Month.)
      if (!expiresAt || expiresAt === 'Unknown') {
        return false;
      }
      
      const today = new Date();
      const currentDay = today.getDate();
      const currentMonth = today.getMonth() + 1; // getMonth returns 0-11
      const currentYear = today.getFullYear();
      
      // Parse the date from format "9.3." or similar
      const parts = expiresAt.split('.');
      if (parts.length < 2) {
        return false;
      }
      
      const expireDay = parseInt(parts[0]);
      const expireMonth = parseInt(parts[1]);
      
      // Create comparison: if no year is specified, assume current year
      const expireYear = currentYear;
      
      // Compare dates
      if (expireMonth < currentMonth) {
        return true; // Already passed this month
      } else if (expireMonth === currentMonth && expireDay <= currentDay) {
        return true; // Same month but day has passed (including today)
      }
      
      return false; // Not expired yet
    }
    
    // Track which quests are currently sent by scraper
    const currentQuestIds = new Set(quests.map(q => q.id));
    
    // Find quests that were active but are no longer sent (expired)
    const expiredQuestsList = [];
    knownQuests.forEach((quest, questId) => {
      // Only mark as expired if it's actually past the expiration date
      if (!currentQuestIds.has(questId) && isQuestActuallyExpired(quest.expiresAt)) {
        expiredQuestsList.push(quest);
        // Move to expired quests
        expiredQuests.set(questId, quest);
        knownQuests.delete(questId);
      }
    });
    
    // Log expired quests
    if (expiredQuestsList.length > 0) {
      console.log(`\n🗑️  Expired quest(s):`);
      expiredQuestsList.forEach(quest => {
        console.log(`  ❌ ${quest.name} (Was expiring: ${quest.expiresAt})`);
      });
      console.log(`  📝 These quests are kept in expired_quests.json`);
      
      // Send notifications for expired quests
      if (botReady) {
        try {
          for (const quest of expiredQuestsList) {
            // Broadcast to ALL configured guilds with expired channels
            let sentToCount = 0;
            for (const [guildId, settings] of guildSettings) {
              const expiredChannelId = settings?.expiredChannelId;
              
              if (expiredChannelId) {
                try {
                  await notifyExpiredQuest(expiredChannelId, quest);
                  sentToCount++;
                } catch (chError) {
                  console.error(`⚠️  Error sending expired notification to channel ${expiredChannelId}:`, chError.message);
                }
              }
            }
            
            if (sentToCount > 0) {
              console.log(`  ✅ Sent expired notification to ${sentToCount} channel(s)`);
            }
          }
        } catch (error) {
          console.error(`⚠️  Could not send expired quest notifications:`, error.message);
        }
      }
    }
    
    // Process each quest
    let newQuestCount = 0;
    for (const quest of quests) {
      // Check if this is a truly new quest (not previously notified)
      // IMPORTANT: Check both knownQuests AND expiredQuests to avoid resending expired quests
      const isNew = !knownQuests.has(quest.id) && !expiredQuests.has(quest.id);
      
      if (isNew) {
        newQuestCount++;
        console.log(`  🆕 NEW: ${quest.name} (${quest.reward}, Expires: ${quest.expiresAt})`);
        
        // Only send notifications if bot is fully ready
        if (botReady) {
          try {
            // Broadcast to ALL configured guilds
            let sentToCount = 0;
            for (const [guildId, settings] of guildSettings) {
              const guildChannels = settings.channels || [];
              
              if (guildChannels.length > 0) {
                // Send to all configured channels with matching filters
                for (const ch of guildChannels) {
                  try {
                    await notifyNewQuest(ch.id, quest, guildId, ch.filter);
                    sentToCount++;
                  } catch (chError) {
                    console.error(`⚠️  Error sending to channel ${ch.id}:`, chError.message);
                  }
                }
              }
            }
            
            // Fallback to default channel if no guilds configured
            if (sentToCount === 0) {
              const defaultChannelId = process.env.NOTIFICATION_CHANNEL_ID;
              if (defaultChannelId) {
                try {
                  const channel = await client.channels.fetch(defaultChannelId);
                  const guildId = channel.guildId;
                  await notifyNewQuest(defaultChannelId, quest, guildId, 'all');
                  sentToCount++;
                } catch (err) {
                  console.error(`⚠️  Could not use default channel:`, err.message);
                }
              }
            }
            
            if (sentToCount > 0) {
              console.log(`  ✅ Sent to ${sentToCount} channel(s)`);
            }

            // Send DM notifications to opted-in users
            await sendDMNotifications(quest);
          } catch (error) {
            console.error(`⚠️  Could not send notification for quest ${quest.id}:`, error.message);
          }
        } else {
          console.log(`  ⏸️  Skipping notification (bot still initializing)`);
        }
      } else {
        console.log(`  ℹ️  EXISTING: ${quest.name}`);
      }
      
      // Only update quest data for new quests (to keep original detection time)
      // For existing quests, they're already in knownQuests
      if (isNew) {
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
    }
    
    // Save data after processing
    saveData();
    
    console.log(`✅ Processed ${quests.length} quests (${newQuestCount} new, ${expiredQuestsList.length} expired)`);
    console.log(`📊 Active quests in memory: ${knownQuests.size}`);
    console.log(`📊 Expired quests in memory: ${expiredQuests.size}\n`);
    
    res.status(200).json({ 
      success: true, 
      processed: quests.length, 
      newQuests: newQuestCount,
      expiredQuests: expiredQuests.length,
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
