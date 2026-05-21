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

// Load data at startup immediately — must run before Express accepts webhook calls
// (questScraper can POST before the Discord bot's 'ready' event fires, which would
// cause saveData() to overwrite expired_quests.json with an empty Map)
loadData();

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

// Validate shared codes
function validateCode(code, questId) {
  // Trim whitespace
  const trimmedCode = code.trim();
  
  // Check minimum length
  if (trimmedCode.length < 6) {
    return 'Code is too short. Game codes are typically at least 6 characters long.';
  }
  
  // Reject codes that are only numbers or too simple
  if (/^\d+$/.test(trimmedCode)) {
    return 'Codes cannot be just numbers. Valid game codes contain letters, numbers, and/or symbols.';
  }
  
  // Reject codes that are only lowercase letters
  if (/^[a-z]+$/i.test(trimmedCode) && trimmedCode === trimmedCode.toLowerCase()) {
    return 'Codes cannot be only lowercase letters. Valid codes have mixed case or numbers.';
  }
  
  // Check for URLs/Links - codes are not links
  if (/https?:\/\/|www\.|\.com|\.de|\.net|\.org|\.co|\.tv|\.io|\.xyz|bit\.ly|discord\.gg/i.test(trimmedCode)) {
    return 'Please share only game codes, not links or URLs.';
  }
  
  // Comprehensive list of inappropriate content - English profanities
  const englishProfanities = [
    // Sexual terms
    /\bfuck|fucking|fucked\b/i, /\bass|arse\b/i, /\bshit|shitty\b/i, /\bdamn|dammit|goddamn\b/i,
    /\bpussy|dick\b/i, /\bcock|cunt\b/i, /\bbitch|bastard\b/i, /\bwhore|slut|prostitute\b/i,
    /\bporn|xxx|adult|nude|nsfw|xxx\b/i, /\bsex\b/i, /\bcock\b/i, /\bsemen|cum\b/i,
    
    // Insulting terms
    /\bidiot|stupid|dumb|moron|retard\b/i, /\bassholes?\b/i, /\bcrap\b/i, /\bdouchebag\b/i,
    /\blooser|loser\b/i, /\bdipshit|jackass\b/i, /\bslutwad|cumguzzler\b/i,
    
    // Racial/Ethnic slurs (keeping minimal for safety)
    /\bnigger|nigga\b/i, /\bfaggot|homo\b/i, /\btranny\b/i, /\bkike|kike\b/i,
    /\bwop|chink|gook|jap|dink\b/i, /\bbeaner|spic|paki\b/i, /\brag?head|towel.?head\b/i,
    
    // German profanities
    /\barsch\b/i, /\bscheisse|scheiße\b/i, /\bverdammt|verdammt\b/i, /\bficker|gefickt\b/i,
    /\bdummkopf|blödmann|idiot|depp\b/i, /\bashoch|aschi|loch\b/i, /\bschwachsinn|hund\b/i,
    /\bziegenficker\b/i, /\blump|schwanz\b/i, /\bpisser|pisse\b/i, /\bhurensonn|hurensohn\b/i,
    /\bvolldepp|vollidiot|trottel\b/i, /\bsäckel|schwachköpfig\b/i, /\bwichser|wichs\b/i,
    
    // Spam/Scam related
    /viagra|cialis|casino|lottery|winner|claim.*prize|money|bet\b/i,
    /\bbet\b|\bgamble\b/i, /\bloan|credit|bank|paypal/i,
    
    // Racial discrimination terms
    /racism|racist|homophobic|sexist\b/i,
  ];
  
  for (const pattern of englishProfanities) {
    if (pattern.test(trimmedCode)) {
      return 'Please share only game codes. This content is not appropriate for the code sharing channel.';
    }
  }
  
  // Check for spam patterns: same character repeated 4+ times
  if (/^(.)\1{3,}$/.test(trimmedCode) || /(.)\1{3,}/.test(trimmedCode)) {
    return 'Please enter a valid code. Codes like "' + trimmedCode + '" don\'t look legitimate.';
  }
  
  // Reject if code is mostly repeated (like "ggggg" or "xxxxxx")
  if (trimmedCode.replace(/(.)\1/g, '').length < trimmedCode.length / 2) {
    return 'Please enter a valid code. Code appears to contain too many repeated characters.';
  }
  
  // Check for duplicate codes for the same quest
  const existingCodesForQuest = Array.from(sharedCodes.values()).filter(
    entry => entry.questId === questId
  );
  
  const codeExists = existingCodesForQuest.some(entry => 
    entry.code.toLowerCase() === trimmedCode.toLowerCase()
  );
  
  if (codeExists) {
    return `This code has already been shared for **${existingCodesForQuest[0]?.questName || 'this quest'}**. Please don't share duplicate codes.`;
  }
  
  return null; // Code is valid
}

// Get guild's notification channel
function getGuildChannel(guildId) {
  return guildSettings.get(guildId)?.channelId || process.env.NOTIFICATION_CHANNEL_ID;
}

// Format date to DD.MM. or DD.MM.YYYY
// Handles ISO 8601 ("2026-04-20T00:00:00Z"), MM/DD, MM/DD/YYYY
function formatDate(dateStr) {
  if (!dateStr || dateStr === 'Unknown' || dateStr === 'Deleted by Discord') {
    return dateStr;
  }

  const currentYear = new Date().getFullYear();

  // ISO 8601 format (from JSON feed)
  if (dateStr.includes('T') || (dateStr.includes('-') && dateStr.length > 7)) {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    const day = date.getUTCDate();
    const month = date.getUTCMonth() + 1;
    const year = date.getUTCFullYear();
    return year !== currentYear ? `${day}.${month}.${year}` : `${day}.${month}.`;
  }

  // Legacy MM/DD or MM/DD/YYYY
  const parts = dateStr.split('/');
  if (parts.length === 2) {
    return `${parts[1]}.${parts[0]}.`;
  } else if (parts.length === 3) {
    const year = parts[2];
    return year !== String(currentYear) ? `${parts[1]}.${parts[0]}.${year}` : `${parts[1]}.${parts[0]}.`;
  }

  return dateStr;
}

// Format a relative time string like "in 5 Tagen" / "vor 2 Tagen"
function parseAnyDate(dateStr) {
  if (!dateStr || dateStr === 'Unknown') return null;
  // ISO 8601
  if (dateStr.includes('T') || (dateStr.includes('-') && dateStr.length > 7)) {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
  }
  const currentYear = new Date().getFullYear();
  // German "DD.MM." or "DD.MM.YYYY"
  if (dateStr.includes('.')) {
    const parts = dateStr.split('.').filter(p => p.trim());
    if (parts.length < 2) return null;
    const day = parseInt(parts[0]);
    const month = parseInt(parts[1]) - 1;
    const year = parts[2] ? parseInt(parts[2]) : currentYear;
    return new Date(year, month, day);
  }
  // Legacy "MM/DD" or "MM/DD/YYYY"
  if (dateStr.includes('/')) {
    const parts = dateStr.split('/');
    if (parts.length < 2) return null;
    const month = parseInt(parts[0]) - 1;
    const day = parseInt(parts[1]);
    const year = parts[2] ? parseInt(parts[2]) : currentYear;
    return new Date(year, month, day);
  }
  return null;
}

function formatRelative(dateStr) {
  const date = parseAnyDate(dateStr);
  if (!date) return null;
  const diffDays = Math.round((date.getTime() - Date.now()) / 86400000);
  if (diffDays === 0) return 'heute';
  if (diffDays > 0) return `in ${diffDays} Tag${diffDays === 1 ? '' : 'en'}`;
  return `vor ${Math.abs(diffDays)} Tag${Math.abs(diffDays) === 1 ? '' : 'en'}`;
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
            { name: 'Decorations Only', value: 'decorations' },
            { name: 'Game Items Only', value: 'items' },
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
      name: 'info',
      description: 'Information about how quests work and why you might not see a quest',
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
          type: 3,
          required: true,
          choices: [
            { name: 'All Quests', value: 'all' },
            { name: 'Orbs Only', value: 'orbs' },
            { name: 'Decorations Only', value: 'decorations' },
            { name: 'Game Items Only', value: 'items' },
            { name: 'Disabled', value: 'disabled' },
          ],
        },
        {
          name: 'style',
          description: 'How the DM notification looks (default: Default)',
          type: 3,
          required: false,
          choices: [
            { name: 'Default (text message)', value: 'default' },
            { name: 'Embed (rich card with reward image)', value: 'embed' },
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
          type: 3,
          required: true,
          autocomplete: true,
        },
        {
          name: 'code',
          description: 'The game code or reward to share',
          type: 3,
          required: true,
        },
      ],
    },
    {
      name: 'notification-style',
      description: 'Set how new quest notifications are displayed in this server',
      options: [
        {
          name: 'style',
          description: 'Notification style',
          type: 3,
          required: true,
          choices: [
            { name: 'Default (text + auto-embed)', value: 'default' },
            { name: 'Embed (rich card with reward image)', value: 'embed' },
          ],
        },
      ],
      default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    },
    {
      name: 'quest-test',
      description: 'Send test quest notifications to this channel (Bot Admin only)',
      options: [
        {
          name: 'style',
          description: 'Style to test (defaults to this server\'s current setting)',
          type: 3,
          required: false,
          choices: [
            { name: 'Default (text + auto-embed)', value: 'default' },
            { name: 'Embed (rich card with reward image)', value: 'embed' },
          ],
        },
        {
          name: 'count',
          description: 'How many quest examples to send (1–15, default 1)',
          type: 4,
          required: false,
          min_value: 1,
          max_value: 15,
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

      const filterText = { 'all': 'All Quests', 'orbs': 'Orbs Only', 'decorations': 'Decorations Only', 'items': 'Game Items Only', 'no_orbs': 'No Orbs (Legacy)' }[filter];

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
      
      // Deduplicate regional variants by normalized name, collecting all IDs
      const nameToQuest = new Map();
      for (const q of knownQuests.values()) {
        const key = (q.name || '').replace(/\s+Quest$/i, '').trim();
        if (!nameToQuest.has(key)) {
          nameToQuest.set(key, { ...q, allIds: [q.id] });
        } else {
          nameToQuest.get(key).allIds.push(q.id);
        }
      }
      let quests = Array.from(nameToQuest.values());

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
          // ISO 8601
          if (dateStr.includes('T') || (dateStr.includes('-') && dateStr.length > 7)) {
            return new Date(dateStr);
          }
          let day, month, year = new Date().getFullYear();
          if (dateStr.includes('.')) {
            const parts = dateStr.split('.');
            if (parts.length < 2) return new Date(0);
            day = parseInt(parts[0]);
            month = parseInt(parts[1]);
          } else if (dateStr.includes('/')) {
            const parts = dateStr.split('/');
            if (parts.length < 2) return new Date(0);
            month = parseInt(parts[0]);
            day = parseInt(parts[1]);
            if (parts.length === 3) year = parseInt(parts[2]);
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
          const ids = q.allIds?.length > 0 ? q.allIds : [q.id];
          const linkStr = ids.length === 1
            ? `[Quest öffnen](https://discord.com/quests/${ids[0]})`
            : ids.map((id, idx) => `[Quest Link ${idx + 1}](https://discord.com/quests/${id})`).join(' • ');
          const taskStr = q.tasks?.length > 0 ? `\nTask(s): ${q.tasks.join(' / ')}` : '';
          const relExpiry = formatRelative(q.expiresAt);
          const absExpiry = formatDate(q.expiresAt) || 'Unknown';
          const expiryStr = relExpiry ? `${absExpiry} (${relExpiry})` : absExpiry;
          return {
            name: `${globalIdx}. ${q.name}`,
            value: `${linkStr}\nReward: ${q.reward}${taskStr}\nExpires: ${expiryStr}`,
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
              .setStyle(ButtonStyle.Primary)
          )
        ];
      }
      
      const message = await interaction.reply({
        embeds: [firstEmbed],
        components: components,
        ephemeral: true,
      });
      
      // IMPORTANT: For ephemeral messages, we need to store the state using a special key
      const stateKey = `activequests_${interaction.user.id}_${Date.now()}`;
      
      // Store pagination state with both messageId and stateKey as backup
      paginationState.set(message.id, {
        page: 1,
        totalPages: totalPages,
        quests: quests,
        createPageEmbed: createPageEmbed,
        userId: interaction.user.id,
        filterOption: filterOption,
        stateKey: stateKey
      });
      
      // Also store with the stateKey as backup
      paginationState.set(stateKey, {
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
        // Check if quest is deleted or has unknown date - these should be at the END
        const aIsSpecial = a.deletedByDiscord || a.expiresAt === 'Unknown' || !a.expiresAt;
        const bIsSpecial = b.deletedByDiscord || b.expiresAt === 'Unknown' || !b.expiresAt;
        
        // If one is special and the other isn't, special goes to end
        if (aIsSpecial && !bIsSpecial) return 1;
        if (!aIsSpecial && bIsSpecial) return -1;
        
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
      const QUESTS_PER_PAGE = 10;
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
              .setStyle(ButtonStyle.Primary)
          )
        ];
      }
      
      const message = await interaction.reply({
        embeds: [firstEmbed],
        components: components,
        flags: MessageFlags.Ephemeral,
      });
      
      // IMPORTANT: For ephemeral messages, we need to store the state using a special key
      // Ephemeral messages have different ID handling, so we use userId + timestamp combination
      const stateKey = `expired_${interaction.user.id}_${Date.now()}`;
      
      // Store pagination state with both messageId and stateKey as backup
      paginationState.set(message.id, {
        page: 1,
        totalPages: totalPages,
        quests: quests,
        createPageEmbed: createPageEmbed,
        userId: interaction.user.id,
        stateKey: stateKey
      });
      
      // Also store with the stateKey as backup
      paginationState.set(stateKey, {
        page: 1,
        totalPages: totalPages,
        quests: quests,
        createPageEmbed: createPageEmbed,
        userId: interaction.user.id
      });
    }

    if (interaction.commandName === 'help') {
      const userId = interaction.user.id;
      const spoofEnabled = process.env.ENABLE_SPOOFGUIDE !== 'false';

      const helpPages = [
        {
          color: 0x5865F2,
          title: '🔍 QuestHunter',
          description: 'Track Discord quests automatically and get notified when new ones appear!\n\nUse the arrows below to browse all commands.',
          fields: [
            { name: '🗳️ Vote', value: '[Vote on Top.gg](https://top.gg/de/bot/1474123878002462801/vote)', inline: true },
            { name: '💬 Support', value: '[Join Discord](https://discord.gg/X5YKZBh9xV)', inline: true },
            { name: '🌐 Website', value: '[questhunter.xyz](http://questhunter.xyz/)', inline: true },
            { name: '💻 Source Code', value: '[GitHub](https://github.com/SimpliAj/QuestHunter)', inline: true },
          ],
          footer: { text: 'Page 1/4 • QuestHunter', icon_url: 'https://i.imgur.com/yTgBkjM.png' },
          timestamp: new Date().toISOString()
        },
        {
          color: 0x5865F2,
          title: '⚙️ Admin Commands',
          description: 'Commands that require **Manage Server** permission.',
          fields: [
            { name: '`/setup-channel`', value: 'Add a channel for quest notifications (with optional reward filter)', inline: false },
            { name: '`/setup-expired-channel`', value: 'Set a channel to receive expired quest alerts', inline: false },
            { name: '`/questpingrole`', value: 'Set a role to ping when new quests are detected', inline: false },
            { name: '`/notification-style`', value: 'Choose notification style: default text or rich embed', inline: false },
            { name: '`/remove`', value: 'Remove a notification channel or ping role', inline: false },
          ],
          footer: { text: 'Page 2/4 • QuestHunter', icon_url: 'https://i.imgur.com/yTgBkjM.png' },
          timestamp: new Date().toISOString()
        },
        {
          color: 0x5865F2,
          title: '🎯 Quest Commands',
          description: 'Browse and interact with Discord quests.',
          fields: [
            { name: '`/activequests`', value: 'List all currently active quests (filterable by reward type)', inline: false },
            { name: '`/latestquest`', value: 'Show the most recently detected quest', inline: false },
            { name: '`/expiredquests`', value: 'View all past expired quests', inline: false },
            { name: '`/share`', value: 'Share a game code or reward from an active quest', inline: false },
            ...(spoofEnabled ? [{ name: '`/spoofguide`', value: 'Get the QuestPhantom auto-complete guide', inline: false }] : []),
          ],
          footer: { text: 'Page 3/4 • QuestHunter', icon_url: 'https://i.imgur.com/yTgBkjM.png' },
          timestamp: new Date().toISOString()
        },
        {
          color: 0x5865F2,
          title: '📋 Info & Utility',
          description: 'General info and personal settings.',
          fields: [
            { name: '`/serverconfig`', value: 'View this server\'s current configuration', inline: false },
            { name: '`/stats`', value: 'View bot statistics (servers, quests tracked, etc.)', inline: false },
            { name: '`/info`', value: 'Learn how quests work and why you might not see one', inline: false },
            { name: '`/dm-notifications`', value: 'Configure personal DM alerts for new quests', inline: false },
            { name: '`/feedback`', value: 'Submit a bug report or feature request', inline: false },
            { name: '`/help`', value: 'Show this help menu', inline: false },
          ],
          footer: { text: 'Page 4/4 • QuestHunter', icon_url: 'https://i.imgur.com/yTgBkjM.png' },
          timestamp: new Date().toISOString()
        },
      ];

      const buildHelpComponents = (page, total) => [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`help_prev_${userId}`)
            .setLabel('◀ Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
          new ButtonBuilder()
            .setCustomId(`help_next_${userId}`)
            .setLabel('Next ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === total - 1)
        )
      ];

      paginationState.set(`help_${userId}`, {
        userId,
        page: 0,
        pages: helpPages,
      });

      await interaction.reply({
        embeds: [helpPages[0]],
        components: buildHelpComponents(0, helpPages.length),
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'stats') {
      const totalServers = client.guilds.cache.size;
      const totalChannels = Array.from(guildSettings.values()).reduce((sum, settings) => sum + (settings.channels?.length || 0), 0);

      // Deduplicate by normalized name only (reward strings may differ between old/new format)
      const normName = (q) => (q.name || '').replace(/\s+Quest$/i, '').trim();
      const dedupeByName = (quests) => {
        const seen = new Set();
        return quests.filter(q => {
          const key = normName(q);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };
      const uniqueActive = dedupeByName(Array.from(knownQuests.values()));
      const activeNames = new Set(uniqueActive.map(normName));
      const uniqueExpired = dedupeByName(Array.from(expiredQuests.values()).filter(q => !activeNames.has(normName(q))));

      const totalTrackedQuests = uniqueActive.length + uniqueExpired.length;
      const activeQuests = uniqueActive.length;

      // Calculate available orbs, decorations, and game items from ACTIVE quests only
      let availableOrbs = 0;
      let availableDecorations = 0;
      let availableGameItems = 0;
      const gameItemsMap = new Map(); // Track unique game items

      for (const quest of uniqueActive) {
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
      
      // Count from deduplicated active + expired quests
      for (const quest of [...uniqueActive, ...uniqueExpired]) {
        const rewardLower = quest.reward?.toLowerCase() || '';
        if (rewardLower.includes('decoration') || rewardLower.includes('dekoration')) {
          totalTrackedDecorations++;
        } else if (rewardLower.includes('orb') || /\d+\s*(discord)?\s*orb/i.test(quest.reward || '')) {
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

    if (interaction.commandName === 'info') {
      const infoEmbed = {
        color: 0x5865F2,
        title: '❓ How Quests Work',
        description: 'QuestHunter detects **all** Discord quests globally — but not every quest is available to everyone.',
        fields: [
          {
            name: '🌍 Region Locked',
            value: 'Many quests are only available in specific countries or regions. If a quest was announced here but you see **"You are not eligible for this quest"** when opening the link — it is region locked and not available in your region.',
            inline: false,
          },
          {
            name: '📱 Platform Restrictions',
            value: 'Some quests require a specific platform (Mobile, Desktop, PlayStation, Xbox, Switch). Make sure you are using the correct platform for the task.',
            inline: false,
          },
          {
            name: '🔔 Why do I see quests I can\'t do?',
            value: 'This bot notifies about every active quest so that users **in eligible regions** get notified. Quests that show up for you may be completable by other members of this server.',
            inline: false,
          },
          {
            name: '🔍 Where to see your quests',
            value: 'Open Discord → click the gift icon at the top of your DM list → **Quests** tab. Only quests available in your region will appear there.',
            inline: false,
          },
        ],
        footer: {
          text: 'QuestHunter',
          icon_url: 'https://i.imgur.com/yTgBkjM.png',
        },
        timestamp: new Date().toISOString(),
      };

      await interaction.reply({ embeds: [infoEmbed], ephemeral: true });
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
      
      // Validate code format
      const validationError = validateCode(code, questId);
      if (validationError) {
        return await interaction.reply({
          content: `❌ ${validationError}`,
          ephemeral: true,
        });
      }
      
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
      const styleOption = interaction.options.getString('style');

      const userPrefs = userPreferences.get(userId) || { dmNotifications: false, dmFilter: 'all', dmStyle: 'default' };

      if (filterOption === 'disabled') {
        userPrefs.dmNotifications = false;
        userPrefs.dmFilter = 'all';
      } else {
        userPrefs.dmNotifications = true;
        userPrefs.dmFilter = filterOption;
      }

      if (styleOption) {
        userPrefs.dmStyle = styleOption;
      }

      userPreferences.set(userId, userPrefs);
      saveData();

      const filterText = {
        'all': 'All Quests',
        'orbs': 'Orbs Only',
        'decorations': 'Decorations Only',
        'items': 'Game Items Only',
        'disabled': 'Disabled'
      }[filterOption];

      const styleText = (userPrefs.dmStyle === 'embed') ? 'Embed (rich card)' : 'Default (text message)';

      const fields = [
        { name: 'Status', value: filterOption === 'disabled' ? '❌ **DISABLED**' : '✅ **ENABLED**', inline: false },
        { name: 'Filter', value: filterText, inline: true },
      ];
      if (filterOption !== 'disabled') {
        fields.push({ name: 'Style', value: styleText, inline: true });
      }

      await interaction.reply({
        embeds: [{
          color: 0x5865F2,
          title: '💬 DM Notifications',
          description: 'Direct message notifications for new quests have been configured.',
          fields,
          footer: { text: 'QuestHunter', icon_url: 'https://i.imgur.com/yTgBkjM.png' },
          timestamp: new Date().toISOString()
        }],
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'notification-style') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return await interaction.reply({
          content: '❌ You need the Manage Guild permission to use this command.',
          ephemeral: true,
        });
      }

      const style = interaction.options.getString('style');

      if (!guildSettings.has(interaction.guildId)) {
        guildSettings.set(interaction.guildId, {});
      }
      guildSettings.get(interaction.guildId).notificationStyle = style;
      saveData();

      const label = style === 'embed' ? 'Embed (rich card with reward image)' : 'Default (text + auto-embed)';
      await interaction.reply({
        embeds: [{
          color: 0x5865F2,
          title: '✅ Notification Style Updated',
          description: `New quest notifications will now be sent as **${label}**.`,
          footer: { text: 'QuestHunter', icon_url: 'https://i.imgur.com/yTgBkjM.png' },
          timestamp: new Date().toISOString(),
        }],
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'quest-test') {
      if (interaction.user.id !== ADMIN_USER_ID) {
        return await interaction.reply({ content: '❌ This command is restricted to the bot admin.', ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const styleOverride = interaction.options.getString('style');
      const count = interaction.options.getInteger('count') || 1;
      const style = styleOverride || guildSettings.get(interaction.guildId)?.notificationStyle || 'default';

      // Always fetch fresh from JSON so imageUrl and all fields are populated
      let questPool = [];
      try {
        const axios = require('axios');
        const QUESTS_JSON_URL = 'https://raw.githubusercontent.com/aamiaa/discord-api-diff/refs/heads/main/quests.json';
        const response = await axios.get(QUESTS_JSON_URL, { timeout: 15000 });
        const now = new Date();
        const TASK_LABELS = {
          WATCH_VIDEO: 'Video', WATCH_VIDEO_ON_DESKTOP: 'Video (Desktop)', WATCH_VIDEO_ON_MOBILE: 'Video (Mobile)',
          PLAY_ON_DESKTOP: 'Desktop', STREAM_ON_DESKTOP: 'Desktop (Stream)',
          PLAY_ON_MOBILE: 'Mobile', PLAY_ON_PLAYSTATION: 'PlayStation', PLAY_ON_XBOX: 'Xbox',
          PLAY_ON_SWITCH: 'Switch', COMPLETE_ACHIEVEMENT: 'Achievement', PLAY_ACTIVITY: 'Activity',
          ACHIEVEMENT_IN_ACTIVITY: 'Achievement (Activity)',
        };
        const cdnUrl = (questId, assetPath) => {
          if (!assetPath) return null;
          return assetPath.startsWith('quests/')
            ? `https://cdn.discordapp.com/${assetPath}`
            : `https://cdn.discordapp.com/quests/${questId}/${assetPath}`;
        };

        const maxExpiry = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);

        questPool = response.data
          .filter(e => e.config?.starts_at && e.config?.expires_at)
          .filter(e => {
            const start = new Date(e.config.starts_at);
            const expire = new Date(e.config.expires_at);
            // Active + not a permanent demo quest (expires within 180 days)
            return start <= now && expire > now && expire <= maxExpiry;
          })
          .sort((a, b) => new Date(b.config.starts_at) - new Date(a.config.starts_at))
          .reduce((acc, e) => {
            const cfg = e.config;
            const questName = cfg.messages?.quest_name || 'Unknown';

            // Skip [TEST] quests
            if (/^\[TEST\]/i.test(questName)) return acc;

            const rewards = cfg.rewards_config?.rewards || cfg.rewards || [];
            const r = rewards[0];
            let reward = 'Unknown';
            if (r?.orb_quantity != null) {
              const nitro = r.premium_orb_quantity ?? Math.round(r.orb_quantity * 1.2);
              reward = `${r.orb_quantity} Discord Orbs (Nitro: ${nitro} Orbs)`;
            } else {
              const name = r?.messages?.name || r?.name || 'Unknown';
              const redemption = r?.messages?.redemption_instructions_by_platform?.['0'] || '';
              const isDecoration = /^(PLACEHOLDER|Default)$/i.test(redemption.trim());
              reward = isDecoration ? `${name} (Avatar Decoration)` : name;
            }

            const taskKeys = Object.keys(cfg.task_config_v2?.tasks || cfg.task_config?.tasks || {});
            const hasSpecificVideo = taskKeys.some(k => k === 'WATCH_VIDEO_ON_DESKTOP' || k === 'WATCH_VIDEO_ON_MOBILE');
            const tasks = taskKeys
              .filter(k => !(k === 'WATCH_VIDEO' && hasSpecificVideo))
              .map(k => TASK_LABELS[k] || k);

            const imageUrl = r?.asset ? cdnUrl(e.id, r.asset) : 'https://i.imgur.com/v2Ra1GP.png';

            // Deduplicate regional variants by name+reward
            const normalizedName = questName.replace(/\s+Quest$/i, '').trim();
            const dedupeKey = `${normalizedName}||${reward}`;
            const existing = acc.find(q => `${(q.name || '').replace(/\s+Quest$/i, '').trim()}||${q.reward}` === dedupeKey);
            if (existing) {
              if (!existing.allIds.includes(String(e.id))) existing.allIds.push(String(e.id));
              return acc;
            }

            acc.push({
              id: e.id,
              allIds: [String(e.id)],
              name: questName,
              game: cfg.messages?.game_title || cfg.application?.name || null,
              reward, tasks, imageUrl,
              startsAt: cfg.starts_at,
              expiresAt: cfg.expires_at,
            });
            return acc;
          }, []);
      } catch (err) {
        // Fall back to knownQuests if fetch fails
        console.warn('⚠️  quest-test: JSON fetch failed, using knownQuests:', err.message);
        questPool = Array.from(knownQuests.values());
      }

      const selected = questPool.slice(0, count);
      if (selected.length === 0) {
        await interaction.editReply({ content: '❌ No quests available to test with.' });
        return;
      }

      const channel = interaction.channel;
      const styleLabel = style === 'embed' ? 'Embed' : 'Default';
      await channel.send(`🧪 **Quest notification test** — Style: **${styleLabel}** (${selected.length} quest${selected.length > 1 ? 's' : ''})`);

      for (const quest of selected) {
        const payload = buildQuestPayload(quest, style);
        await channel.send(payload);
      }

      await interaction.editReply({ content: `✅ Sent ${selected.length} test notification${selected.length > 1 ? 's' : ''} to <#${channel.id}> using **${styleLabel}** style.` });
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

// Build the Discord message payload for a quest notification.
// Returns { content, embeds } ready for channel.send().
function buildQuestPayload(questData, style, pingContent = '') {
  const questLink = `https://discord.com/quests/${questData.id}`;
  const rel = formatRelative(questData.expiresAt);
  const abs = formatDate(questData.expiresAt);
  const expiryText = rel ? `${abs} (${rel})` : (abs || 'Unknown');

  if (style === 'embed') {
    const fields = [];
    const siblings = questData.siblings || [];

    if (siblings.length > 0) {
      // Multiple variants: list each reward+task as description lines
      const allVariants = [questData, ...siblings];
      const descLines = allVariants.map(v => {
        const taskStr = v.tasks?.length > 0 ? ` · ${v.tasks.join(' / ')}` : '';
        return `🏆 [${v.reward || 'Unknown'}](https://discord.com/quests/${v.id})${taskStr}`;
      });
      fields.push({ name: '⏰ Expires', value: expiryText, inline: true });
      const embed = {
        color: 0x5865F2,
        author: questData.game ? { name: `🎮 ${questData.game}` } : undefined,
        title: questData.name,
        url: questLink,
        description: descLines.join('\n'),
        fields,
        footer: { text: 'QuestHunter', icon_url: 'https://i.imgur.com/yTgBkjM.png' },
        timestamp: new Date().toISOString(),
      };
      if (questData.imageUrl) embed.thumbnail = { url: questData.imageUrl };
      return { content: pingContent || undefined, embeds: [embed] };
    }

    if (questData.tasks?.length > 0) {
      fields.push({ name: '📱 Task', value: questData.tasks.join(' / '), inline: true });
    }
    fields.push({ name: '⏰ Expires', value: expiryText, inline: true });

    const embed = {
      color: 0x5865F2,
      author: questData.game ? { name: `🎮 ${questData.game}` } : undefined,
      title: questData.name,
      url: questLink,
      description: `🏆 ${questData.reward || 'Unknown'}`,
      fields,
      footer: { text: 'QuestHunter', icon_url: 'https://i.imgur.com/yTgBkjM.png' },
      timestamp: new Date().toISOString(),
    };
    if (questData.imageUrl) embed.thumbnail = { url: questData.imageUrl };

    // Add regional link buttons if quest has multiple IDs (max 5 rows × 5 buttons = 25)
    const allIds = questData.allIds?.length > 1 ? questData.allIds : null;
    let components = undefined;
    if (allIds) {
      // Build label map from allLinks if available, fallback to numbered labels
      const allLinks = questData.allLinks || [];
      const linkMap = new Map(allLinks.map(l => [String(l.id), l.flag]));
      // Count code occurrences to number duplicates; unknown get sequential numbers
      const codeCount = {};
      let unknownCount = 0;
      const capped = allIds.slice(0, 25);
      const rows = [];
      for (let i = 0; i < capped.length; i += 5) {
        rows.push({
          type: 1,
          components: capped.slice(i, i + 5).map((id, j) => {
            const code = linkMap.get(String(id)) || null;
            let label;
            if (code) {
              codeCount[code] = (codeCount[code] || 0) + 1;
              label = codeCount[code] > 1 ? `${code} #${codeCount[code]}` : code;
            } else {
              unknownCount++;
              label = `Quest Link ${unknownCount}`;
            }
            return { type: 2, style: 5, label, url: `https://discord.com/quests/${id}` };
          }),
        });
      }
      components = rows;
    }

    return { content: pingContent || undefined, embeds: [embed], components };
  }

  // Default style
  let content = `🎯 **New Quest Detected!**\n${pingContent}`;
  const infoLines = [];
  if (questData.reward) {
    infoLines.push(`**Reward:** ${questData.reward}`);
  }
  if (questData.tasks?.length > 0) {
    infoLines.push(`**Task(s):** ${questData.tasks.join(' / ')}`);
  }
  if (questData.expiresAt) {
    infoLines.push(`**Expires:** ${expiryText}`);
  }
  if (infoLines.length > 0) content += infoLines.join(' | ') + '\n';

  // All regional URLs — one per line
  const allIds = questData.allIds?.length > 1 ? questData.allIds : null;
  if (allIds) {
    content += allIds.map(id => `https://discord.com/quests/${id}`).join('\n');
  } else {
    content += questLink;
  }
  return { content };
}

async function groupSiblingQuest(primaryQuestId, newQuest) {
  const primary = knownQuests.get(primaryQuestId);
  if (!primary) return;

  const siblings = primary.siblings || [];
  siblings.push({
    id: newQuest.id,
    reward: newQuest.reward,
    tasks: newQuest.tasks || [],
    game: newQuest.game || null,
    expiresAt: newQuest.expiresAt,
    allIds: newQuest.allIds || [newQuest.id],
    allLinks: newQuest.allLinks || [],
  });

  knownQuests.set(primaryQuestId, { ...primary, siblings });
  // Register new ID as known so it won't re-trigger
  knownQuests.set(newQuest.id, {
    id: newQuest.id, name: newQuest.name, game: newQuest.game || null,
    reward: newQuest.reward, tasks: newQuest.tasks || [], expiresAt: newQuest.expiresAt,
    primaryQuestId, guildMessages: [], notified: true,
  });

  console.log(`  🔗 SIBLING: "${newQuest.name}" (${newQuest.reward}) grouped with primary ${primaryQuestId}`);

  const updatedPrimary = knownQuests.get(primaryQuestId);
  let editedCount = 0;
  for (const { guildId, channelId, messageId } of (primary.guildMessages || [])) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel) continue;
      const message = await channel.messages.fetch(messageId);
      if (!message) continue;
      const style = guildSettings.get(guildId)?.notificationStyle || 'default';
      const updatedPayload = buildQuestPayload(updatedPrimary, style);
      await message.edit(updatedPayload);
      editedCount++;
    } catch (err) {
      console.error(`  ⚠️  Could not edit message ${messageId} in ${channelId}:`, err.message);
    }
  }

  console.log(`  ✅ Edited ${editedCount}/${(primary.guildMessages || []).length} messages`);
  saveData();
}

async function notifyNewQuest(channelId, questData, guildId, questFilter = 'all') {
  try {
    console.log(`  📤 Attempting to send to channel ${channelId} with filter: ${questFilter}`);
    
    const channel = await client.channels.fetch(channelId);
    
    if (!channel) {
      console.error(`  ❌ Channel ${channelId} not found`);
      return;
    }
    
    // Check if quest matches the filter
    const rewardLower = questData.reward?.toLowerCase() || '';
    const hasOrbs = questData.reward && questData.reward.includes('Orbs');
    const hasDecoration = rewardLower.includes('decoration') || rewardLower.includes('dekoration');
    const hasItems = questData.reward && !hasOrbs && !hasDecoration;
    
    let shouldNotify = true;
    
    if (questFilter === 'orbs') {
      shouldNotify = hasOrbs;
      if (!shouldNotify) console.log(`  ⏭️  Skipping - quest has no orbs (channel filter: Orbs Only)`);
    } else if (questFilter === 'decorations') {
      shouldNotify = hasDecoration;
      if (!shouldNotify) console.log(`  ⏭️  Skipping - quest has no decorations (channel filter: Decorations Only)`);
    } else if (questFilter === 'items') {
      shouldNotify = hasItems;
      if (!shouldNotify) console.log(`  ⏭️  Skipping - quest is not a game item (channel filter: Items Only)`);
    } else if (questFilter === 'no_orbs') {
      // Backward compatibility: no_orbs = decorations + items
      shouldNotify = hasDecoration || hasItems;
      if (!shouldNotify) console.log(`  ⏭️  Skipping - quest has orbs (channel filter: No Orbs [legacy])`);
    }
    // else questFilter === 'all', shouldNotify stays true
    
    if (!shouldNotify) {
      return;
    }
    
    const notificationStyle = guildSettings.get(guildId)?.notificationStyle || 'default';

    let pingContent = '';
    if (guildId) {
      const questPingRoleId = guildSettings.get(guildId)?.questPingRoleId;
      if (questPingRoleId) pingContent = `<@&${questPingRoleId}>\n`;
    }

    const payload = buildQuestPayload(questData, notificationStyle, pingContent);
    const message = await channel.send(payload);

    console.log(`  ✅ Sent to <#${channelId}> [${notificationStyle}]`);

    // Track this quest — preserve allIds/guildMessages set before this call
    const existing = knownQuests.get(questData.id) || {};
    knownQuests.set(questData.id, {
      ...existing,
      id: questData.id,
      name: questData.name,
      game: questData.game || null,
      reward: questData.reward,
      tasks: questData.tasks || [],
      imageUrl: questData.imageUrl || null,
      type: questData.type,
      startsAt: questData.startsAt || null,
      expiresAt: questData.expiresAt,
      detectedAt: questData.detectedAt || new Date().toLocaleString(),
      messageId: message.id,
      allIds: questData.allIds?.length > (existing.allIds?.length || 0) ? questData.allIds.map(String) : (existing.allIds || [questData.id]),
      allLinks: questData.allLinks?.length > (existing.allLinks?.length || 0) ? questData.allLinks : (existing.allLinks || []),
      guildMessages: [...(existing.guildMessages || []), { guildId, channelId, messageId: message.id }],
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
        const prefs = userPreferences.get(userId) || {};
        const dmStyle = prefs.dmStyle || 'default';
        const payload = buildQuestPayload(questData, dmStyle);
        await user.send(payload);
        sentCount++;

        // Vote prompt every random 5-10 DMs
        const dmCount = (prefs.dmCount || 0) + 1;
        const nextVoteAt = prefs.nextVoteAt ?? (Math.floor(Math.random() * 6) + 5);
        if (dmCount >= nextVoteAt) {
          try {
            if (dmStyle === 'embed') {
              await user.send({ embeds: [{ color: 0x5865F2, description: '⭐ Enjoying QuestHunter? Help us grow!\n[🗳️ Vote on Top.gg](https://top.gg/bot/1474123878002462801/vote)' }] });
            } else {
              await user.send(`⭐ Enjoying QuestHunter? Vote for us: <https://top.gg/bot/1474123878002462801/vote>`);
            }
          } catch (_) {}
          prefs.dmCount = 0;
          prefs.nextVoteAt = Math.floor(Math.random() * 6) + 5;
        } else {
          prefs.dmCount = dmCount;
        }
        userPreferences.set(userId, prefs);
      } catch (error) {
        console.log(`  ⚠️  Could not send DM to user ${userId}: ${error.message}`);
      }
    }

    if (sentCount > 0) {
      console.log(`  ✅ Sent DM to ${sentCount} user(s)`);
      saveData();
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
        interaction.customId.startsWith('expired_next_')) {
      
      const userId = interaction.customId.split('_')[2];
      
      // Check if the button was pressed by the user who initiated the command
      if (interaction.user.id !== userId) {
        return await interaction.reply({
          content: '❌ You cannot use this pagination.',
          flags: MessageFlags.Ephemeral,
        });
      }
      
      const messageId = interaction.message.id;
      let state = paginationState.get(messageId);
      
      // If state not found with messageId, it might be an ephemeral message
      // Try to find it using userId-based lookup
      if (!state) {
        // Try to find any state for this user (last matching state)
        for (const [key, value] of paginationState) {
          if (value.userId === userId && key.startsWith('expired_')) {
            state = value;
            break;
          }
        }
      }
      
      if (!state) {
        return await interaction.reply({
          content: '❌ Pagination state not found. Please use the command again.',
          flags: MessageFlags.Ephemeral,
        });
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
            .setDisabled(state.page === state.totalPages) // Disable on last page
        )
      ];
      
      await interaction.update({
        embeds: [embed],
        components: components,
      });
      
      return;
    }

    // Handle help pagination buttons
    if (interaction.customId.startsWith('help_prev_') || interaction.customId.startsWith('help_next_')) {
      const userId = interaction.customId.split('_')[2];

      if (interaction.user.id !== userId) {
        return await interaction.reply({
          content: '❌ Only the user who opened this help menu can navigate it.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const state = paginationState.get(`help_${userId}`);
      if (!state) {
        return await interaction.reply({
          content: '❌ Session expired. Run `/help` again.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (interaction.customId.startsWith('help_next_') && state.page < state.pages.length - 1) state.page++;
      else if (interaction.customId.startsWith('help_prev_') && state.page > 0) state.page--;

      await interaction.update({
        embeds: [state.pages[state.page]],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`help_prev_${userId}`)
              .setLabel('◀ Previous')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(state.page === 0),
            new ButtonBuilder()
              .setCustomId(`help_next_${userId}`)
              .setLabel('Next ▶')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(state.page === state.pages.length - 1)
          )
        ],
      });
      return;
    }

    // Handle active quests pagination buttons
    if (interaction.customId.startsWith('activequests_prev_') ||
        interaction.customId.startsWith('activequests_next_')) {
      
      const userId = interaction.customId.split('_')[2];
      
      // Check if the button was pressed by the user who initiated the command
      if (interaction.user.id !== userId) {
        return await interaction.reply({
          content: '❌ You cannot use this pagination.',
          flags: MessageFlags.Ephemeral,
        });
      }
      
      const messageId = interaction.message.id;
      let state = paginationState.get(messageId);
      
      // If state not found with messageId, it might be an ephemeral message
      // Try to find it using userId-based lookup
      if (!state) {
        // Try to find any state for this user (last matching state)
        for (const [key, value] of paginationState) {
          if (value.userId === userId && key.startsWith('activequests_')) {
            state = value;
            break;
          }
        }
      }
      
      if (!state) {
        return await interaction.reply({
          content: '❌ Pagination state not found. Please use the command again.',
          flags: MessageFlags.Ephemeral,
        });
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
            .setDisabled(state.page === state.totalPages)
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
      if (!expiresAt || expiresAt === 'Unknown') return false;

      // ISO 8601 format - direct comparison
      if (expiresAt.includes('T') || (expiresAt.includes('-') && expiresAt.length > 7)) {
        return new Date(expiresAt).getTime() <= Date.now();
      }

      const today = new Date();
      const currentDay = today.getDate();
      const currentMonth = today.getMonth() + 1;
      const currentYear = today.getFullYear();

      let expireDay, expireMonth, expireYear = currentYear;

      if (expiresAt.includes('.')) {
        const parts = expiresAt.split('.');
        if (parts.length < 2) return false;
        expireDay = parseInt(parts[0]);
        expireMonth = parseInt(parts[1]);
      } else if (expiresAt.includes('/')) {
        const parts = expiresAt.split('/');
        if (parts.length < 2) return false;
        expireMonth = parseInt(parts[0]);
        expireDay = parseInt(parts[1]);
        if (parts.length === 3) expireYear = parseInt(parts[2]);
      } else {
        return false;
      }

      if (expireYear < currentYear) return true;
      if (expireYear === currentYear) {
        if (expireMonth < currentMonth) return true;
        if (expireMonth === currentMonth && expireDay <= currentDay) return true;
      }
      return false;
    }
    
    // Track which quests are currently sent by scraper
    const currentQuestIds = new Set(quests.map(q => q.id));
    
    // Find quests that were active but are no longer sent (expired/deleted by Discord)
    const expiredQuestsList = [];
    knownQuests.forEach((quest, questId) => {
      // Mark as expired if it's no longer sent by scraper (regardless of original expiry date)
      if (!currentQuestIds.has(questId)) {
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
      // Check by ID first, then by name+reward to catch regional duplicate IDs for the same quest
      const normalizedName = (quest.name || '').replace(/\s+Quest$/i, '').trim();
      const normalizedKey = `${normalizedName}||${quest.reward || ''}`;
      // Only check active knownQuests for name dedup — expired quests can return with a new ID
      // and should trigger a fresh notification (e.g. recurring quests that Discord re-issues)
      const isDuplicateByName = [...knownQuests.values()]
        .some(q => `${(q.name || '').replace(/\s+Quest$/i, '').trim()}||${q.reward || ''}` === normalizedKey);
      // Language variants have different names but same reward + expiry (e.g. Odyssey trailer in 13 languages)
      const isDuplicateByRewardExpiry = !!(quest.reward && quest.expiresAt && [...knownQuests.values()]
        .some(q => q.reward === quest.reward && q.expiresAt === quest.expiresAt));
      // Sibling: same name, different reward — group into existing message instead of new send
      const siblingQuest = !knownQuests.has(quest.id) && !isDuplicateByName && !isDuplicateByRewardExpiry
        ? [...knownQuests.values()].find(q =>
            (q.name || '').replace(/\s+Quest$/i, '').trim() === normalizedName && !q.primaryQuestId)
        : null;
      const isNew = !siblingQuest && !knownQuests.has(quest.id) && !isDuplicateByName && !isDuplicateByRewardExpiry;
      
      if (isNew) {
        newQuestCount++;
        console.log(`  🆕 NEW: ${quest.name} (${quest.reward}, Expires: ${quest.expiresAt})`);

        // Mark as known IMMEDIATELY to prevent double-sends from concurrent webhook calls
        knownQuests.set(quest.id, {
          id: quest.id,
          name: quest.name,
          game: quest.game || null,
          reward: quest.reward,
          tasks: quest.tasks || [],
          imageUrl: quest.imageUrl || null,
          type: quest.type,
          startsAt: quest.startsAt || null,
          expiresAt: quest.expiresAt,
          detectedAt: quest.detectedAt || new Date().toLocaleString(),
          allIds: quest.allIds?.length > 0 ? quest.allIds.map(String) : [quest.id],
          allLinks: quest.allLinks || [],
          guildMessages: [],
        });

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
      } else if (siblingQuest && botReady) {
        await groupSiblingQuest(siblingQuest.id, quest);
      } else {
        if (isDuplicateByRewardExpiry && !knownQuests.has(quest.id) && !isDuplicateByName) {
          // Find original quest and append this language variant's ID
          const original = [...knownQuests.values()].find(q => q.reward === quest.reward && q.expiresAt === quest.expiresAt);
          if (original) {
            const updatedAllIds = [...new Set([...(original.allIds || [original.id]), quest.id])];
            knownQuests.set(original.id, { ...original, allIds: updatedAllIds });
            saveData();
            console.log(`  🌍 LANG-VARIANT: ${quest.name} → added to quest ${original.id} (${updatedAllIds.length} links total)`);

            // Edit existing Discord notification messages to show updated link buttons
            for (const gm of (original.guildMessages || [])) {
              try {
                const ch = await client.channels.fetch(gm.channelId);
                const msg = await ch.messages.fetch(gm.messageId);
                const style = guildSettings.get(gm.guildId)?.notificationStyle || 'default';
                const updatedPayload = buildQuestPayload({ ...original, allIds: updatedAllIds }, style);
                await msg.edit(updatedPayload);
                console.log(`  ✏️  Updated message ${gm.messageId} in channel ${gm.channelId}`);
              } catch (e) {
                console.error(`  ⚠️  Could not edit message for lang variant:`, e.message);
              }
            }
          }
        } else {
          console.log(`  ℹ️  EXISTING: ${quest.name}`);
        }

        // Re-activate quest if scraper says it's active but it ended up in expiredQuests
        if (!knownQuests.has(quest.id)) {
          let expiredId = null;
          if (expiredQuests.has(quest.id)) {
            expiredId = quest.id;
          } else {
            for (const [k, v] of expiredQuests) {
              const vKey = `${(v.name || '').replace(/\s+Quest$/i, '').trim()}||${v.reward || ''}`;
              if (vKey === normalizedKey) { expiredId = k; break; }
            }
          }
          if (expiredId !== null) {
            const old = expiredQuests.get(expiredId);
            expiredQuests.delete(expiredId);
            knownQuests.set(quest.id, {
              ...(old || {}),
              id: quest.id,
              name: quest.name,
              game: quest.game || old?.game || null,
              reward: quest.reward,
              tasks: quest.tasks?.length > 0 ? quest.tasks : (old?.tasks || []),
              imageUrl: quest.imageUrl || old?.imageUrl || null,
              startsAt: quest.startsAt || old?.startsAt || null,
              expiresAt: quest.expiresAt,
              detectedAt: old?.detectedAt || quest.detectedAt || new Date().toLocaleString(),
            });
            console.log(`  🔄 Re-activated from expired: ${quest.name}`);
          }
        }

        // Refresh fields that may have changed or been missing from old scraper data
        const existingQuest = knownQuests.get(quest.id);
        if (existingQuest) {
          if (existingQuest.expiresAt !== quest.expiresAt) {
            console.log(`  🔄 Updated expiration date: ${existingQuest.expiresAt} → ${quest.expiresAt}`);
            existingQuest.expiresAt = quest.expiresAt;
          }
          if (quest.imageUrl && existingQuest.imageUrl !== quest.imageUrl) {
            console.log(`  🖼️  Updated imageUrl for ${quest.name}`);
            existingQuest.imageUrl = quest.imageUrl;
          }
          if (quest.tasks?.length > 0) {
            existingQuest.tasks = quest.tasks;
          }
          if (quest.game && !existingQuest.game) {
            existingQuest.game = quest.game;
          }
        }
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


// Stats API endpoint for web dashboard
app.get('/api/stats', (req, res) => {
  const totalServers = client.guilds.cache.size;
  const totalChannels = Array.from(guildSettings.values()).reduce((sum, s) => sum + (s.channels?.length || 0), 0);
  const totalUsers = client.guilds.cache.reduce((sum, g) => sum + (g.memberCount || 0), 0);
  const normName = (q) => (q.name || '').replace(/\s+Quest$/i, '').trim();
  const dedupeByName = (quests) => {
    const seen = new Set();
    return quests.filter(q => { const k = normName(q); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  const uniqueActive = dedupeByName(Array.from(knownQuests.values()));
  const activeNames = new Set(uniqueActive.map(normName));
  const uniqueExpired = dedupeByName(Array.from(expiredQuests.values()).filter(q => !activeNames.has(normName(q))));
  let totalOrbs = 0;
  for (const q of [...uniqueActive, ...uniqueExpired]) {
    if (/orb/i.test(q.reward || '')) {
      const m = (q.reward || '').match(/(\d+)/);
      if (m) totalOrbs += parseInt(m[1]);
    }
  }
  res.json({
    servers: totalServers,
    channels: totalChannels,
    activeQuests: uniqueActive.length,
    trackedQuests: uniqueActive.length + uniqueExpired.length,
    totalTrackedOrbs: totalOrbs,
    usersReached: totalUsers,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
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