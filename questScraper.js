const puppeteer = require('puppeteer');
const axios = require('axios');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

const USER_TOKEN = process.env.USER_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:3001/webhook/quests';
const NOTIFICATION_CHANNEL_ID = process.env.NOTIFICATION_CHANNEL_ID;
const SCAN_INTERVAL = process.env.SCRAPER_INTERVAL || 3600000; // 1 hour default

let notifiedQuestIds = new Set();
let browser;
let userStatusInterval;

const QUEST_PAGE_URL = 'https://discord.com/quest-home?sort=most_recent';
const LAST_SCAN_FILE = path.join(__dirname, 'data', 'last_scan.json');

// Load last scan time
function loadLastScanTime() {
  try {
    if (fs.existsSync(LAST_SCAN_FILE)) {
      const data = JSON.parse(fs.readFileSync(LAST_SCAN_FILE, 'utf8'));
      return data.lastScanTime || 0;
    }
  } catch (error) {
    console.warn('⚠️  Could not load last scan time:', error.message);
  }
  return 0;
}

// Save last scan time
function saveLastScanTime() {
  try {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(LAST_SCAN_FILE, JSON.stringify({
      lastScanTime: Date.now(),
      lastScanDate: new Date().toISOString()
    }, null, 2));
  } catch (error) {
    console.error('❌ Failed to save last scan time:', error.message);
  }
}

async function initUserClient() {
  // Set invisible status via Discord API (no WebSocket connection)
  const setInvisibleStatus = async () => {
    try {
      if (!USER_TOKEN || USER_TOKEN.length < 10) {
        return; // Skip if token not valid
      }

      // Discord API expects 'invisible' status
      await axios.patch('https://discord.com/api/v10/users/@me/settings', 
        { status: 'invisible' },
        {
          headers: {
            'Authorization': USER_TOKEN,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0'
          }
        }
      );
      console.log('✅ Set account to invisible');
    } catch (err) {
      // Silently ignore errors - Discord may rate limit or reject the request
    }
  };
  
  // Set invisible status immediately multiple times
  await setInvisibleStatus();
  await new Promise(resolve => setTimeout(resolve, 100));
  await setInvisibleStatus();
  await new Promise(resolve => setTimeout(resolve, 100));
  await setInvisibleStatus();
  
  // Keep resetting status every 5 seconds to prevent Discord from changing it online
  userStatusInterval = setInterval(setInvisibleStatus, 5000);
}

async function initBrowser() {
  console.log('🌐 Launching browser...');
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  // Initialize user client to set invisible status
  await initUserClient();
}

function parseQuestTypeFromButton(buttonText) {
  if (buttonText.includes('Video')) return 'WATCH_VIDEO';
  if (buttonText.includes('annehmen') || buttonText.includes('Quest annehmen')) return 'PLAY_ON_DESKTOP';
  if (buttonText.includes('starten') || buttonText.includes('Quest starten')) return 'WATCH_VIDEO';
  return 'UNKNOWN';
}

function extractQuestsFromHTML(html) {
  const quests = [];
  
  // Debug: Check if HTML contains quest content
  if (!html.includes('quest-tile')) {
    console.log('⚠️  HTML does not contain quest tiles');
    return quests;
  }
  
  // Match all quest tiles more robustly
  const questTileRegex = /id="quest-tile-(\d+)"[\s\S]*?</g;
  
  // Find all quest tile IDs
  const tileMatches = [...html.matchAll(/id="quest-tile-(\d+)"/g)];
  console.log(`📍 Found ${tileMatches.length} quest tiles in HTML`);
  
  for (const tileMatch of tileMatches) {
    const questId = tileMatch[1];
    const tileStart = tileMatch.index;
    const nextTileIndex = html.indexOf('id="quest-tile-', tileStart + 1);
    const tileEnd = nextTileIndex === -1 ? html.length : nextTileIndex;
    const tileSection = html.substring(tileStart, tileEnd);
    
    // Check if quest is active (button NOT disabled)
    const isExpired = tileSection.includes('disabled=""') || tileSection.includes('disabled=');
    if (isExpired) {
      console.log(`  ⏰ Quest ${questId} is expired (skipping)`);
      continue;
    }
    
    // Extract quest name from h2 tag
    const nameMatch = tileSection.match(/<h2[^>]*>([^<]+)<\/h2>/);
    const questName = nameMatch ? nameMatch[1].trim() : 'Unknown';
    
    // Extract reward (Orbs)
    const orbMatch = tileSection.match(/Discord Orbs<|>(\d+)<.*?Discord Orbs|Discord Orbs<\/div>[\s\S]*?(\d+)[\s\S]*?Discord Orbs/);
    let orbsAmount = 700; // Default to 700
    
    // Try different patterns
    if (tileSection.includes('Discord Orbs')) {
      const orbPattern = tileSection.match(/>(\d+)<.*?Discord Orbs/);
      if (orbPattern) {
        orbsAmount = parseInt(orbPattern[1]);
      }
    }
    
    // Extract expiration date
    const expireMatch = tileSection.match(/Endet\s+(\d+\.\d+\.)/);
    const expiresAt = expireMatch ? expireMatch[1] : 'Unknown';
    
    // Extract button text to determine quest type
    const buttonMatch = tileSection.match(/<span[^>]*class="lineClamp1[^"]*"[^>]*>([^<]+)<\/span>/);
    const buttonText = buttonMatch ? buttonMatch[1].trim() : 'Unknown';
    const questType = parseQuestTypeFromButton(buttonText);
    
    console.log(`  ✓ Found active quest: ${questName} (Expires: ${expiresAt})`);
    
    quests.push({
      id: questId,
      name: questName,
      orbs: orbsAmount,
      expiresAt,
      type: questType,
      buttonLabel: buttonText
    });
  }
  
  return quests;
}

async function fetchQuests() {
  try {
    if (!browser) {
      await initBrowser();
    }

    console.log('📄 Opening Discord Quests page...');
    const page = await browser.newPage();

    // Set token in local storage before navigation
    await page.evaluateOnNewDocument((token) => {
      localStorage.setItem('token', `"${token}"`);
    }, USER_TOKEN);

    // Navigate to quest page
    try {
      await page.goto(QUEST_PAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (error) {
      console.log('⚠️  Discord Quests page load timeout, continuing anyway...');
    }

    // Wait for quests to load
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Get page HTML
    const html = await page.content();
    await page.close();

    // Parse active quests from HTML
    const activeQuests = extractQuestsFromHTML(html);

    if (!activeQuests || activeQuests.length === 0) {
      console.log('⚠️  No active quests found on page');
      return;
    }

    console.log(`📊 Found ${activeQuests.length} active quest(s)`);

    // Check for new quests
    const newQuests = [];
    for (const quest of activeQuests) {
      if (!notifiedQuestIds.has(quest.id)) {
        newQuests.push({
          id: quest.id,
          name: quest.name,
          reward: `${quest.orbs} Discord Orbs`,
          type: quest.type,
          buttonLabel: quest.buttonLabel,
          expiresAt: quest.expiresAt,
          detectedAt: new Date().toLocaleString()
        });
        notifiedQuestIds.add(quest.id);
      }
    }

    if (newQuests.length > 0) {
      console.log(`\n✨ Detected ${newQuests.length} new quest(s)!`);
      for (const q of newQuests) {
        console.log(`  📌 ${q.name}`);
        console.log(`     Reward: ${q.reward}`);
        console.log(`     Type: ${q.type} (${q.buttonLabel})`);
        console.log(`     Expires: ${q.expiresAt}`);
      }
      console.log('');
      await sendQuestsToBot(newQuests);
    } else {
      console.log('✓ No new quests detected');
    }

  } catch (error) {
    console.error('❌ Error fetching quests:', error.message);
  }
}

async function sendQuestsToBot(quests) {
  try {
    if (!NOTIFICATION_CHANNEL_ID) {
      console.warn('⚠️  NOTIFICATION_CHANNEL_ID not set');
      return;
    }

    console.log(`📤 Sending ${quests.length} quest(s) to bot webhook...`);

    const response = await axios.post(WEBHOOK_URL, {
      quests: quests,
      channelId: NOTIFICATION_CHANNEL_ID,
      timestamp: new Date()
    }, {
      timeout: 5000
    });

    console.log('✅ Quests sent to bot successfully');
    
    // Save the scan time after successful fetch
    saveLastScanTime();
    
    return response.data;

  } catch (error) {
    console.error('❌ Failed to send quests to bot:', error.message);
  }
}

async function start() {
  console.log('🚀 Discord Quest Scraper Started');
  console.log(`🔗 Webhook URL: ${WEBHOOK_URL}`);
  console.log(`⏱️  Scanning every ${SCAN_INTERVAL}ms`);
  console.log('---');

  // Check if enough time has passed since last scan
  const lastScanTime = loadLastScanTime();
  const timeSinceLastScan = Date.now() - lastScanTime;
  
  if (lastScanTime === 0) {
    console.log('📌 First startup - performing initial scan...');
    await fetchQuests();
  } else if (timeSinceLastScan >= SCAN_INTERVAL) {
    console.log(`⏳ ${Math.round(timeSinceLastScan / 1000)}s since last scan (>${Math.round(SCAN_INTERVAL / 1000)}s) - performing scan...`);
    await fetchQuests();
  } else {
    const waitTime = Math.round((SCAN_INTERVAL - timeSinceLastScan) / 1000);
    console.log(`⏳ Last scan was ${Math.round(timeSinceLastScan / 1000)}s ago - waiting ${waitTime}s before next scan`);
  }

  // Periodic scanning
  setInterval(fetchQuests, SCAN_INTERVAL);
}

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  if (browser) await browser.close();
  process.exit(0);
});

if (!USER_TOKEN) {
  console.error('❌ USER_TOKEN not found in .env file!');
  process.exit(1);
}

start();


