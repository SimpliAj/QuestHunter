# QuestHunter Changelog

---

## 2026-04-27

🔧 **QuestHunter Update**

🐛 **Quest Re-Detection Fix**
→ Quests that returned with a new Discord Quest ID (e.g. recurring quests continuing a new phase) were silently skipped
→ Root cause: expired quests with the same name were blocking detection of the new ID
→ Fix: duplicate-by-name check now only compares against **active** quests, not expired ones
→ Recurring quests will now properly notify when Discord re-issues them with a new ID
