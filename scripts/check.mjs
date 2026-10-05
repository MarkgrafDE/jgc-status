#!/usr/bin/env node
/**
 * JGC Status Monitor — läuft in GitHub Actions (Node 20, keine deps).
 * Prüft Gameserver (A2S), Website, Forum und Discord-Bot (Guild-Widget).
 */
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveServiceState,
  fetchPteroPowerState,
  isDowntimeState,
  isMaintenanceState,
  STATE_META,
} from './ptero.mjs';

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
    name: "Gameserver MRP",
    kind: 'a2s',
    host: '159.195.60.189',
    port: 27015,
    icon: '🎮',
    link: 'https://markgrafde.github.io/jgc-connect/?ip=159.195.60.189:27015',
    pteroEnv: 'PTERO_MAIN_SERVER_ID',
  },
  {
    id: 'testserver',
    name: "Gameserver Testserver",
    kind: 'a2s',
    host: '159.195.60.189',
    port: 27016,
    icon: '🧪',
    link: 'https://markgrafde.github.io/jgc-connect/?ip=159.195.60.189:27016',
    pteroEnv: 'PTERO_GAME_SERVER_ID',
    /** Secondary: Wartung hier beeinträchtigt das Global-Banner nicht */
    critical: false,
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
    pteroEnv: 'PTERO_BOT_SERVER_ID',
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

function upsertDay(days, d, kind, ms) {
  // kind: 'up' | 'down' | 'maint'
  let entry = days.find((x) => x.d === d);
  if (!entry) {
    entry = { d, up: 0, down: 0, maint: 0, sumMs: 0, nMs: 0 };
    days.push(entry);
  }
  if (kind === 'up') {
    entry.up += 1;
    if (typeof ms === 'number' && Number.isFinite(ms)) {
      entry.sumMs += ms;
      entry.nMs += 1;
    }
  } else if (kind === 'maint') {
    entry.maint = (entry.maint || 0) + 1;
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

async function sendAlert(webhookUrl, { monitor, from, to, derived, cause, extra, error, infoOnly }) {
  if (!webhookUrl) return;
  const meta = STATE_META[derived] || STATE_META.unknown;
  let color = 0x00d2ff;
  let title;
  if (infoOnly) {
    color = derived === 'restart' ? 0xf59e0b : 0x6b7280;
    title = `${meta.emoji} ${monitor.name}: ${meta.label}`;
  } else if (to === 'down') {
    color = 0xf408ff;
    title = `${meta.emoji} ${monitor.name}: ${meta.label}`;
  } else {
    color = 0x00d2ff;
    title = `🟢 ${monitor.name} wieder online`;
  }
  const fields = [];
  if (cause) fields.push({ name: 'Ursache', value: String(cause), inline: true });
  if (error) fields.push({ name: 'Details', value: String(error).slice(0, 200), inline: false });
  if (extra?.map) fields.push({ name: 'Map', value: String(extra.map), inline: true });
  if (extra?.players != null)
    fields.push({ name: 'Spieler', value: `${extra.players}/${extra.max ?? '?'}`, inline: true });
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


/** One-time style repair: reclassify false downtime as maintenance (esp. Testserver). */
function backfillMaintenanceSamples() {
  for (const mon of MONITORS) {
    const file = path.join(DATA, `${mon.id}.json`);
    const data = loadJson(file, null);
    if (!data || !Array.isArray(data.samples)) continue;
    let changed = false;
    for (const s of data.samples) {
      // Explicit stopped/restart already null; convert false downs that were crashed/stopped era
      if (s.up === false) {
        const d = s.derived;
        if (d === 'stopped' || d === 'restart' || d === 'crashed' || mon.critical === false) {
          // For secondary monitors: any historical failure while we know it's often stopped -> maint
          // Also reclassify crashed samples on secondary as maint (intentional stop mislabeled)
          if (mon.critical === false || d === 'stopped' || d === 'restart') {
            s.up = null;
            if (!s.derived || d === 'crashed') s.derived = 'stopped';
            changed = true;
          }
        }
      }
    }
    if (!changed && !(mon.critical === false)) continue;

    // Rebuild days from samples (Berlin day key)
    const byDay = new Map();
    for (const s of data.samples) {
      const d = dayKey(s.t);
      if (!byDay.has(d)) byDay.set(d, { d, up: 0, down: 0, maint: 0, sumMs: 0, nMs: 0 });
      const e = byDay.get(d);
      if (s.up === true) {
        e.up += 1;
        if (typeof s.ms === 'number' && Number.isFinite(s.ms)) {
          e.sumMs += s.ms;
          e.nMs += 1;
        }
      } else if (s.up === false) e.down += 1;
      else e.maint += 1;
    }
    data.days = pruneDays([...byDay.values()]);
    // dayBars refreshed later in main loop; still write samples/days now
    if (changed || mon.critical === false) {
      // force rewrite days even if only secondary
      saveJson(file, data);
    }
  }
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  backfillMaintenanceSamples();
  const now = Date.now();
  const today = dayKey(now);
  const webhookUrl = (process.env.DISCORD_WEBHOOK_URL || '').trim();
  const pteroUrl = (process.env.PTERO_URL || '').trim();
  const pteroKey = (process.env.PTERO_CLIENT_KEY || '').trim();
  const state = loadJson(STATE_FILE, { monitors: {}, incidents: [] });
  if (!state.monitors) state.monitors = {};
  if (!Array.isArray(state.incidents)) state.incidents = [];

  const results = [];

  for (const mon of MONITORS) {
    const raw = await runCheck(mon);
    const prev = state.monitors[mon.id] || {
      status: 'unknown',
      derived: 'unknown',
      failCount: 0,
      pteroPower: null,
      lastUp: null,
      lastDown: null,
    };

    // Optional Pterodactyl power state (gameserver / bot)
    let pteroPower = 'unknown';
    let pteroSource = 'none';
    const pteroId = mon.pteroEnv ? (process.env[mon.pteroEnv] || '').trim() : '';
    if (pteroUrl && pteroKey && pteroId) {
      try {
        const p = await fetchPteroPowerState(pteroUrl, pteroKey, pteroId);
        if (p.ok) {
          pteroPower = p.power;
          pteroSource = p.source;
        }
      } catch {
        /* Panel down → Probe-only */
      }
    }

    const probeOk = raw.up === true;
    const probeUnknown = raw.up === null || raw.unknown;
    let derived = deriveServiceState({
      power: pteroPower,
      probeOk: probeUnknown ? false : probeOk,
      prevPower: prev.pteroPower || null,
    });
    // Widget-unknown + no ptero → keep previous
    if (probeUnknown && pteroPower === 'unknown') {
      derived = prev.derived && prev.derived !== 'unknown' ? prev.derived : 'unknown';
    }

    // Confirmation: only for disconnected (running but probe fail). Maintenance immediate.
    let confirmedDerived = derived;
    if (derived === 'disconnected') {
      prev.failCount = (prev.failCount || 0) + 1;
      if (prev.derived === 'disconnected' || prev.status === 'down' || prev.failCount >= FAIL_CONFIRM) {
        confirmedDerived = 'disconnected';
      } else if (prev.derived === 'online' || prev.status === 'up') {
        // still treat as online until 2 fails
        confirmedDerived = 'online';
      }
    } else if (derived === 'online') {
      prev.failCount = 0;
      confirmedDerived = 'online';
    } else {
      prev.failCount = 0;
      confirmedDerived = derived;
    }

    // Map to status badge bucket
    let confirmed;
    if (confirmedDerived === 'online') confirmed = 'up';
    else if (confirmedDerived === 'restart') confirmed = 'restart';
    else if (confirmedDerived === 'stopped') confirmed = 'stopped';
    else if (confirmedDerived === 'unknown') confirmed = 'unknown';
    else confirmed = 'down'; // disconnected | crashed

    const cause =
      confirmedDerived === 'disconnected'
        ? 'Verbindung getrennt'
        : confirmedDerived === 'crashed'
          ? 'Abgestürzt'
          : confirmedDerived === 'restart'
            ? 'Neustart'
            : confirmedDerived === 'stopped'
              ? 'Gestoppt'
              : null;

    const oldStatus = prev.status;
    const oldDerived = prev.derived || 'unknown';
    const becameDown =
      isDowntimeState(confirmedDerived) && !isDowntimeState(oldDerived) && oldDerived !== 'unknown';
    const becameUp = confirmedDerived === 'online' && oldDerived !== 'online' && isDowntimeState(oldDerived);
    const becameMaint =
      isMaintenanceState(confirmedDerived) &&
      oldDerived !== confirmedDerived &&
      oldDerived !== 'unknown';

    // Incidents only for real downtime
    if (becameDown) {
      state.incidents.unshift({
        id: `${mon.id}-${now}`,
        monitorId: mon.id,
        monitorName: mon.name,
        start: now,
        end: null,
        status: 'ongoing',
        cause,
        derived: confirmedDerived,
      });
    } else if (becameUp) {
      const open = state.incidents.find((i) => i.monitorId === mon.id && i.status === 'ongoing');
      if (open) {
        open.end = now;
        open.status = 'resolved';
        open.durationMs = open.end - open.start;
        open.duration = formatDurationDe(open.durationMs);
      }
    }

    if (becameDown || becameUp) {
      await sendAlert(webhookUrl, {
        monitor: mon,
        from: oldStatus,
        to: confirmed,
        derived: confirmedDerived,
        cause,
        extra: raw.extra,
        error: raw.error,
      });
      console.log(`[alert] ${mon.id}: ${oldDerived} → ${confirmedDerived}`);
    } else if (becameMaint) {
      // Info only, no alarm
      await sendAlert(webhookUrl, {
        monitor: mon,
        from: oldStatus,
        to: confirmed,
        derived: confirmedDerived,
        cause,
        extra: raw.extra,
        error: null,
        infoOnly: true,
      });
      console.log(`[info] ${mon.id}: ${oldDerived} → ${confirmedDerived}`);
    }

    prev.status = confirmed;
    prev.derived = confirmedDerived;
    prev.cause = cause;
    prev.pteroPower = pteroPower !== 'unknown' ? pteroPower : prev.pteroPower;
    prev.pteroSource = pteroSource;
    prev.failCount = confirmedDerived === 'online' ? 0 : prev.failCount;
    prev.lastCheck = now;
    prev.lastResult = raw.up;
    if (confirmed === 'up') prev.lastUp = now;
    if (confirmed === 'down') prev.lastDown = now;
    prev.extra = raw.extra || null;
    prev.error = confirmed === 'down' ? raw.error || null : null;
    prev.ms = raw.ms;
    state.monitors[mon.id] = prev;

    const file = path.join(DATA, `${mon.id}.json`);
    const data = loadJson(file, emptyMonitorData(mon));
    data.name = mon.name;
    data.icon = mon.icon;
    data.link = mon.link || null;
    data.kind = mon.kind;

    // Sample: maintenance → up:null (excluded from uptime); downtime → false; up → true
    let sampleUp = null;
    if (confirmed === 'up') sampleUp = true;
    else if (confirmed === 'down') sampleUp = false;
    else sampleUp = null; // restart/stopped/unknown

    const sample = {
      t: now,
      up: sampleUp,
      ms: typeof raw.ms === 'number' ? raw.ms : null,
      derived: confirmedDerived,
    };
    if (raw.extra) {
      if (raw.extra.players != null) sample.p = raw.extra.players;
      if (raw.extra.max != null) sample.m = raw.extra.max;
      if (raw.extra.map) sample.map = String(raw.extra.map).slice(0, 40);
    }
    data.samples.push(sample);
    data.samples = data.samples.filter((s) => s.t >= now - RAW_KEEP_MS);

    if (confirmed === 'up') upsertDay(data.days, today, 'up', raw.ms);
    else if (confirmed === 'down') upsertDay(data.days, today, 'down', raw.ms);
    else if (confirmed === 'restart' || confirmed === 'stopped') upsertDay(data.days, today, 'maint', raw.ms);
    pruneDays(data.days);

    const samples24 = data.samples.filter((s) => s.t >= now - 24 * 3600_000);
    const uptime24h = calcUptime(samples24, 'samples');
    const days7 = data.days.slice(-7);
    const days30 = data.days.slice(-30);
    const days90 = data.days.slice(-90);
    const uptime7d = calcUptime(days7, 'days');
    const uptime30d = calcUptime(days30, 'days');
    const uptime90d = calcUptime(days90, 'days');

    const dayBars = days90.map((d) => {
      const tot = (d.up || 0) + (d.down || 0); // maint excluded from %
      const pct = tot ? Math.round(((d.up || 0) / tot) * 10000) / 100 : null;
      return {
        d: d.d,
        pct,
        up: d.up || 0,
        down: d.down || 0,
        maint: d.maint || 0,
        avgMs: d.nMs ? Math.round(d.sumMs / d.nMs) : null,
      };
    });

    data.meta = {
      status: confirmed,
      derived: confirmedDerived,
      cause,
      pteroPower: pteroPower !== 'unknown' ? pteroPower : null,
      pteroSource,
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
      critical: mon.critical !== false,
      status: confirmed,
      derived: confirmedDerived,
      cause,
      pteroPower: pteroPower !== 'unknown' ? pteroPower : null,
      ms: raw.ms,
      extra: raw.extra || null,
      error: confirmed === 'down' ? raw.error || null : null,
      uptime: data.meta.uptime,
      avgMs24h: data.meta.avgMs24h,
    });

    console.log(
      `[check] ${mon.id}: ${confirmedDerived}` +
        (pteroPower !== 'unknown' ? ` ptero=${pteroPower}/${pteroSource}` : '') +
        (raw.ms != null ? ` ${raw.ms}ms` : '') +
        (raw.extra?.map ? ` map=${raw.extra.map}` : '') +
        (raw.extra?.players != null ? ` ${raw.extra.players}/${raw.extra.max}` : '') +
        (raw.unknown ? ' (widget)' : '') +
        (raw.error && confirmed === 'down' ? ` err=${raw.error}` : ''),
    );
  }

  // Critical monitors drive the global banner; secondary (e.g. Testserver) only as subline.
  const monById = Object.fromEntries(MONITORS.map((m) => [m.id, m]));
  const isCritical = (r) => monById[r.id]?.critical !== false;
  const primary = results.filter((r) => r.status !== 'unknown' && isCritical(r));
  const secondary = results.filter((r) => r.status !== 'unknown' && !isCritical(r));
  const primaryDown = primary.filter((r) => r.status === 'down');
  const primaryMaint = primary.filter((r) => r.status === 'restart' || r.status === 'stopped');
  const primaryUp = primary.filter((r) => r.status === 'up');
  const secondaryNotes = secondary
    .filter((r) => r.status === 'stopped' || r.status === 'restart' || r.status === 'down')
    .map((r) => {
      const meta = STATE_META[r.derived] || STATE_META.unknown;
      return `${meta.emoji} ${r.name.replace(/^Gameserver\s+/,'')}: ${meta.label}`;
    });

  let overall = 'ok';
  let overallLabel = 'Alle Systeme betriebsbereit';
  if (primaryDown.length === 0 && primaryMaint.length === 0 && primaryUp.length > 0) {
    overall = 'ok';
    overallLabel = 'Alle Systeme betriebsbereit';
  } else if (primaryDown.length === 0 && primaryMaint.length > 0) {
    overall = 'partial';
    overallLabel = primaryMaint.some((r) => r.derived === 'restart') ? 'Neustart / Wartung' : 'Wartung';
  } else if (primaryDown.length > 0 && primaryUp.length + primaryMaint.length > 0) {
    overall = 'partial';
    overallLabel = 'Teilweise Störung';
  } else if (primaryDown.length > 0) {
    overall = 'down';
    overallLabel = 'Störung';
  } else {
    overall = 'unknown';
    overallLabel = 'Status unbekannt';
  }
  const overallSubline = secondaryNotes.length ? secondaryNotes.join(' · ') : null;

  state.incidents = state.incidents.slice(0, 50);
  const incidentsPublic = state.incidents.slice(0, 10).map((i) => ({
    id: i.id,
    monitorId: i.monitorId,
    monitorName: i.monitorName,
    start: i.start,
    end: i.end,
    status: i.status,
    cause: i.cause || null,
    derived: i.derived || null,
    durationMs: i.end ? i.end - i.start : now - i.start,
    duration: i.duration || formatDurationDe(i.end ? i.end - i.start : now - i.start),
  }));

  const summary = {
    updatedAt: now,
    overall,
    overallLabel,
    overallSubline,
    monitors: results,
    incidents: incidentsPublic,
    note:
      'Messungen alle ~5 Min (Box-Cron interim; später GitHub Actions). Gestoppt/Neustart = Wartung (kein Downtime-%). Secondary-Monitore (Testserver) färben das Banner nicht orange. Crash-Heuristik: running→offline ohne stopping. Box-Cron deaktivieren, sobald der GH-Workflow live ist.',
  };
  saveJson(path.join(DATA, 'summary.json'), summary);
  saveJson(STATE_FILE, state);

  console.log(`[done] overall=${overall} at ${new Date(now).toISOString()}`);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
