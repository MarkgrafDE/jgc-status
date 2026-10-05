# Interim Box-Cron (Messungen)

Solange der GitHub-Actions-Workflow nicht gepusht werden kann (OAuth ohne `workflow`-Scope), läuft der Checker alle 5 Min auf der Agent-Box:

- Script: `/workspace/jgc-status-cron/run-check.sh`
- Clone: `/workspace/jgc-status-cron` (tracked `origin/main`, **ohne** lokales Workflow-Commit)
- Log: `/workspace/jgc-status-cron.log`
- Crontab: `2-59/5 * * * *` (Minute 2,7,12,…)

**Sobald der Workflow live ist:** Box-Cron deaktivieren (`crontab -l | grep -v jgc-status-cron | crontab -`), sonst doppelte Checks/Alerts.
