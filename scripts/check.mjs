#!/usr/bin/env node
/**
 * JGC Status Monitor — läuft in GitHub Actions (Node 20, keine deps).
 * Prüft Gameserver (A2S), Website, Forum und Discord-Bot (Guild-Widget).
 */
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA, '.state.json');

const INTERVAL_MS = 5 * 60 * 1000;
const RAW_KEEP_MS = 25 * 60 * 60 * 1000; // ~25h
const DAY_KEEP = 90;
const FAIL_CONFIRM = 2; // consecutive fails before DOWN

const MONITORS = [
  {
    id: 'gameserver',
    name: "Gameserver Garry's Mod",
    kind: 'a2s',
    host: '159.195.60.189',
    port: 27016,
    icon: '🎮',
    link: 'https://markgrafde.github.io/jgc-connect/',
  },
  {
    id: 'website',
    name: 'Website',
    kind: 'http',
    url: 'https://www.justgamingcommunity.de',
    icon: '🌐',
    link: 'https://www.justgamingcommunity.de',
  },
  {
    id: 'forum',
    name: 'Forum',
    kind: 'http',
    url: 'https://www.justgamingcommunity.de/forum/',
    icon: '💬',
    link: 'https://www.justgamingcommunity.de/forum/',
  },
  {
    id: 'discord-bot',
    name: 'Discord-Bot JGC | Alpha',
    kind: 'discord-widget',
    guildId: '826123377688576060',
    botUserId: '1307101425851175004',
    botUsername: 'JGC | Alpha',
    icon: '🤖',
    link: 'https://discord.com/invite/sEqkkGnF',
  },
];

// ─── A2S ─────────────────────────────────────────────────────────────────────

const HEADER_SIMPLE = 0xffffffff;
const TYPE_INFO = 0x49;
const TYPE_CHALLENGE = 0x41;
const TYPE_GOLDSRC = 0x6d;

function buildA2SRequest(challenge) {
  const base = Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
    Buffer.from('Source Engine Query\0', 'latin1'),
  ]);
  return challenge ? Buffer.concat([base, challenge]) : base;
}

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.offset = 0;
  }
  byte() {
    if (this.offset >= this.buf.length) throw new Error('A2S: Paket zu kurz');
    return this.buf.readUInt8(this.offset++);
  }
  short() {
    if (this.offset + 2 > this.buf.length) throw new Error('A2S: Paket zu kurz');
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }
  string() {
    const end = this.buf.indexOf(0, this.offset);
    if (end === -1) throw new Error('A2S: String ohne Terminator');
    const s = this.buf.toString('utf8', this.offset, end);
    this.offset = end + 1;
    return s;
  }
  skip(n) {
    this.offset += n;
  }
  get remaining() {
    return this.buf.length - this.offset;
  }
}

function parseSourceInfo(payload, ping) {
  const r = new Reader(payload);
  r.skip(1);
  const name = r.string();
  const map = r.string();
  r.string(); // folder
  r.string(); // game
  r.short(); // appId
  const players = r.byte();
  const maxPlayers = r.byte();
  return { name, map, players, maxPlayers, ping };
}

function parseGoldSrcInfo(payload, ping) {
  const r = new Reader(payload);
  r.string();
  const name = r.string();
  const map = r.string();
  r.string();
  r.string();
  const players = r.byte();
  const maxPlayers = r.byte();
  return { name, map, players, maxPlayers, ping };
}

function queryA2SInfo(host, port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let finished = false;
    let sentAt = 0;
    let challengeRounds = 0;
    const finish = (err, info) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* */
      }
      if (err) reject(err);
      else resolve(info);
    };
    const timer = setTimeout(() => finish(new Error(`A2S: Timeout nach ${timeoutMs} ms`)), timeoutMs);
    const send = (packet) => {
      sentAt = Date.now();
      socket.send(packet, port, host, (err) => {
        if (err) finish(err);
      });
    };
    socket.on('error', (err) => finish(err));
    socket.on('message', (msg) => {
      try {
        const ping = Date.now() - sentAt;
        if (msg.length < 5) throw new Error('A2S: Antwort zu kurz');
        const header = msg.readUInt32LE(0);
        if (header !== HEADER_SIMPLE) throw new Error('A2S: Split-/unbekannte Antwort');
        const type = msg.readUInt8(4);
        const payload = msg.subarray(5);
        if (type === TYPE_CHALLENGE) {
          if (payload.length < 4) throw new Error('A2S: Ungültige Challenge');
          if (++challengeRounds > 3) throw new Error('A2S: Zu viele Challenge-Runden');
          send(buildA2SRequest(payload.subarray(0, 4)));
          return;
        }
        if (type === TYPE_INFO) return finish(null, parseSourceInfo(payload, ping));
        if (type === TYPE_GOLDSRC) return finish(null, parseGoldSrcInfo(payload, ping));
        throw new Error(`A2S: Unerwarteter Typ 0x${type.toString(16)}`);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    try {
      send(buildA2SRequest());
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

async function checkA2S(mon) {
  try {
    const info = await queryA2SInfo(mon.host, mon.port, 3000);
    return {
      up: true,
      ms: info.ping,
      extra: {
        players: info.players,
        max: info.maxPlayers,
        map: info.map,
        name: info.name,
      },
    };
  } catch (first) {
    try {
      const info = await queryA2SInfo(mon.host, mon.port, 3000);
      return {
        up: true,
        ms: info.ping,
        extra: {
          players: info.players,
          max: info.maxPlayers,
          map: info.map,
          name: info.name,
        },
      };
    } catch (err) {
      return { up: false, ms: null, error: (err instanceof Error ? err.message : String(err)).slice(0, 120) };
    }
  }
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function checkHttp(mon) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  const start = Date.now();
  try {
    const res = await fetch(mon.url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'JGC-Status/1.0 (+https://markgrafde.github.io/jgc-status/)' },
    });
    const ms = Date.now() - start;
    const ok = res.status >= 200 && res.status < 400;
    return { up: ok, ms, extra: { status: res.status }, error: ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return {
      up: false,
      ms: Date.now() - start,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    };
  } finally {
    clearTimeout(t);
  }
}

// ─── Discord Widget ──────────────────────────────────────────────────────────

async function checkDiscordBot(mon) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  const start = Date.now();
  try {
    const res = await fetch(`https://discord.com/api/guilds/${mon.guildId}/widget.json`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'JGC-Status/1.0' },
    });
    const ms = Date.now() - start;
    if (!res.ok) {
      return { up: false, ms, unknown: false, error: `Widget HTTP ${res.status}` };
    }
    const data = await res.json();
    const members = Array.isArray(data.members) ? data.members : [];
    // Widget anonymisiert IDs — Match per Username; optional status online/idle/dnd
    const bot = members.find(
      (m) =>
        m &&
        (m.username === mon.botUsername ||
          (typeof m.username === 'string' && m.username.includes('JGC | Alpha'))),
    );
    if (!bot) {
      // Widget listet Bots manchmal nicht → unbekannt (nicht als down werten)
      return {
        up: null,
        ms,
        unknown: true,
        error: 'Bot nicht im Widget (Bots oft ausgeblendet)',
        extra: { presenceCount: data.presence_count ?? members.length },
      };
    }
    const online = ['online', 'idle', 'dnd'].includes(bot.status);
    return {
      up: online,
      ms,
      extra: { status: bot.status, presenceCount: data.presence_count ?? members.length },
      error: online ? undefined : `Status: ${bot.status}`,
    };
  } catch (err) {
    return {
      up: false,
      ms: Date.now() - start,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    };
  } finally {
    clearTimeout(t);
  }
}

async function runCheck(mon) {
  if (mon.kind === 'a2s') return checkA2S(mon);
  if (mon.kind === 'http') return checkHttp(mon);
  if (mon.kind === 'discord-widget') return checkDiscordBot(mon);
  return { up: false, ms: null, error: 'unknown kind' };
}

// ─── Data helpers ────────────────────────────────────────────────────────────

function dayKey(ts) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts));
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

function emptyMonitorData(mon) {
  return {
    id: mon.id,
    name: mon.name,
    icon: mon.icon,
    kind: mon.kind,
    link: mon.link || null,
    samples: [],
    days: [],
  };
}

function upsertDay(days, d, up, ms) {
  let entry = days.find((x) => x.d === d);
  if (!entry) {
    entry = { d, up: 0, down: 0, sumMs: 0, nMs: 0 };
    days.push(entry);
  }
  if (up) {
    entry.up += 1;
    if (typeof ms === 'number' && Number.isFinite(ms)) {
      entry.sumMs += ms;
      entry.nMs += 1;
    }
  } else {
    entry.down += 1;
  }
}

function pruneDays(days) {
  days.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  while (days.length > DAY_KEEP) days.shift();
  return days;
}

function calcUptime(samplesOrDays, mode) {
  if (mode === 'samples') {
    const relevant = samplesOrDays.filter((s) => s.up !== null);
    if (!relevant.length) return null;
    const up = relevant.filter((s) => s.up).length;
    return Math.round((up / relevant.length) * 10000) / 100;
  }
  // days: {up, down}
  let u = 0,
    d = 0;
  for (const day of samplesOrDays) {
    u += day.up || 0;
    d += day.down || 0;
  }
  const tot = u + d;
  if (!tot) return null;
  return Math.round((u / tot) * 10000) / 100;
}

function avgMs(samples) {
  const vals = samples.filter((s) => s.up && typeof s.ms === 'number').map((s) => s.ms);
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function formatDurationDe(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days} Tag${days === 1 ? '' : 'e'}`);
  if (h) parts.push(`${h} Std`);
  if (m || !parts.length) parts.push(`${m} Min`);
  return parts.join(' ');
}

// ─── Discord alert ───────────────────────────────────────────────────────────

async function sendAlert(webhookUrl, { monitor, from, to, extra, error }) {
  if (!webhookUrl) return;
  const isDown = to === 'down';
  const color = isDown ? 0xf408ff : 0x00d2ff;
  const title = isDown ? `🔴 ${monitor.name} offline` : `🟢 ${monitor.name} wieder online`;
  const fields = [];
  if (error) fields.push({ name: 'Details', value: String(error).slice(0, 200), inline: false });
  if (extra?.map) fields.push({ name: 'Map', value: String(extra.map), inline: true });
  if (extra?.players != null)
    fields.push({ name: 'Spieler', value: `${extra.players}/${extra.max ?? '?'}`, inline: true });
  if (extra?.status) fields.push({ name: 'Presence', value: String(extra.status), inline: true });
  const body = {
    username: 'JGC Status',
    embeds: [
      {
        title,
        color,
        fields,
        footer: { text: 'JGC Status · github.com/MarkgrafDE/jgc-status' },
        timestamp: new Date().toISOString(),
      },
    ],
  };
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn('[alert] webhook HTTP', res.status);
  } catch (err) {
    console.warn('[alert] failed:', err instanceof Error ? err.message : err);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const now = Date.now();
  const today = dayKey(now);
  const webhookUrl = (process.env.DISCORD_WEBHOOK_URL || '').trim();
  const state = loadJson(STATE_FILE, { monitors: {}, incidents: [] });
  if (!state.monitors) state.monitors = {};
  if (!Array.isArray(state.incidents)) state.incidents = [];

  const results = [];

  for (const mon of MONITORS) {
    const raw = await runCheck(mon);
    const prev = state.monitors[mon.id] || {
      status: 'unknown',
      failCount: 0,
      lastUp: null,
      lastDown: null,
    };

    // unknown (widget missing bot) → keep previous confirmed status, don't alert
    let confirmed;
    if (raw.up === null || raw.unknown) {
      confirmed = prev.status === 'unknown' ? 'unknown' : prev.status;
      // don't increment failCount
    } else if (raw.up) {
      prev.failCount = 0;
      confirmed = 'up';
    } else {
      prev.failCount = (prev.failCount || 0) + 1;
      // First observation: if never seen up, mark down immediately (gameserver stopped on purpose)
      if (prev.status === 'unknown' || prev.status === 'down') {
        confirmed = 'down';
      } else if (prev.failCount >= FAIL_CONFIRM) {
        confirmed = 'down';
      } else {
        confirmed = 'up'; // still considered up until confirmed
      }
    }

    const oldStatus = prev.status;
    const transition =
      (oldStatus === 'up' || oldStatus === 'unknown') && confirmed === 'down'
        ? 'down'
        : oldStatus === 'down' && confirmed === 'up'
          ? 'up'
          : null;

    // Incidents
    if (transition === 'down') {
      state.incidents.unshift({
        id: `${mon.id}-${now}`,
        monitorId: mon.id,
        monitorName: mon.name,
        start: now,
        end: null,
        status: 'ongoing',
      });
    } else if (transition === 'up') {
      const open = state.incidents.find(
        (i) => i.monitorId === mon.id && i.status === 'ongoing',
      );
      if (open) {
        open.end = now;
        open.status = 'resolved';
        open.durationMs = open.end - open.start;
        open.duration = formatDurationDe(open.durationMs);
      }
    }

    if (transition) {
      await sendAlert(webhookUrl, {
        monitor: mon,
        from: oldStatus,
        to: confirmed,
        extra: raw.extra,
        error: raw.error,
      });
      console.log(`[alert] ${mon.id}: ${oldStatus} → ${confirmed}`);
    }

    prev.status = confirmed;
    prev.failCount = confirmed === 'up' ? 0 : prev.failCount;
    prev.lastCheck = now;
    prev.lastResult = raw.up;
    if (confirmed === 'up') prev.lastUp = now;
    if (confirmed === 'down') prev.lastDown = now;
    prev.extra = raw.extra || null;
    prev.error = raw.error || null;
    prev.ms = raw.ms;
    state.monitors[mon.id] = prev;

    // Persist per-monitor data
    const file = path.join(DATA, `${mon.id}.json`);
    const data = loadJson(file, emptyMonitorData(mon));
    data.name = mon.name;
    data.icon = mon.icon;
    data.link = mon.link || null;
    data.kind = mon.kind;

    // Sample: use confirmed status for history (unknown samples skipped for uptime)
    const sample = {
      t: now,
      up: confirmed === 'unknown' ? null : confirmed === 'up',
      ms: typeof raw.ms === 'number' ? raw.ms : null,
    };
    if (raw.extra) {
      if (raw.extra.players != null) sample.p = raw.extra.players;
      if (raw.extra.max != null) sample.m = raw.extra.max;
      if (raw.extra.map) sample.map = String(raw.extra.map).slice(0, 40);
    }
    data.samples.push(sample);
    const cutoff = now - RAW_KEEP_MS;
    data.samples = data.samples.filter((s) => s.t >= cutoff);

    // Daily aggregate only counts confirmed up/down
    if (confirmed === 'up' || confirmed === 'down') {
      upsertDay(data.days, today, confirmed === 'up', raw.ms);
      pruneDays(data.days);
    }

    // Compute uptimes for this monitor
    const samples24 = data.samples.filter((s) => s.t >= now - 24 * 3600_000);
    const uptime24h = calcUptime(samples24, 'samples');
    const days7 = data.days.slice(-7);
    const days30 = data.days.slice(-30);
    const days90 = data.days.slice(-90);
    const uptime7d = calcUptime(days7, 'days');
    const uptime30d = calcUptime(days30, 'days');
    const uptime90d = calcUptime(days90, 'days');

    // Daily bar data for UI
    const dayBars = days90.map((d) => {
      const tot = (d.up || 0) + (d.down || 0);
      const pct = tot ? Math.round(((d.up || 0) / tot) * 10000) / 100 : null;
      return {
        d: d.d,
        pct,
        up: d.up || 0,
        down: d.down || 0,
        avgMs: d.nMs ? Math.round(d.sumMs / d.nMs) : null,
      };
    });

    data.meta = {
      status: confirmed,
      ms: raw.ms,
      extra: raw.extra || null,
      error: confirmed === 'down' ? raw.error || null : null,
      uptime: { '24h': uptime24h, '7d': uptime7d, '30d': uptime30d, '90d': uptime90d },
      avgMs24h: avgMs(samples24),
      updatedAt: now,
    };
    data.dayBars = dayBars;

    saveJson(file, data);

    results.push({
      id: mon.id,
      name: mon.name,
      icon: mon.icon,
      kind: mon.kind,
      link: mon.link || null,
      status: confirmed,
      ms: raw.ms,
      extra: raw.extra || null,
      error: confirmed === 'down' ? raw.error || null : null,
      uptime: data.meta.uptime,
      avgMs24h: data.meta.avgMs24h,
    });

    console.log(
      `[check] ${mon.id}: ${confirmed}` +
        (raw.ms != null ? ` ${raw.ms}ms` : '') +
        (raw.extra?.map ? ` map=${raw.extra.map}` : '') +
        (raw.extra?.players != null ? ` ${raw.extra.players}/${raw.extra.max}` : '') +
        (raw.unknown ? ' (unknown/widget)' : '') +
        (raw.error && confirmed !== 'up' ? ` err=${raw.error}` : ''),
    );
  }

  // Overall
  const countable = results.filter((r) => r.status !== 'unknown');
  const downCount = countable.filter((r) => r.status === 'down').length;
  const upCount = countable.filter((r) => r.status === 'up').length;
  let overall = 'ok';
  let overallLabel = 'Alle Systeme betriebsbereit';
  if (downCount === 0 && upCount > 0) {
    overall = 'ok';
    overallLabel = 'Alle Systeme betriebsbereit';
  } else if (downCount > 0 && upCount > 0) {
    overall = 'partial';
    overallLabel = 'Teilweise Störung';
  } else if (downCount > 0 && upCount === 0) {
    overall = 'down';
    overallLabel = 'Störung';
  } else {
    overall = 'unknown';
    overallLabel = 'Status unbekannt';
  }

  // Keep last 50 incidents
  state.incidents = state.incidents.slice(0, 50);
  const incidentsPublic = state.incidents.slice(0, 10).map((i) => ({
    id: i.id,
    monitorId: i.monitorId,
    monitorName: i.monitorName,
    start: i.start,
    end: i.end,
    status: i.status,
    durationMs: i.end ? i.end - i.start : now - i.start,
    duration: i.duration || formatDurationDe(i.end ? i.end - i.start : now - i.start),
  }));

  const summary = {
    updatedAt: now,
    overall,
    overallLabel,
    monitors: results,
    incidents: incidentsPublic,
    note: 'GitHub Actions Cron ist best-effort (manchmal 5–15 Min Verspätung).',
  };
  saveJson(path.join(DATA, 'summary.json'), summary);
  saveJson(STATE_FILE, state);

  console.log(`[done] overall=${overall} at ${new Date(now).toISOString()}`);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
