# QuestHunter 🎯

> **Automatically detect and broadcast Discord Quests** to your Discord servers with this powerful Node.js bot.

---

## 📋 Overview

QuestHunter is a Discord bot + Puppeteer scraper that automatically detects new Discord quests and broadcasts them to your servers. Perfect for quest hunters who want to stay updated without manually checking Discord!

Invite the bot through [this link](https://discord.com/oauth2/authorize?client_id=1474123878002462801&permissions=2147699712&integration_type=0&scope=bot) if you dont want to host your own bot.

> [!NOTE]
> **This Bot was made for QuestPhantom Users to help them keep track of new quests for spoofing those:**
> https://github.com/SimpliAj/QuestPhantom


---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🕷️ **Automated Scraping** | Puppeteer-based scraper detects all active Discord quests |
| 📢 **Multi-Server Broadcasting** | Send quest notifications to multiple Discord servers simultaneously |
| 🎯 **Smart Filtering** | Filter quests by reward type (Orbs only, No Orbs, All quests) |
| 💾 **Persistent Storage** | Remembers last scan time and known quests (no duplicate notifications) |
| 🔔 **Role Mentions** | Automatically ping specific roles when new quests arrive |
| ⏱️ **Configurable Interval** | Set custom scan intervals (default: 60 minutes) |
| 🛠️ **Easy Setup** | Simple slash commands for server configuration |
| 🌐 **VPS Ready** | Deploy on Linux servers with automatic dependency installation |

---

## 🚀 Quick Start

### Prerequisites
- Node.js v18+ 
- Discord Bot Token
- User Token (for quest scraper)
- A Discord server where you can test the bot

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/questfinder.git
   cd questfinder/bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   # Edit .env and add your tokens
   ```

4. **Run locally**
   ```bash
   npm run all
   ```

5. **Deploy to VPS** (using PM2)
   ```bash
   npm install -g pm2
   pm2 start startup.js --name questhunter
   pm2 save
   pm2 startup
   ```

---

## 📖 Configuration

### .env File

```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_APP_ID=your_app_id_here
USER_TOKEN=your_user_token_here
WEBHOOK_URL=http://localhost:3001/webhook/quests
WEBHOOK_PORT=3001
SCRAPER_INTERVAL=3600000          # 60 minutes in milliseconds
ENABLE_SPOOFGUIDE=true             # Enable/disable spoofguide command
```

### Slash Commands

Once the bot is in your server, use these commands:

| Command | Description | Usage |
|---------|-------------|-------|
| `/setup-channel` | Add a channel to receive quest notifications | `/setup-channel channel: #notifications filter: orbs` |
| `/questpingrole` | Set a role to mention when new quests arrive | `/questpingrole role: @QuestHunters` |
| `/serverconfig` | View current server configuration | `/serverconfig` |
| `/latestquest` | Show the most recently detected quest | `/latestquest` |
| `/activequests` | List all active/tracked quests | `/activequests` |
| `/spoofguide` | Get QuestPhantom spoofing guide | `/spoofguide` |

---

## 🔧 Deployment

### Local Development
```bash
npm run all
# Runs both scraper and bot concurrently
```

### VPS Deployment (Linux/Ubuntu)

1. **Upload files to VPS**
   ```bash
   scp -r bot/ root@your-vps:/home/discord/
   ```

2. **Install dependencies**
   ```bash
   cd /home/discord
   npm install
   ```

3. **Start with PM2**
   ```bash
   npm install -g pm2
   npm install
   node startup.js    # Auto-installs Chrome dependencies
   pm2 start startup.js --name questhunter
   pm2 save
   pm2 startup
   ```

4. **Monitor**
   ```bash
   pm2 status
   pm2 logs questhunter
   ```

---

## 🎯 Quest Types Detected

- ✅ **WATCH_VIDEO** - Video quest (700 Discord Orbs)
- ✅ **PLAY_ON_DESKTOP** - Desktop game quest (700 Discord Orbs)
- ✅ Other quest types with reward data

---

## ⚠️ Legal Notice

> [!WARNING]
> **Use at your own risk!**
> 
> This bot uses undocumented Discord APIs via web scraping. Discord may update their website and break the scraper. Use responsibly at your own discretion.

---

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| Bot not online | Check Discord token in `.env` is correct |
| No quests detected | Verify USER_TOKEN is valid; check quest page loads |
| Messages not sending | Check channel permissions and bot roles |
| Port 3001 in use | Kill process: `lsof -ti:3001 \| xargs kill -9` |
| Chrome fails on Linux | Run: `apt-get install -y libnss3 libxss1...` (see startup.js) |

---

## 📝 License

This project is provided as-is for personal use.

---

## 🤝 Contributing

Found a bug? Have an improvement? Feel free to submit an issue or pull request!

---

**Made with ❤️ for Discord quest hunters**






