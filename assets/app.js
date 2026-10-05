(() => {
  'use strict';

  const STATUS_LABEL = {
    up: 'Online',
    down: 'Offline',
    unknown: 'Unbekannt',
    restart: 'Neustart',
    stopped: 'Gestoppt',
  };

  const DERIVED_LABEL = {
    online: 'Online',
    restart: 'Neustart',
    stopped: 'Gestoppt',
    disconnected: 'Verbindung getrennt',
    crashed: 'Abgestürzt',
    unknown: 'Unbekannt',
  };

  const UPTIME_KEYS = [
    { key: '24h', label: '24 Std' },
    { key: '7d', label: '7 Tage' },
    { key: '30d', label: '30 Tage' },
    { key: '90d', label: '90 Tage' },
  ];

  const PERIOD_LS_KEY = 'jgc-status.uptimePeriod';
  const PERIOD_DAYS = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };
  const PERIOD_LABEL_LEFT = {
    '24h': 'vor 24 Std',
    '7d': 'vor 7 Tagen',
    '30d': 'vor 30 Tagen',
    '90d': 'vor 90 Tagen',
  };

  function loadPeriodMap() {
    try {
      const raw = localStorage.getItem(PERIOD_LS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function getMonitorPeriod(monitorId) {
    const key = loadPeriodMap()[monitorId];
    return UPTIME_KEYS.some((u) => u.key === key) ? key : '90d';
  }

  function setMonitorPeriod(monitorId, key) {
    if (!UPTIME_KEYS.some((u) => u.key === key)) return;
    const map = loadPeriodMap();
    map[monitorId] = key;
    try {
      localStorage.setItem(PERIOD_LS_KEY, JSON.stringify(map));
    } catch {
      /* ignore quota / private mode */
    }
  }


  const BOT_STATUS_DE = {
    online: 'Bot online',
    idle: 'Bot abwesend',
    dnd: 'Bot bitte nicht stören',
    offline: 'Bot offline',
  };

  let sparkId = 0;

  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);

  function bust(url) {
    return `${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`;
  }

  async function fetchJson(path) {
    const res = await fetch(bust(path), { cache: 'no-store' });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  }

  function fmtPct(v) {
    if (v == null || Number.isNaN(v)) return '–';
    const n = Number(v);
    return `${n.toFixed(n >= 99.95 ? 2 : 1).replace(/\.0$/, '')} %`;
  }

  function fmtMs(v) {
    if (v == null || !Number.isFinite(v)) return '–';
    return `${Math.round(v)} ms`;
  }

  function ageMinutes(ts) {
    if (!ts) return null;
    return Math.max(0, Math.round((Date.now() - ts) / 60000));
  }

  function relativeChecked(ts) {
    if (!ts) return { text: 'Zuletzt geprüft: unbekannt', stale: true };
    const mins = ageMinutes(ts);
    let text;
    if (mins <= 0) text = 'Zuletzt geprüft gerade eben';
    else if (mins === 1) text = 'Zuletzt geprüft vor 1 Min';
    else text = `Zuletzt geprüft vor ${mins} Min`;
    if (mins > 20) text += ' · Messung verzögert';
    return { text, stale: mins > 20 };
  }

  function fmtDateDe(ts) {
    try {
      return new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(ts));
    } catch {
      return new Date(ts).toLocaleString('de-DE');
    }
  }

  function fmtDayDe(isoDay) {
    if (!isoDay) return '–';
    try {
      const [y, m, d] = isoDay.split('-').map(Number);
      return new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(new Date(Date.UTC(y, m - 1, d, 12)));
    } catch {
      return isoDay;
    }
  }

  /** YYYY-MM-DD in Europe/Berlin for a Date */
  function berlinDayKey(date) {
    try {
      return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Berlin',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(date);
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }

  function berlinHourLabel(date) {
    try {
      return new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
    } catch {
      return date.toISOString();
    }
  }

  function barClass(d) {
    if (!d) return 'bar--empty';
    const up = d.up || 0;
    const down = d.down || 0;
    const maint = d.maint || 0;
    if (up + down + maint === 0) return 'bar--empty';
    // No real downtime → never red. Pure/mostly maintenance → gray.
    if (down === 0 && maint > 0 && up === 0) return 'bar--maint';
    if (down === 0 && d.pct == null && maint > 0) return 'bar--maint';
    if (d.pct == null) return maint ? 'bar--maint' : 'bar--empty';
    if (d.pct >= 99) return 'bar--ok';
    if (d.pct >= 95) return 'bar--warn';
    return 'bar--bad';
  }

  function showTip(e, html) {
    tip.innerHTML = html;
    tip.classList.add('is-on');
    moveTip(e);
  }
  function hideTip() {
    tip.classList.remove('is-on');
  }
  function moveTip(e) {
    const pad = 12;
    const rect = tip.getBoundingClientRect();
    let x = e.clientX + pad;
    let y = e.clientY - rect.height - 10;
    if (x + 240 > window.innerWidth) x = e.clientX - 240 - pad;
    if (y < 8) y = e.clientY + pad;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }

  function fmtTimeShort(ts) {
    try {
      return new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(ts));
    } catch {
      return '';
    }
  }

  function smoothPath(coords) {
    if (coords.length < 2) return '';
    if (coords.length === 2) {
      return `M${coords[0][0].toFixed(2)},${coords[0][1].toFixed(2)} L${coords[1][0].toFixed(2)},${coords[1][1].toFixed(2)}`;
    }
    // Catmull-Rom → cubic Bezier with clamped control points (no overshoot on uneven gaps)
    let d = `M${coords[0][0].toFixed(2)},${coords[0][1].toFixed(2)}`;
    for (let i = 0; i < coords.length - 1; i++) {
      const p0 = coords[i === 0 ? 0 : i - 1];
      const p1 = coords[i];
      const p2 = coords[i + 1];
      const p3 = coords[i + 2] || p2;
      const dx = p2[0] - p1[0];
      if (dx < 0.5) {
        d += ` L${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
        continue;
      }
      let cp1x = p1[0] + (p2[0] - p0[0]) / 6;
      let cp1y = p1[1] + (p2[1] - p0[1]) / 6;
      let cp2x = p2[0] - (p3[0] - p1[0]) / 6;
      let cp2y = p2[1] - (p3[1] - p1[1]) / 6;
      cp1x = Math.max(p1[0], Math.min(p2[0], cp1x));
      cp2x = Math.max(p1[0], Math.min(p2[0], cp2x));
      const lo = Math.min(p1[1], p2[1]);
      const hi = Math.max(p1[1], p2[1]);
      const ypad = Math.max(4, (hi - lo) * 0.35);
      cp1y = Math.max(lo - ypad, Math.min(hi + ypad, cp1y));
      cp2y = Math.max(lo - ypad, Math.min(hi + ypad, cp2y));
      d += ` C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
    }
    return d;
  }

  function sparklineSvg(samples, opts) {
    opts = opts || {};
    const derived = opts.derived || null;
    const status = opts.status || null;

    const wrap = document.createElement('div');
    wrap.className = 'rt-chart';

    if (status === 'stopped' || derived === 'stopped') {
      wrap.className = 'spark-empty';
      wrap.textContent = 'Server gestoppt – keine Messwerte';
      return wrap;
    }
    if (status === 'restart' || derived === 'restart') {
      wrap.className = 'spark-empty';
      wrap.textContent = 'Neustart – keine Messwerte';
      return wrap;
    }

    const raw = (samples || [])
      .filter(
        (s) =>
          s.up === true &&
          typeof s.ms === 'number' &&
          Number.isFinite(s.ms) &&
          s.ms >= 0 &&
          s.ms < 60000,
      )
      .map((s) => ({ t: s.t, ms: s.ms }))
      .sort((a, b) => a.t - b.t);
    // Collapse near-duplicate timestamps (keep last) so x never stacks
    const pts = [];
    for (const p of raw) {
      if (pts.length && Math.abs(p.t - pts[pts.length - 1].t) < 5000) {
        pts[pts.length - 1] = p;
      } else {
        pts.push(p);
      }
    }

    if (pts.length < 3) {
      wrap.className = 'spark-empty';
      const cur = opts.currentMs != null ? ` · jetzt ${Math.round(opts.currentMs)} ms` : '';
      wrap.textContent = 'Noch zu wenig Messwerte' + cur;
      return wrap;
    }

    let yMin = Math.min(...pts.map((p) => p.ms));
    let yMax = Math.max(...pts.map((p) => p.ms));
    const rawSpan = Math.max(1, yMax - yMin);
    const pad = Math.max(20, rawSpan * 0.2);
    yMin = Math.max(0, yMin - pad);
    yMax = yMax + pad;
    const ySpan = Math.max(1, yMax - yMin);
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const tSpan = Math.max(1, t1 - t0);

    const id = `sg${++sparkId}`;

    wrap.innerHTML = `
      <div class="rt-chart__y rt-chart__y--max"></div>
      <div class="rt-chart__plot">
        <svg class="rt-chart__svg" xmlns="http://www.w3.org/2000/svg"></svg>
        <div class="rt-chart__hover" hidden></div>
      </div>
      <div class="rt-chart__y rt-chart__y--min"></div>
      <div class="rt-chart__x">
        <span>vor 24 Std</span>
        <span>jetzt</span>
      </div>`;

    const yMaxEl = wrap.querySelector('.rt-chart__y--max');
    const yMinEl = wrap.querySelector('.rt-chart__y--min');
    const plotEl = wrap.querySelector('.rt-chart__plot');
    const svg = wrap.querySelector('.rt-chart__svg');
    const hoverEl = wrap.querySelector('.rt-chart__hover');
    yMaxEl.textContent = `${Math.round(yMax)} ms`;
    yMinEl.textContent = `${Math.round(yMin)} ms`;

    let lastCoords = [];

    function draw() {
      const w = Math.max(120, Math.floor(plotEl.clientWidth || 300));
      const h = Math.max(100, Math.floor(plotEl.clientHeight || 120));
      const padT = 8;
      const padB = 8;
      const padL = 2;
      const padR = 2;
      const innerW = w - padL - padR;
      const innerH = h - padT - padB;

      svg.setAttribute('width', String(w));
      svg.setAttribute('height', String(h));
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      // 1 SVG unit = 1 CSS px — never stretch
      svg.setAttribute('preserveAspectRatio', 'xMinYMid meet');
      svg.style.width = w + 'px';
      svg.style.height = h + 'px';

      const coords = pts.map((p) => {
        const x = padL + ((p.t - t0) / tSpan) * innerW;
        const y = padT + (1 - (p.ms - yMin) / ySpan) * innerH;
        return [x, y, p];
      });
      lastCoords = coords;

      const lineD = smoothPath(coords.map((c) => [c[0], c[1]]));
      let area = `M${coords[0][0].toFixed(2)},${(padT + innerH).toFixed(2)} `;
      for (const c of coords) area += `L${c[0].toFixed(2)},${c[1].toFixed(2)} `;
      area += `L${coords[coords.length - 1][0].toFixed(2)},${(padT + innerH).toFixed(2)} Z`;

      const gridYs = [0.25, 0.5, 0.75]
        .map((f) => padT + f * innerH)
        .map(
          (y) =>
            `<line x1="${padL}" y1="${y.toFixed(2)}" x2="${(w - padR).toFixed(2)}" y2="${y.toFixed(2)}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`,
        )
        .join('');

      const last = coords[coords.length - 1];

      svg.innerHTML = `
        <defs>
          <linearGradient id="${id}-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#F408FF"/>
            <stop offset="100%" stop-color="#00D2FF"/>
          </linearGradient>
          <linearGradient id="${id}-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#00D2FF" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="#F408FF" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        ${gridYs}
        <path d="${area}" fill="url(#${id}-fill)" stroke="none"/>
        <path d="${lineD}" fill="none" stroke="url(#${id}-stroke)" stroke-width="2.4"
              stroke-linejoin="round" stroke-linecap="round"
              vector-effect="non-scaling-stroke"/>
        <circle cx="${last[0].toFixed(2)}" cy="${last[1].toFixed(2)}" r="4.2"
                fill="#00D2FF" stroke="#0b0b12" stroke-width="2"/>
      `;
    }

    function nearest(mx) {
      if (!lastCoords.length) return null;
      let best = lastCoords[0];
      let bestDist = Infinity;
      for (const c of lastCoords) {
        const d = Math.abs(c[0] - mx);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      return best;
    }

    plotEl.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const scaleX = (svg.viewBox.baseVal.width || rect.width) / rect.width;
      const mx = (e.clientX - rect.left) * scaleX;
      const hit = nearest(mx);
      if (!hit) return;
      const p = hit[2];
      hoverEl.hidden = false;
      hoverEl.textContent = `${fmtTimeShort(p.t)} · ${Math.round(p.ms)} ms`;
      const left = Math.min(plotEl.clientWidth - 110, Math.max(0, hit[0] - 40));
      hoverEl.style.left = `${left}px`;
      hoverEl.style.top = `${Math.max(0, hit[1] - 28)}px`;
    });
    plotEl.addEventListener('mouseleave', () => {
      hoverEl.hidden = true;
    });

    const ro = new ResizeObserver(() => draw());
    ro.observe(plotEl);
    // initial draw after layout
    requestAnimationFrame(() => draw());

    return wrap;
  }

  function emptyDayPad(key) {
    return { d: key, pct: null, up: 0, down: 0, maint: 0, avgMs: null };
  }

  function padDailyBars(dayBars, count) {
    const map = new Map((dayBars || []).map((d) => [d.d, d]));
    const padded = [];
    const now = new Date();
    for (let i = count - 1; i >= 0; i--) {
      const dt = new Date(now.getTime() - i * 86400000);
      const key = berlinDayKey(dt);
      padded.push(map.get(key) || emptyDayPad(key));
    }
    return padded;
  }

  function buildHourlyBars(samples) {
    const now = Date.now();
    const buckets = [];
    for (let i = 23; i >= 0; i--) {
      const end = now - i * 3600000;
      const start = end - 3600000;
      let up = 0;
      let down = 0;
      let maint = 0;
      let sumMs = 0;
      let nMs = 0;
      for (const s of samples || []) {
        if (s.t < start || s.t >= end) continue;
        const derived = s.derived || null;
        if (derived === 'stopped' || derived === 'restart') {
          maint += 1;
          continue;
        }
        if (s.up === true) {
          up += 1;
          if (typeof s.ms === 'number' && Number.isFinite(s.ms)) {
            sumMs += s.ms;
            nMs += 1;
          }
        } else if (s.up === false) {
          down += 1;
        }
      }
      const relevant = up + down;
      buckets.push({
        d: null,
        kind: 'hour',
        tStart: start,
        tEnd: end,
        up,
        down,
        maint,
        pct: relevant > 0 ? (up / relevant) * 100 : null,
        avgMs: nMs > 0 ? sumMs / nMs : null,
      });
    }
    return buckets;
  }

  function barTooltipHtml(d) {
    const downtimeMin = Math.round((d.down || 0) * 5);
    const maintMin = Math.round((d.maint || 0) * 5);
    const statusLabel =
      d.pct == null && !(d.maint > 0)
        ? 'Keine Daten'
        : (d.maint || 0) > 0 && (d.down || 0) === 0 && (d.up || 0) === 0
          ? 'Wartung'
          : d.pct == null
            ? 'Wartung / keine Uptime-Daten'
            : d.pct >= 99
              ? 'Betriebsbereit'
              : d.pct >= 95
                ? 'Störung'
                : 'Ausfall';
    const title =
      d.kind === 'hour'
        ? `${berlinHourLabel(new Date(d.tStart))} – ${fmtTimeShort(d.tEnd)}`
        : fmtDayDe(d.d);
    return (
      `<strong>${title}</strong>` +
      `Uptime: ${fmtPct(d.pct)}<br>` +
      `Status: ${statusLabel}` +
      (d.down
        ? `<br>Ausfall ≈ ${downtimeMin} Min (${d.down} Checks)`
        : d.pct != null
          ? '<br>Kein Ausfall'
          : '') +
      (d.maint ? `<br>Wartung ≈ ${maintMin} Min (${d.maint} Checks)` : '') +
      (d.avgMs != null ? `<br>Ø Antwort: ${fmtMs(d.avgMs)}` : '')
    );
  }

  function buildDayBars(dayBars, opts) {
    opts = opts || {};
    const period = opts.period || '90d';
    const samples = opts.samples || [];

    let padded;
    let aria;
    let leftLabel;
    let dense = false;

    if (period === '24h') {
      const hasSamples = (samples || []).some((s) => typeof s.t === 'number');
      if (hasSamples) {
        padded = buildHourlyBars(samples);
        aria = 'Uptime der letzten 24 Stunden (stündlich)';
        leftLabel = PERIOD_LABEL_LEFT['24h'];
        dense = true;
      } else {
        padded = padDailyBars(dayBars, 1);
        aria = 'Uptime des letzten Tages';
        leftLabel = 'Heute';
      }
    } else {
      const count = PERIOD_DAYS[period] || 90;
      padded = padDailyBars(dayBars, count);
      aria = `Uptime der letzten ${count} Tage`;
      leftLabel = PERIOD_LABEL_LEFT[period] || PERIOD_LABEL_LEFT['90d'];
    }

    const wrap = document.createElement('div');
    wrap.className = 'bars-wrap';
    wrap.dataset.period = period;

    const bars = document.createElement('div');
    bars.className = 'bars' + (dense ? ' bars--dense' : '');
    bars.setAttribute('aria-label', aria);

    for (const d of padded) {
      const el = document.createElement('div');
      el.className = `bar ${barClass(d)}`;
      el.addEventListener('mouseenter', (e) => showTip(e, barTooltipHtml(d)));
      el.addEventListener('mousemove', moveTip);
      el.addEventListener('mouseleave', hideTip);
      bars.appendChild(el);
    }
    wrap.appendChild(bars);

    const labels = document.createElement('div');
    labels.className = 'bars-labels';
    const rightLabel = period === '24h' && dense ? 'jetzt' : 'Heute';
    labels.innerHTML = `<span>${leftLabel}</span><span>${rightLabel}</span>`;
    wrap.appendChild(labels);

    const legend = document.createElement('div');
    legend.className = 'bars-legend';
    legend.innerHTML =
      '<span><i class="leg-ok"></i>Betriebsbereit</span>' +
      '<span><i class="leg-warn"></i>Störung</span>' +
      '<span><i class="leg-bad"></i>Ausfall</span>' +
      '<span><i class="leg-maint"></i>Wartung</span>' +
      '<span><i class="leg-empty"></i>Keine Daten</span>';
    wrap.appendChild(legend);

    return wrap;
  }

  function buildMeta(mon, detail, status, derived) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    const extra = mon.extra || detail?.meta?.extra || {};
    const chips = [];

    if (mon.kind === 'a2s' || mon.id === 'gameserver' || mon.id === 'testserver') {
      if (extra.players != null) {
        chips.push(`Spieler <strong>${extra.players}/${extra.max ?? '?'}</strong>`);
      }
      if (extra.map) chips.push(`Map <strong>${escapeHtml(String(extra.map))}</strong>`);
      if (extra.name) {
        const nm = String(extra.name).trim();
        const generic =
          !nm ||
          /^new\s+gmod\s+server$/i.test(nm) ||
          /^garry'?s\s*mod$/i.test(nm) ||
          /^gmod$/i.test(nm) ||
          /^server$/i.test(nm);
        if (!generic) {
          chips.push({
            html: `Name: <strong>${escapeHtml(nm)}</strong>`,
            title: nm,
            cls: 'chip chip--name',
          });
        }
      }
    } else if (mon.kind === 'http') {
      if (extra.status != null) chips.push(`HTTP <strong>${escapeHtml(String(extra.status))}</strong>`);
    } else if (mon.kind === 'discord-widget') {
      const raw = extra.status != null ? String(extra.status) : status;
      const label = BOT_STATUS_DE[raw] || (status === 'up' ? 'Bot online' : status === 'down' ? 'Bot offline' : 'Bot unbekannt');
      chips.push(`<strong>${escapeHtml(label)}</strong>`);
    }

    if (mon.error && status === 'down') {
      chips.push(`Fehler: ${escapeHtml(mon.error)}`);
    }

    for (const item of chips) {
      const span = document.createElement('span');
      if (typeof item === 'string') {
        span.className = 'chip';
        span.innerHTML = item;
      } else {
        span.className = item.cls || 'chip';
        span.innerHTML = item.html;
        if (item.title) span.title = item.title;
      }
      meta.appendChild(span);
    }

    // Links as pill buttons
    const links = [];
    if (mon.kind === 'a2s' || mon.id === 'gameserver' || mon.id === 'testserver') {
      const href =
        mon.link ||
        (mon.id === 'testserver'
          ? 'https://markgrafde.github.io/jgc-connect/?ip=159.195.60.189:27016'
          : 'https://markgrafde.github.io/jgc-connect/?ip=159.195.60.189:27015');
      const playable = status === 'up' || derived === 'online';
      links.push({
        href,
        label: 'Verbinden',
        primary: true,
        disabled: !playable,
      });
    } else if (mon.link) {
      links.push({ href: mon.link, label: 'Öffnen', primary: mon.kind === 'http' });
    }

    for (const l of links) {
      if (l.disabled) {
        const span = document.createElement('span');
        span.className = 'btn-pill btn-pill--disabled';
        span.textContent = l.label;
        span.title = 'Server nicht erreichbar';
        meta.appendChild(span);
      } else {
        const a = document.createElement('a');
        a.href = l.href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'btn-pill' + (l.primary ? '' : ' btn-pill--ghost');
        a.textContent = l.label;
        meta.appendChild(a);
      }
    }

    return meta;
  }

  function renderMonitor(mon, detail) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = mon.id;

    const status = mon.status || 'unknown';
    const derived = mon.derived || null;
    const pillClass =
      status === 'restart' || status === 'stopped'
        ? status
        : status === 'down' && derived === 'crashed'
          ? 'down'
          : status === 'down'
            ? 'down'
            : status === 'up'
              ? 'up'
              : status;
    const pillText =
      (derived && DERIVED_LABEL[derived]) || STATUS_LABEL[status] || status;
    const head = document.createElement('div');
    head.className = 'card__head';
    head.innerHTML = `
      <h3 class="card__title"><span class="icon">${mon.icon || ''}</span> ${escapeHtml(mon.name)}</h3>
      <span class="pill pill--${pillClass}">${escapeHtml(pillText)}</span>`;
    card.appendChild(head);

    const uptime = (detail && detail.meta && detail.meta.uptime) || mon.uptime || {};
    const selectedPeriod = getMonitorPeriod(mon.id);
    const tabs = document.createElement('div');
    tabs.className = 'uptime-tabs';
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Uptime-Zeitraum');

    const barsHost = document.createElement('div');
    barsHost.className = 'bars-host';

    function paintBars(period) {
      const next = buildDayBars(detail?.dayBars, {
        period,
        samples: detail?.samples || [],
      });
      barsHost.replaceChildren(next);
    }

    function selectPeriod(period) {
      setMonitorPeriod(mon.id, period);
      for (const btn of tabs.querySelectorAll('.uptime-tab')) {
        const on = btn.dataset.period === period;
        btn.classList.toggle('is-focus', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      paintBars(period);
      // Samples only cover ~24h — filter chart for 24h; leave it for longer windows
      if (period === '24h') {
        const chartMount = card.querySelector('.response__chart');
        if (chartMount) {
          const allSamples = detail?.samples || [];
          const chartSamples = allSamples.filter((s) => s.t >= Date.now() - 24 * 3600000);
          chartMount.replaceChildren(
            sparklineSvg(chartSamples, {
              status: mon.status || 'unknown',
              derived: mon.derived || null,
              currentMs: typeof mon.ms === 'number' ? mon.ms : null,
            }),
          );
        }
      }
    }

    for (const u of UPTIME_KEYS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'uptime-tab' + (u.key === selectedPeriod ? ' is-focus' : '');
      btn.dataset.period = u.key;
      btn.setAttribute('role', 'button');
      btn.setAttribute('aria-pressed', u.key === selectedPeriod ? 'true' : 'false');
      btn.setAttribute('aria-label', `Uptime ${u.label}: ${fmtPct(uptime[u.key])}`);
      btn.innerHTML = `${u.label}<strong>${fmtPct(uptime[u.key])}</strong>`;
      btn.addEventListener('click', () => selectPeriod(u.key));
      tabs.appendChild(btn);
    }
    card.appendChild(tabs);

    paintBars(selectedPeriod);
    card.appendChild(barsHost);

    const response = document.createElement('div');
    response.className = 'response';
    const big = document.createElement('div');
    big.className = 'response__big';
    const nowMs = typeof mon.ms === 'number' ? mon.ms : null;
    const avg = mon.avgMs24h ?? detail?.meta?.avgMs24h;
    big.innerHTML =
      `<span class="response__label">Antwortzeit</span>` +
      `<span class="response__value">${fmtMs(nowMs != null ? nowMs : avg)}</span>`;
    if (avg != null && nowMs != null) {
      const sub = document.createElement('div');
      sub.style.cssText = 'color:var(--muted);font-size:0.72rem;margin-top:0.2rem';
      sub.textContent = `Ø 24h ${fmtMs(avg)}`;
      big.appendChild(sub);
    }
    response.appendChild(big);

    const chart = document.createElement('div');
    chart.className = 'response__chart';
    chart.appendChild(
      sparklineSvg(detail?.samples || [], {
        status,
        derived,
        currentMs: typeof mon.ms === 'number' ? mon.ms : null,
      }),
    );
    response.appendChild(chart);
    card.appendChild(response);

    card.appendChild(buildMeta(mon, detail, status, derived));
    return card;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderOverall(summary) {
    const el = document.getElementById('overall');
    el.className = `overall overall--${summary.overall || 'unknown'}`;
    let label = el.querySelector('.overall__label');
    if (!label) {
      label = document.createElement('span');
      label.className = 'overall__label';
      el.appendChild(label);
    }
    label.textContent = summary.overallLabel || 'Status unbekannt';
    let sub = el.querySelector('.overall__sub');
    if (summary.overallSubline) {
      if (!sub) {
        sub = document.createElement('span');
        sub.className = 'overall__sub';
        el.appendChild(sub);
      }
      sub.textContent = summary.overallSubline;
      sub.hidden = false;
    } else if (sub) {
      sub.hidden = true;
      sub.textContent = '';
    }
  }

  function renderLastChecked(ts) {
    const el = document.getElementById('last-checked');
    const info = relativeChecked(ts);
    el.textContent = info.text;
    el.classList.toggle('is-stale', !!info.stale);
  }

  function renderIncidents(list) {
    const ul = document.getElementById('incidents-list');
    ul.innerHTML = '';
    if (!list || !list.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'Keine Störungen in der Historie.';
      ul.appendChild(li);
      return;
    }
    for (const i of list) {
      const li = document.createElement('li');
      const ongoing = i.status === 'ongoing';
      const cause = i.cause ? ` · ${escapeHtml(i.cause)}` : '';
      li.innerHTML =
        `<strong>${escapeHtml(i.monitorName)}</strong>` +
        (ongoing ? '<span class="badge-ongoing">laufend</span>' : '') +
        `<br><span style="color:var(--muted)">${fmtDateDe(i.start)}` +
        (i.end ? ` – ${fmtDateDe(i.end)}` : ' – jetzt') +
        ` · ${escapeHtml(i.duration || '')}${cause}</span>`;
      ul.appendChild(li);
    }
  }

  async function refresh() {
    try {
      const summary = await fetchJson('data/summary.json');
      renderOverall(summary);
      renderLastChecked(summary.updatedAt);

      const monitorsEl = document.getElementById('monitors');
      monitorsEl.innerHTML = '';

      const details = await Promise.all(
        (summary.monitors || []).map(async (m) => {
          try {
            return await fetchJson(`data/${m.id}.json`);
          } catch {
            return null;
          }
        }),
      );

      (summary.monitors || []).forEach((m, idx) => {
        monitorsEl.appendChild(renderMonitor(m, details[idx]));
      });

      renderIncidents(summary.incidents);
    } catch (err) {
      console.warn('refresh failed', err);
      const el = document.getElementById('overall');
      el.className = 'overall overall--unknown';
      const label = el.querySelector('.overall__label');
      if (label) {
        label.textContent = 'Statusdaten noch nicht verfügbar — erster Check läuft gleich.';
      }
    }
  }

  refresh();
  setInterval(refresh, 60_000);
  setInterval(() => {
    fetchJson('data/summary.json')
      .then((s) => renderLastChecked(s.updatedAt))
      .catch(() => {});
  }, 30_000);
})();
