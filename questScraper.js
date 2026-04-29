const axios = require('axios');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

const QUESTS_JSON_URL = 'https://raw.githubusercontent.com/aamiaa/discord-api-diff/refs/heads/main/quests.json';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:3001/webhook/quests';
const ERROR_WEBHOOK = process.env.ERROR_WEBHOOK;
const NOTIFICATION_CHANNEL_ID = process.env.NOTIFICATION_CHANNEL_ID;
const SCAN_INTERVAL = parseInt(process.env.SCRAPER_INTERVAL) || 1800000; // 30 min default

const NOTIFIED_QUESTS_FILE = path.join(__dirname, 'data', 'notified_quests.json');
const LAST_SCAN_FILE = path.join(__dirname, 'data', 'last_scan.json');

const TASK_LABELS = {
  WATCH_VIDEO: 'Video',
  WATCH_VIDEO_ON_DESKTOP: 'Video (Desktop)',
  WATCH_VIDEO_ON_MOBILE: 'Video (Mobile)',
  PLAY_ON_DESKTOP: 'Desktop',
  STREAM_ON_DESKTOP: 'Desktop (Stream)',
  PLAY_ON_MOBILE: 'Mobile',
  PLAY_ON_PLAYSTATION: 'PlayStation',
  PLAY_ON_XBOX: 'Xbox',
  PLAY_ON_SWITCH: 'Switch',
  COMPLETE_ACHIEVEMENT: 'Achievement',
  PLAY_ACTIVITY: 'Activity',
  ACHIEVEMENT_IN_ACTIVITY: 'Achievement (Activity)',
};

async function sendErrorAlert(title, description, severity = 'warning') {
  if (!ERROR_WEBHOOK) return;
  const colors = { critical: 0xFF0000, warning: 0xFFA500, info: 0x3498DB };
  try {
    await axios.post(ERROR_WEBHOOK, {
      embeds: [{
        title: `🚨 ${title}`,
        description,
        color: colors[severity] || colors.warning,
        timestamp: new Date().toISOString(),
        footer: { text: 'QuestFinder Error Alert' }
      }]
    });
  } catch (e) {
    console.error('❌ Failed to send error alert:', e.message);
  }
}

function loadNotifiedQuestIds() {
  try {
    if (fs.existsSync(NOTIFIED_QUESTS_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(NOTIFIED_QUESTS_FILE, 'utf8')));
    }
  } catch (e) {
    console.warn('⚠️  Could not load notified quest IDs:', e.message);
  }
  return new Set();
}

function saveNotifiedQuestIds(ids) {
  try {
    fs.mkdirSync(path.dirname(NOTIFIED_QUESTS_FILE), { recursive: true });
    fs.writeFileSync(NOTIFIED_QUESTS_FILE, JSON.stringify(Array.from(ids), null, 2));
  } catch (e) {
    console.error('❌ Failed to save notified quest IDs:', e.message);
  }
}

function loadLastScanTime() {
  try {
    if (fs.existsSync(LAST_SCAN_FILE)) {
      return JSON.parse(fs.readFileSync(LAST_SCAN_FILE, 'utf8')).lastScanTime || 0;
    }
  } catch (e) {}
  return 0;
}

function saveLastScanTime() {
  try {
    fs.mkdirSync(path.dirname(LAST_SCAN_FILE), { recursive: true });
    fs.writeFileSync(LAST_SCAN_FILE, JSON.stringify({
      lastScanTime: Date.now(),
      lastScanDate: new Date().toISOString()
    }, null, 2));
  } catch (e) {
    console.error('❌ Failed to save last scan time:', e.message);
  }
}

let notifiedQuestIds = loadNotifiedQuestIds();

function parseReward(config) {
  const rewards = config.rewards_config?.rewards || config.rewards || [];
  if (rewards.length === 0) return null;

  const reward = rewards[0];

  // Discord Orbs
  if (reward.orb_quantity != null) {
    const base = reward.orb_quantity;
    const nitro = reward.premium_orb_quantity ?? Math.round(base * 1.2);
    return `${base} Discord Orbs (Nitro: ${nitro} Orbs)`;
  }

  // Named reward — detect if it's a Discord Avatar Decoration vs a game item
  const name = reward.messages?.name || reward.name;
  if (name) {
    const redemption = reward.messages?.redemption_instructions_by_platform?.['0'] || '';
    const isDecoration = /^(PLACEHOLDER|Default)$/i.test(redemption.trim());
    return isDecoration ? `${name} (Avatar Decoration)` : name;
  }

  return null;
}

function parseTasks(config) {
  const keys = Object.keys(config.task_config_v2?.tasks || config.task_config?.tasks || {});
  // Drop generic WATCH_VIDEO if a platform-specific variant is also present
  const hasSpecificVideo = keys.some(k => k === 'WATCH_VIDEO_ON_DESKTOP' || k === 'WATCH_VIDEO_ON_MOBILE');
  return keys
    .filter(k => !(k === 'WATCH_VIDEO' && hasSpecificVideo))
    .map(k => TASK_LABELS[k] || k);
}

function buildCdnUrl(questId, assetPath) {
  if (!assetPath) return null;
  // Some assets already include the full path e.g. "quests/123/456.mp4"
  if (assetPath.startsWith('quests/')) {
    return `https://cdn.discordapp.com/${assetPath}`;
  }
  return `https://cdn.discordapp.com/quests/${questId}/${assetPath}`;
}

const ORBS_GIF = 'https://i.imgur.com/v2Ra1GP.png';
//const ORBS_GIF = 'https://cdn3.emoji.gg/emojis/44565-orbs-animated.gif';

function getImageUrl(questId, config) {
  const rewards = config.rewards_config?.rewards || config.rewards || [];
  const r = rewards[0];

  // Reward asset if present (mp4/webm included), otherwise Orbs GIF
  if (r?.asset) return buildCdnUrl(questId, r.asset);
  return ORBS_GIF;
}

function parseActiveQuests(allQuests) {
  const now = new Date();
  // Sort newest starts_at first so real/recent quests take priority over permanent demo quests
  const sorted = [...allQuests].sort((a, b) =>
    new Date(b.config?.starts_at || 0) - new Date(a.config?.starts_at || 0)
  );
  const active = [];
  const seenKeys = new Map(); // name+reward → index in active array

  for (const entry of sorted) {
    const config = entry.config;
    if (!config || !config.starts_at || !config.expires_at) continue;

    const startsAt = new Date(config.starts_at);
    const expiresAt = new Date(config.expires_at);

    const maxExpiry = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
    if (startsAt > now || expiresAt <= now || expiresAt > maxExpiry) continue;

    const questName = config.messages?.quest_name || '';
    if (/^\[TEST\]/i.test(questName)) {
      console.log(`  ⏭️  Skipping test quest: ${questName}`);
      continue;
    }

    const reward = parseReward(config);
    if (!reward) {
      console.warn(`  ⚠️  Quest ${entry.id} has no parseable reward, skipping`);
      continue;
    }

    // Deduplicate regional variants — collect all IDs for the same quest
    const normalizedName = questName.replace(/\s+Quest$/i, '').trim();
    const dedupeKey = `${normalizedName}||${reward}`;
    if (seenKeys.has(dedupeKey)) {
      const existing = active[seenKeys.get(dedupeKey)];
      if (!existing.allIds.includes(String(entry.id))) {
        existing.allIds.push(String(entry.id));
        console.log(`  🔗 Added regional variant ID ${entry.id} to "${questName}"`);
      }
      continue;
    }

    const tasks = parseTasks(config);
    const name = config.messages?.quest_name || 'Unknown';
    const game = config.messages?.game_title || config.application?.name || 'Unknown';
    const imageUrl = getImageUrl(entry.id, config);

    seenKeys.set(dedupeKey, active.length);
    active.push({
      id: entry.id,
      allIds: [String(entry.id)],
      name,
      game,
      reward,
      tasks,
      imageUrl,
      startsAt: config.starts_at,
      expiresAt: config.expires_at,
      detectedAt: new Date().toLocaleString(),
      isNew: !notifiedQuestIds.has(entry.id),
    });
  }

  return active;
}

async function sendQuestsToBot(quests) {
  if (!NOTIFICATION_CHANNEL_ID) {
    console.warn('⚠️  NOTIFICATION_CHANNEL_ID not set');
    return;
  }
  try {
    await axios.post(WEBHOOK_URL, {
      quests,
      channelId: NOTIFICATION_CHANNEL_ID,
      timestamp: new Date()
    }, { timeout: 5000 });
    console.log('✅ Quests sent to bot successfully');
  } catch (e) {
    console.error('❌ Failed to send quests to bot:', e.message);
  }
}

async function fetchQuests() {
  console.log('🔍 Fetching quests from JSON feed...');
  try {
    const response = await axios.get(QUESTS_JSON_URL, { timeout: 15000 });
    const allQuests = response.data;

    if (!Array.isArray(allQuests)) {
      throw new Error('Unexpected response format - expected JSON array');
    }

    console.log(`📦 Loaded ${allQuests.length} total quests from feed`);

    const activeQuests = parseActiveQuests(allQuests);
    console.log(`📊 ${activeQuests.length} currently active quest(s)`);

    if (activeQuests.length === 0) {
      console.log('⚠️  No active quests found');
      return;
    }

    const newCount = activeQuests.filter(q => q.isNew).length;
    if (newCount > 0) {
      console.log(`\n✨ ${newCount} new quest(s) detected!`);
      for (const q of activeQuests.filter(q => q.isNew)) {
        console.log(`  📌 ${q.name} (${q.game})`);
        console.log(`     Reward: ${q.reward}`);
        console.log(`     Tasks:  ${q.tasks.join(' / ') || 'Unknown'}`);
        console.log(`     Expires: ${new Date(q.expiresAt).toLocaleDateString()}`);
      }
    } else {
      console.log(`✓ No new quests (${activeQuests.length} active)`);
    }

    for (const q of activeQuests) notifiedQuestIds.add(q.id);
    saveNotifiedQuestIds(notifiedQuestIds);

    await sendQuestsToBot(activeQuests);
    saveLastScanTime();

  } catch (error) {
    console.error('❌ Error fetching quests:', error.message);
    await sendErrorAlert('Quest Fetch Error', `Failed to fetch quest data:\n\`${error.message}\``, 'warning');
  }
}

async function start() {
  console.log('🚀 Discord Quest Scraper Started (JSON feed mode)');
  console.log(`🔗 Feed URL: ${QUESTS_JSON_URL}`);
  console.log(`🔗 Bot webhook: ${WEBHOOK_URL}`);
  console.log(`⏱️  Scanning every ${SCAN_INTERVAL / 1000}s`);
  console.log('---');

  const lastScanTime = loadLastScanTime();
  const timeSinceLastScan = Date.now() - lastScanTime;

  if (lastScanTime === 0) {
    console.log('📌 First startup - performing initial scan...');
    await fetchQuests();
  } else if (timeSinceLastScan >= SCAN_INTERVAL) {
    console.log(`⏳ ${Math.round(timeSinceLastScan / 1000)}s since last scan - performing scan...`);
    await fetchQuests();
  } else {
    const waitTime = Math.round((SCAN_INTERVAL - timeSinceLastScan) / 1000);
    console.log(`⏳ Last scan was ${Math.round(timeSinceLastScan / 1000)}s ago - waiting ${waitTime}s`);
  }

  setInterval(fetchQuests, SCAN_INTERVAL);
}

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  process.exit(0);
});

start();
