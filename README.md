# JGC Status

Öffentliche Statusseite und Monitoring für **Just Gaming Community**.

- **Statusseite:** https://markgrafde.github.io/jgc-status/
- **Checks:** alle 5 Minuten via GitHub Actions (best-effort; Cron kann 5–15 Min verspätet sein)
- **Monitore:** Garry’s-Mod-Gameserver (A2S), Website, Forum, Discord-Bot (Guild-Widget)
- **Alerts:** Discord-Webhook bei Statuswechsel (Down erst nach 2 Fehlversuchen)

Keine Serverkosten — nur dieses öffentliche Repo + GitHub Pages + Actions.

## Workflow aktivieren (einmalig)

Der OAuth-Token auf der Agent-Box hat kein `workflow`-Scope. Bitte einmalig:

```bash
gh auth refresh -h github.com -s repo,workflow,read:org,gist
cd /workspace/jgc-status
git push origin main   # pusht .github/workflows/uptime.yml
gh workflow run uptime.yml --repo MarkgrafDE/jgc-status
```

Oder im GitHub-Web-UI: Datei `scripts/uptime.workflow.yml` nach `.github/workflows/uptime.yml` kopieren („Add file“).

