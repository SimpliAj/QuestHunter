# <img src="https://i.imgur.com/yTgBkjM.png" width="50" alt="QuestHunter">  QuestHunter

> **Automatically detect and broadcast Discord Quests** to your Discord servers with this powerful Node.js bot.

---

## 📋 Overview

QuestHunter is a Discord bot that automatically detects new Discord quests and broadcasts them to your servers. It uses a live JSON data feed for fast and reliable quest detection — no scraping required.

Invite the bot through [this link](https://discord.com/oauth2/authorize?client_id=1474123878002462801&permissions=2147699712&integration_type=0&scope=bot) if you don't want to host your own bot.

> [!NOTE]
> **This Bot was made for QuestPhantom Users to help them keep track of new quests for spoofing those:**
> https://github.com/SimpliAj/QuestPhantom

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔍 **Live Quest Detection** | Pulls from a live JSON feed — fast, reliable, no scraping |
| 📢 **Multi-Server Broadcasting** | Send quest notifications to multiple Discord servers simultaneously |
| 🎯 **Smart Filtering** | Filter quests by reward type (Orbs only, No Orbs, All quests) |
| 🎨 **Notification Styles** | Choose between a clean text message or a rich embed card per server |
| 🖼️ **Reward Thumbnails** | Automatically shows the reward image for each quest |
| 💾 **Persistent Storage** | Remembers known quests — no duplicate notifications |
| 🔔 **Role Mentions** | Automatically ping specific roles when new quests arrive |
| ⏱️ **Configurable Interval** | Set custom scan intervals (default: 30 minutes) |
| 🛠️ **Easy Setup** | Simple slash commands for server configuration |
| 🌐 **VPS Ready** | Deploy on Linux servers with PM2 |

---

## 🚀 Quick Start

### Prerequisites
- Node.js v18+
- Discord Bot Token
- A Discord server where you can test the bot

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/questfinder.git
   cd questfinder
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   # Edit .env and fill in your values
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
WEBHOOK_URL=http://localhost:3001/webhook/quests
WEBHOOK_PORT=3001
SCRAPER_INTERVAL=1800000          # 30 minutes in milliseconds
NOTIFICATION_CHANNEL_ID=          # Default channel ID for notifications
ERROR_WEBHOOK=                    # Optional: webhook URL for error alerts
ADMIN_USER_ID=                    # Your Discord user ID (for /quest-test)
```

### Slash Commands

| Command | Description | Permission |
|---------|-------------|------------|
| `/setup-channel` | Add a channel to receive quest notifications | Manage Server |
| `/questpingrole` | Set a role to ping when new quests arrive | Manage Server |
| `/notification-style` | Choose notification style: Default or Embed | Manage Server |
| `/remove` | Remove a configured channel or ping role | Manage Server |
| `/setup-expired-channel` | Set a channel for expired quest notifications | Manage Server |
| `/serverconfig` | View current server configuration | — |
| `/activequests` | List all currently active quests | — |
| `/expiredquests` | View all expired quests | — |
| `/latestquest` | Show the most recently detected quest | — |
| `/dm-notifications` | Toggle DM notifications for new quests | — |
| `/spoofguide` | Get the QuestPhantom spoofing guide | — |
| `/stats` | View bot statistics | — |
| `/help` | Show all available commands | — |
| `/feedback` | Submit a bug report or feature request | — |
| `/quest-test` | Send test quest notifications in current channel | Bot Admin only |

#### `/notification-style` — Notification Style
Set how quest alerts look in your server:
- **Default** — Simple text message with quest link
- **Embed** — Rich card showing reward image, task type, and expiry date

Only members with **Manage Server** permission can use this command.

---

## 🎯 Quest Types Detected

| Task Key | Label |
|----------|-------|
| `WATCH_VIDEO` | Video |
| `WATCH_VIDEO_ON_DESKTOP` | Video (Desktop) |
| `WATCH_VIDEO_ON_MOBILE` | Video (Mobile) |
| `PLAY_ON_DESKTOP` | Desktop |
| `STREAM_ON_DESKTOP` | Desktop (Stream) |
| `PLAY_ON_MOBILE` | Mobile |
| `PLAY_ON_PLAYSTATION` | PlayStation |
| `PLAY_ON_XBOX` | Xbox |
| `PLAY_ON_SWITCH` | Switch |
| `COMPLETE_ACHIEVEMENT` | Achievement |
| `PLAY_ACTIVITY` | Activity |

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
   scp -r . root@your-vps:/home/discord/questfinder/
   ```

2. **Install dependencies**
   ```bash
   cd /home/discord/questfinder
   npm install
   ```

3. **Start with PM2**
   ```bash
   npm install -g pm2
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

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| Bot not online | Check `DISCORD_TOKEN` in `.env` is correct |
| No quests detected | Check internet access and JSON feed URL |
| Messages not sending | Check channel permissions and bot roles |
| Port 3001 in use | Kill process: `lsof -ti:3001 \| xargs kill -9` |

---

## ⚠️ Legal Notice

> [!WARNING]
> **Use at your own risk!**
>
> This bot uses a public third-party JSON feed for quest data. Quest availability and data accuracy depend on the feed being up to date.

---

## 📝 License

This project is provided as-is for personal use.

---

## 🤝 Contributing

Found a bug? Have an improvement? Feel free to submit an issue or pull request!

---
