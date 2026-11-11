#!/usr/bin/env node

/**
 * Startup file for Linux/VPS
 * Runs both questScraper.js and index.js concurrently
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Starting Quest Finder Bot System...\n');

// Check if running in Linux container (VPS)
if (process.platform === 'linux') {
  console.log('⚠️  Linux detected. If Chrome fails, manually run:');
  console.log('   apt-get update && apt-get install -y libnss3 libxss1 libexpat1 libfontconfig1 libfreetype6 libgbm1 libglib2.0-0 libgtk-3-0 libpango-1.0-0 libpangocairo-1.0-0 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxinerama1 libxrandr2 libxrender1 libxshmfence1 libxtst6 ca-certificates fonts-liberation libnspr4 libx11-6 libasound2\n');
}

let shuttingDown = false;
let scraper = null;
let bot = null;

// 2026-09-22, user-reported (questfinder pm2 process showed "online" for
// days while the actual Discord bot was dead): spawn() only starts each
// child ONCE -- if index.js (the bot) crashes on an unhandled 'error'
// event (e.g. a raw WebSocket "socket hang up" that discord.js's own
// reconnect logic never got a chance to see), nothing here ever restarted
// it. pm2 only supervises THIS wrapper process, which itself never exits
// just because a child died, so pm2 keeps reporting "online" the whole
// time -- a total blind spot. Scraper kept running independently the
// whole time too, repeatedly failing "ECONNREFUSED" trying to reach the
// dead bot's webhook, which is what actually surfaced the issue in logs.
// Fix: respawn either child a few seconds after an unexpected exit, with
// a capped consecutive-failure counter per child so a genuinely broken
// binary/config doesn't restart-loop forever silently.
const RESPAWN_DELAY_MS = 5000;
const MAX_CONSECUTIVE_RESPAWNS = 10;
let scraperRespawns = 0;
let botRespawns = 0;

function startScraper() {
  scraper = spawn('node', [path.join(__dirname, 'questScraper.js')], {
    stdio: 'inherit',
    detached: false,
    cwd: __dirname,
  });
  scraper.on('error', (err) => {
    console.error('❌ Scraper process error:', err);
  });
  scraper.on('exit', (code) => {
    console.log(`⚠️  Scraper process exited with code ${code}`);
    if (shuttingDown) return;
    scraperRespawns += 1;
    if (scraperRespawns > MAX_CONSECUTIVE_RESPAWNS) {
      console.error(`❌ Scraper exited ${scraperRespawns} times in a row -- giving up on auto-restart, needs manual attention`);
      return;
    }
    console.log(`🔁 Restarting scraper in ${RESPAWN_DELAY_MS}ms (attempt ${scraperRespawns})...`);
    setTimeout(startScraper, RESPAWN_DELAY_MS);
  });
}

function startBot() {
  bot = spawn('node', [path.join(__dirname, 'index.js')], {
    stdio: 'inherit',
    detached: false,
    cwd: __dirname,
  });
  bot.on('error', (err) => {
    console.error('❌ Bot process error:', err);
  });
  bot.on('exit', (code) => {
    console.log(`⚠️  Bot process exited with code ${code}`);
    if (shuttingDown) return;
    botRespawns += 1;
    if (botRespawns > MAX_CONSECUTIVE_RESPAWNS) {
      console.error(`❌ Bot exited ${botRespawns} times in a row -- giving up on auto-restart, needs manual attention`);
      return;
    }
    console.log(`🔁 Restarting bot in ${RESPAWN_DELAY_MS}ms (attempt ${botRespawns})...`);
    setTimeout(startBot, RESPAWN_DELAY_MS);
  });
}

startScraper();
startBot();

// Handle graceful shutdown
function shutdown(signal) {
  console.log(`\n🛑 Received ${signal} - shutting down gracefully...`);
  shuttingDown = true;
  if (scraper) scraper.kill(signal);
  if (bot) bot.kill(signal);

  setTimeout(() => {
    process.exit(0);
  }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log('✅ Both processes started. Press Ctrl+C to stop.\n');
