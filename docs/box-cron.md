# Box cron — retired

The agent box is **no longer** used for JGC status checks or workflow triggers.

- **Do not** re-enable crontab entries for `/workspace/jgc-status-cron/` (neither `run-check.sh` nor `trigger-workflow.sh`).
- Monitoring is **GitHub-only**: `.github/workflows/uptime.yml`
  - Soft backup schedule: `*/5 * * * *` (GitHub often delays/skips free-tier cron)
  - Primary cadence: the job loops the checker every ~5 minutes for ~50 minutes, commits/pushes `data/` each iteration (`git pull --rebase` before push), then chains the next run with `gh workflow run uptime.yml` (`actions: write`)
  - Concurrency group `uptime-check` with `cancel-in-progress: false`; chain step skips if another run is already `queued`/`in_progress`

Legacy clone/scripts under `/workspace/jgc-status-cron` may still exist on the box but are inactive.
