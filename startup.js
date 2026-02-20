#!/usr/bin/env node

/**
 * Startup file for Linux/VPS
 * Runs both questScraper.js and index.js concurrently
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('🚀 Starting Quest Finder Bot System...\n');

// Check if running in Linux container (VPS)
if (process.platform === 'linux') {
  console.log('⚠️  Linux detected. If Chrome fails, manually run:');
  console.log('   apt-get update && apt-get install -y libnss3 libxss1 libexpat1 libfontconfig1 libfreetype6 libgbm1 libglib2.0-0 libgtk-3-0 libpango-1.0-0 libpangocairo-1.0-0 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxinerama1 libxrandr2 libxrender1 libxshmfence1 libxtst6 ca-certificates fonts-liberation libnspr4 libx11-6 libasound2\n');
}

// Start questScraper
const scraper = spawn('node', [path.join(__dirname, 'questScraper.js')], {
  stdio: 'inherit',
  detached: false
});

// Start index (Discord bot)
const bot = spawn('node', [path.join(__dirname, 'index.js')], {
  stdio: 'inherit',
  detached: false
});

// Handle process errors
scraper.on('error', (err) => {
  console.error('❌ Scraper process error:', err);
});

bot.on('error', (err) => {
  console.error('❌ Bot process error:', err);
});

// Handle process exit
scraper.on('exit', (code) => {
  console.log(`⚠️  Scraper process exited with code ${code}`);
});

bot.on('exit', (code) => {
  console.log(`⚠️  Bot process exited with code ${code}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM - shutting down gracefully...');
  scraper.kill('SIGTERM');
  bot.kill('SIGTERM');
  
  setTimeout(() => {
    process.exit(0);
  }, 5000);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT - shutting down gracefully...');
  scraper.kill('SIGINT');
  bot.kill('SIGINT');
  
  setTimeout(() => {
    process.exit(0);
  }, 5000);
});

console.log('✅ Both processes started. Press Ctrl+C to stop.\n');
