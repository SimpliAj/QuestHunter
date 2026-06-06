# QuestHunter Changelog

---

## 2026-04-27 (v2)

🔧 **QuestHunter Update**

✨ **New: `/setup` Wizard Command**
→ Admins can now configure QuestHunter in one guided flow
→ Step 1: Select quest notification channel
→ Step 2: Choose filter (All / Orbs Only / Decorations Only / Game Items Only)
→ Step 3: Optionally set expired quest channel (or skip)
→ `/setup-channel` and `/setup-expired-channel` still work as before

---

## 2026-04-27

🔧 **QuestHunter Update**

🐛 **Quest Re-Detection Fix**
→ Quests that returned with a new Discord Quest ID (e.g. recurring quests continuing a new phase) were silently skipped
→ Root cause: expired quests with the same name were blocking detection of the new ID
→ Fix: duplicate-by-name check now only compares against **active** quests, not expired ones
→ Recurring quests will now properly notify when Discord re-issues them with a new ID
