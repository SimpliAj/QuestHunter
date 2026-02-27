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

const QUEST_PAGE_URL = 'https://discord.com/quest-home?sort=most_recent';
const NOTIFIED_QUESTS_FILE = path.join(__dirname, 'data', 'notified_quests.json');

// Load notified quest IDs
function loadNotifiedQuestIds() {
  try {
    if (fs.existsSync(NOTIFIED_QUESTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(NOTIFIED_QUESTS_FILE, 'utf8'));
      return new Set(data);
    }
  } catch (error) {
    console.warn('⚠️  Could not load notified quest IDs:', error.message);
  }
  return new Set();
}

// Save notified quest IDs
function saveNotifiedQuestIds(questIds) {
  try {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(NOTIFIED_QUESTS_FILE, JSON.stringify(Array.from(questIds), null, 2));
  } catch (error) {
    console.error('❌ Failed to save notified quest IDs:', error.message);
  }
}

let notifiedQuestIds = loadNotifiedQuestIds();
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
    console.log(`📄 HTML length: ${html.length} characters`);
    // Check if it's a login page
    if (html.includes('login') || html.includes('signin')) {
      console.log('❌ HTML appears to be a login page - token may be invalid or expired');
    }
    return quests;
  }
  
  // Extract quest tiles more robustly using a different approach
  // Match the complete div container for each quest
  const questTileRegex = /<div[^>]*id="quest-tile-(\d+)"[^>]*class="[^"]*questTile[^"]*"[^>]*>[\s\S]*?<\/div>\s*(?=<div[^>]*id="quest-tile-|$)/g;
  
  const allMatches = [...html.matchAll(questTileRegex)];
  console.log(`📍 Found ${allMatches.length} quest tile divs in HTML`);
  
  // Alternative: Use a simpler approach - find all quest tile IDs first
  const questIdMatches = [...html.matchAll(/id="quest-tile-(\d+)"/g)];
  console.log(`📊 Found ${questIdMatches.length} quest IDs in HTML`);
  
  let skippedCount = 0;
  let processedCount = 0;
  
  for (let i = 0; i < questIdMatches.length; i++) {
    const tileMatch = questIdMatches[i];
    const questId = tileMatch[1];
    const tileStart = tileMatch.index;
    
    // Debug: Log specific quest IDs we're looking for
    if (['1473407935970410724', '1471215421297266778', '1471627613574533173', '1471589719186870377'].includes(questId)) {
      console.log(`  🔍 Processing quest ${questId}...`);
    }
    
    // Find the end of this quest tile - look for the next "quest-tile" OR the closing div
    // Search more carefully to find where this specific quest container ends
    let tileEnd;
    if (i < questIdMatches.length - 1) {
      // There's a next quest - find where this one ends before the next one starts
      const nextTileStart = questIdMatches[i + 1].index;
      // Go back from nextTileStart to find the closing </div> that belongs to this quest
      let searchStart = nextTileStart - 1;
      let divCount = 0;
      while (searchStart > tileStart) {
        if (html[searchStart] === '>' && html[searchStart - 1] === '/' && html[searchStart - 2] === 'v' && html[searchStart - 3] === 'i' && html[searchStart - 4] === 'd') {
          divCount++;
          if (divCount >= 1) {
            tileEnd = searchStart + 1;
            break;
          }
        }
        searchStart--;
      }
      if (!tileEnd) tileEnd = nextTileStart;
    } else {
      // Last quest - include everything until the end
      tileEnd = html.length;
    }
    
    const tileSection = html.substring(tileStart, tileEnd);
    
    // Debug: Show what we extracted
    if (tileSection.length < 100) {
      console.log(`  ⚠️  Quest ${questId} has very short extraction (${tileSection.length} chars) - might be parsing error`);
    }
    
    // Debug: Check if button element exists
    const hasButton = tileSection.includes('<button');
    if (!hasButton) {
      console.log(`  ⚠️  Quest ${questId} - No button element found in tile section`);
    }
    
    // Extract quest name - try multiple patterns
    let questName = 'Unknown';
    const nameMatch = tileSection.match(/<h2[^>]*class="[^"]*questName[^"]*"[^>]*>([^<]+)<\/h2>/);
    if (nameMatch) {
      questName = nameMatch[1].trim();
    } else {
      // Fallback: look for any h2 tag
      const h2Match = tileSection.match(/<h2[^>]*>([^<]+)<\/h2>/);
      if (h2Match) {
        questName = h2Match[1].trim();
      }
    }
    
    // Log EVERY quest found, regardless of status
    console.log(`  📌 Quest ${questId}: ${questName}`);
    
    // Extract reward - MUST match one of the patterns, NO FALLBACK
    let reward = null;
    
    // The HTML structure is:
    // For Orbs: <span>NUMBER</span> Discord Orbs
    // For other rewards: <span>REWARD_NAME</span> beanspruchen
    
    // Pattern 1: Discord Orbs - exact match with closing tag
    const orbPattern = tileSection.match(/>(\d+)<\/span>\s*Discord Orbs/);
    if (orbPattern) {
      const orbsAmount = parseInt(orbPattern[1]);
      reward = `${orbsAmount} Discord Orbs`;
      console.log(`  💰 ${questName}: ${orbsAmount} Discord Orbs`);
    }
    
    // Pattern 2: Non-Orb reward - text between opening and closing span in header context
    if (!reward) {
      // Look for span in the header section that contains the reward text
      // The pattern is: <span class="text-md/semibold_cf4812 header__956c6"...>REWARD_TEXT</span> beanspruchen
      const rewardSpanMatch = tileSection.match(/header__956c6[^>]*>([^<]+)<\/span>\s+beanspruchen/);
      if (rewardSpanMatch) {
        reward = rewardSpanMatch[1].trim();
        console.log(`  🎁 ${questName}: ${reward}`);
      }
    }
    
    // Pattern 3: Alternative for non-Orb rewards where text appears in first span after "Beanspruche"
    if (!reward) {
      const beanspruchMatch = tileSection.match(/Beanspruche\s+<span[^>]*>([^<]+)<\/span>/);
      if (beanspruchMatch) {
        const potentialReward = beanspruchMatch[1].trim();
        // Make sure it's not just styling information
        if (potentialReward && !potentialReward.startsWith('style=') && potentialReward.length > 2) {
          reward = potentialReward;
          console.log(`  🎁 ${questName}: ${reward}`);
        }
      }
    }
    
    // If still no reward found, log critical error but don't use fallback
    if (!reward) {
      console.error(`  ❌ CRITICAL: Could not extract reward for quest ${questId} (${questName})`);
      console.error(`     First 200 chars of tile: ${tileSection.substring(0, 200)}`);
      continue; // Skip this quest entirely instead of using fallback
    }
    
    // Extract expiration date - look for "Endet" or "Quest endet am"
    let expiresAt = 'Unknown';
    const expireMatch1 = tileSection.match(/Endet\s+(\d+\.\d+\.)/);
    if (expireMatch1) {
      expiresAt = expireMatch1[1];
    } else {
      // Also try "Quest endet am" pattern
      const expireMatch2 = tileSection.match(/Quest endet am\s+(\d+\.\d+\.)/);
      if (expireMatch2) {
        expiresAt = expireMatch2[1];
      }
    }
    
    // Extract button text - look for the actual button text
    let buttonText = 'Unknown';
    
    // Pattern 1: Look for span with specific class inside button (for "Quest annehmen" buttons)
    const buttonMatch1 = tileSection.match(/<button[^>]*>[\s\S]*?<span[^>]*class="[^"]*lineClamp1[^"]*"[^>]*>([^<]+)<\/span>/);
    if (buttonMatch1) {
      buttonText = buttonMatch1[1].trim();
    } else {
      // Pattern 2: Just find any span with lineClamp1 class (for "Quest annehmen" buttons)
      const buttonMatch2 = tileSection.match(/<span[^>]*class="[^"]*lineClamp1[^"]*"[^>]*>([^<]+)<\/span>/);
      if (buttonMatch2) {
        buttonText = buttonMatch2[1].trim();
      } else {
        // Pattern 3: Look for hiddenVisually span (for "Video-Quest starten" buttons with different structure)
        const buttonMatch3 = tileSection.match(/<span[^>]*class="[^"]*hiddenVisually[^"]*"[^>]*>([^<]+)<\/span>/);
        if (buttonMatch3) {
          buttonText = buttonMatch3[1].trim();
        }
      }
    }
    
    // Debug: Show button text for problematic quests
    if (['1473407935970410724', '1471215421297266778', '1471627613574533173', '1471589719186870377', '1470483893688991745'].includes(questId)) {
      console.log(`  🔍 Quest ${questId} extracted button text: "${buttonText}"`);
    }
    
    // Check if quest is expired by looking for expiration text in button
    // Only skip if button text is EXACTLY an expiration phrase, not if it just contains those words
    // German: "Quest endet am X.X." / English: "Ends on X.X." or similar
    const isExpiredQuest = buttonText.match(/^(Quest )?endet am \d+\.\d+\.$/) || buttonText.match(/^Ends? on \d+\.\d+\.?$/);
    if (isExpiredQuest) {
      console.log(`  ⏰ Quest ${questId} expired: "${buttonText}" (skipping)`);
      skippedCount++;
      continue;
    }
    
    // Log if we're processing a previously missing quest
    if (['1473407935970410724', '1471215421297266778', '1471627613574533173', '1471589719186870377'].includes(questId)) {
      console.log(`  ✅ Found missing quest ${questId} with button: "${buttonText}"`);
    }
    
    const questType = parseQuestTypeFromButton(buttonText);
    
    if (questName === 'Unknown' || buttonText === 'Unknown') {
      console.log(`  ⚠️  Quest ${questId} - Failed to extract full info (name: ${questName}, button: "${buttonText}")`);
      // Debug: Show first 500 chars of tile section
      console.log(`     Section preview: ${tileSection.substring(0, 500)}`);
    }
    
    console.log(`  ✓ Found active quest: ${questName} (Expires: ${expiresAt}, Type: ${questType})`);
    
    quests.push({
      id: questId,
      name: questName,
      reward: reward,
      expiresAt,
      type: questType,
      buttonLabel: buttonText
    });
    processedCount++;
  }
  
  console.log(`📈 Processed: ${processedCount} active, Skipped: ${skippedCount} expired`);
  
  return quests;
}

async function fetchQuests() {
  try {
    let localBrowser;
    try {
      console.log('🔍 Scanning for new quests...');
      console.log('📄 Launching Puppeteer browser...');
      console.log(`⏱️  Browser launch timeout: 60 seconds`);
      
      // Add explicit timeout for browser launch
      const launchPromise = puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-web-resources',
          '--disable-extensions',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage'
        ],
        timeout: 60000
      });

      localBrowser = await Promise.race([
        launchPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Puppeteer launch timeout (60s)')), 65000)
        )
      ]);

      console.log('✅ Browser launched successfully');
      console.log('📄 Opening Discord Quests page...');
      const page = await localBrowser.newPage();
      
      // Mask the browser as a normal Chrome browser
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      
      // Stealth mode - remove webdriver property
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
        });
      });
      
      // Add a timeout handler
      page.on('error', (error) => {
        console.error('❌ Page error:', error);
      });

      // Set token in authorization header AND local storage
      await page.setExtraHTTPHeaders({
        'Authorization': USER_TOKEN
      });

      // Also set token in local storage for good measure
      await page.evaluateOnNewDocument((token) => {
        localStorage.setItem('token', `"${token}"`);
      }, USER_TOKEN);

      // Navigate to quest page with better error handling
      console.log(`🌐 Navigating to ${QUEST_PAGE_URL}...`);
      try {
        const response = await page.goto(QUEST_PAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        console.log(`📥 Page response status: ${response?.status()}`);
        if (!response || !response.ok()) {
          console.log(`⚠️  Warning: Page returned status ${response?.status()}`);
        }
      } catch (error) {
        console.error('❌ Navigation error details:', error.message);
        console.log('⚠️  Discord Quests page load timeout, continuing anyway...');
      }

      // Wait for quests to load - try to wait for specific elements
      try {
        await page.waitForSelector('[id^="quest-tile-"]', { timeout: 5000 });
      } catch (error) {
        console.log('⚠️  Quest tiles did not load within timeout');
      }

      // Get page HTML
      const html = await page.content();
      await page.close();

      // Debug: Check if we're on login page
      if (html.includes('login') || html.includes('signin') || html.includes('You are being redirected')) {
        console.error('❌ ERROR: Page appears to be a login page - authentication failed!');
        console.error('   This means the USER_TOKEN in .env is invalid or expired.');
        console.log('📋 To fix this:');
        console.log('   1. Go to https://discord.com');
        console.log('   2. Open Developer Tools (F12) → Application → Local Storage');
        console.log('   3. Find the "token" key');
        console.log('   4. Copy the full token value (without quotes)');
        console.log('   5. Update USER_TOKEN in .env');
        // Still save the HTML for debugging
        const debugFile = path.join(__dirname, 'quests_debug.html');
        fs.writeFileSync(debugFile, html, 'utf-8');
        console.log(`📝 HTML saved to ${debugFile} for debugging`);
        return;
      }

      // Save HTML for debugging
      const debugFile = path.join(__dirname, 'quests_debug.html');
      fs.writeFileSync(debugFile, html, 'utf-8');
      console.log(`📝 HTML saved to ${debugFile} for debugging`);

      // Parse active quests from HTML
      const activeQuests = extractQuestsFromHTML(html);

      if (!activeQuests || activeQuests.length === 0) {
        console.log('⚠️  No active quests found on page');
        return;
      }

      console.log(`📊 Found ${activeQuests.length} active quest(s)`);

      // Send ALL active quests to the bot (for proper expired quest detection)
      // But only notify about quests we haven't notified about before
      const questsToSend = activeQuests.map(quest => ({
        id: quest.id,
        name: quest.name,
        reward: `${quest.orbs} Discord Orbs`,
        type: quest.type,
        buttonLabel: quest.buttonLabel,
        expiresAt: quest.expiresAt,
        detectedAt: new Date().toLocaleString(),
        isNew: !notifiedQuestIds.has(quest.id) // Mark which quests are new
      }));

      // Track all active quest IDs as notified
      for (const quest of activeQuests) {
        notifiedQuestIds.add(quest.id);
      }
      saveNotifiedQuestIds(notifiedQuestIds);

      const newQuestsCount = questsToSend.filter(q => q.isNew).length;
      
      if (newQuestsCount > 0) {
        console.log(`\n✨ Detected ${newQuestsCount} new quest(s)!`);
        for (const q of questsToSend.filter(q => q.isNew)) {
          console.log(`  📌 ${q.name}`);
          console.log(`     Reward: ${q.reward}`);
          console.log(`     Type: ${q.type} (${q.buttonLabel})`);
          console.log(`     Expires: ${q.expiresAt}`);
        }
        console.log('');
      } else {
        console.log(`✓ No new quests (${activeQuests.length} active)`);
      }

      if (questsToSend.length > 0) {
        await sendQuestsToBot(questsToSend);
      }

    } catch (error) {
      console.error('❌ Error in fetchQuests:', error.message);
      console.error('🔍 Full error details:', error.toString());
      if (error.stack) {
        console.error('📍 Stack trace:', error.stack);
      }
    } finally {
      // Always close browser after scan
      if (localBrowser) {
        await localBrowser.close();
        console.log('✅ Browser closed - account set to invisible');
      }
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
  process.exit(0);
});

if (!USER_TOKEN) {
  console.error('❌ USER_TOKEN not found in .env file!');
  process.exit(1);
}

start();


