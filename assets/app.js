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

  function barClass(d) {
    if (!d || (d.pct == null && !(d.maint > 0))) return 'bar--empty';
    // Day dominated by maintenance
    const checks = (d.up || 0) + (d.down || 0) + (d.maint || 0);
    if (checks && (d.maint || 0) >= (d.up || 0) + (d.down || 0) && (d.down || 0) === 0) {
      return 'bar--maint';
    }
    if (d.pct == null) return d.maint ? 'bar--maint' : 'bar--empty';
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

  function sparklineSvg(samples) {
    const pts = (samples || [])
      .filter((s) => s.up && typeof s.ms === 'number' && Number.isFinite(s.ms))
      .map((s) => ({ t: s.t, ms: s.ms }));

    if (pts.length < 2) {
      const el = document.createElement('div');
      el.className = 'spark-empty';
      el.textContent = 'Noch zu wenig Messwerte';
      return el;
    }

    const id = `sg${++sparkId}`;
    const w = 320;
    const h = 48;
    const padY = 4;
    const min = Math.min(...pts.map((p) => p.ms));
    const max = Math.max(...pts.map((p) => p.ms));
    const span = Math.max(1, max - min);
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const tSpan = Math.max(1, t1 - t0);

    const coords = pts.map((p) => {
      const x = ((p.t - t0) / tSpan) * w;
      const y = h - padY - ((p.ms - min) / span) * (h - padY * 2);
      return [x, y];
    });

    const line = coords
      .map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(2)},${c[1].toFixed(2)}`)
      .join(' ');
    const area =
      `M0,${h} ` +
      coords.map((c) => `L${c[0].toFixed(2)},${c[1].toFixed(2)}`).join(' ') +
      ` L${w},${h} Z`;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
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
      <path d="${area}" fill="url(#${id}-fill)" stroke="none"/>
      <path d="${line}" fill="none" stroke="url(#${id}-stroke)" stroke-width="2.2"
            stroke-linejoin="round" stroke-linecap="round"/>`;
    return svg;
  }

  function buildDayBars(dayBars) {
    const map = new Map((dayBars || []).map((d) => [d.d, d]));
    const padded = [];
    const now = new Date();
    for (let i = 89; i >= 0; i--) {
      const dt = new Date(now.getTime() - i * 86400000);
      const key = berlinDayKey(dt);
      const hit = map.get(key);
      padded.push(
        hit || {
          d: key,
          pct: null,
          up: 0,
          down: 0,
          avgMs: null,
        },
      );
    }

    const wrap = document.createElement('div');
    wrap.className = 'bars-wrap';

    const bars = document.createElement('div');
    bars.className = 'bars';
    bars.setAttribute('aria-label', '90-Tage-Uptime');

    for (const d of padded) {
      const el = document.createElement('div');
      el.className = `bar ${barClass(d)}`;
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
      el.addEventListener('mouseenter', (e) => {
        showTip(
          e,
          `<strong>${fmtDayDe(d.d)}</strong>` +
            `Uptime: ${fmtPct(d.pct)}<br>` +
            `Status: ${statusLabel}` +
            (d.down
              ? `<br>Ausfall ≈ ${downtimeMin} Min (${d.down} Checks)`
              : d.pct != null
                ? '<br>Kein Ausfall'
                : '') +
            (d.maint
              ? `<br>Wartung ≈ ${maintMin} Min (${d.maint} Checks)`
              : '') +
            (d.avgMs != null ? `<br>Ø Antwort: ${fmtMs(d.avgMs)}` : ''),
        );
      });
      el.addEventListener('mousemove', moveTip);
      el.addEventListener('mouseleave', hideTip);
      bars.appendChild(el);
    }
    wrap.appendChild(bars);

    const labels = document.createElement('div');
    labels.className = 'bars-labels';
    labels.innerHTML = '<span>vor 90 Tagen</span><span>Heute</span>';
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

  function buildMeta(mon, detail, status) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    const extra = mon.extra || detail?.meta?.extra || {};
    const chips = [];

    if (mon.kind === 'a2s' || mon.id === 'gameserver') {
      if (extra.players != null) {
        chips.push(`Spieler <strong>${extra.players}/${extra.max ?? '?'}</strong>`);
      }
      if (extra.map) chips.push(`Map <strong>${escapeHtml(String(extra.map))}</strong>`);
      if (extra.name) chips.push(`<strong>${escapeHtml(String(extra.name).slice(0, 48))}</strong>`);
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

    for (const html of chips) {
      const span = document.createElement('span');
      span.className = 'chip';
      span.innerHTML = html;
      meta.appendChild(span);
    }

    // Links as pill buttons
    const links = [];
    if (mon.id === 'gameserver') {
      links.push({
        href: 'https://markgrafde.github.io/jgc-connect/',
        label: 'Verbinden',
        primary: true,
      });
    }
    if (mon.link && mon.id !== 'gameserver') {
      links.push({ href: mon.link, label: 'Öffnen', primary: mon.kind === 'http' });
    } else if (mon.link && mon.id === 'gameserver') {
      // already have Verbinden; skip duplicate Öffnen to connect page
    } else if (mon.link) {
      links.push({ href: mon.link, label: 'Öffnen', primary: false });
    }

    for (const l of links) {
      const a = document.createElement('a');
      a.href = l.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'btn-pill' + (l.primary ? '' : ' btn-pill--ghost');
      a.textContent = l.label;
      meta.appendChild(a);
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
    const tabs = document.createElement('div');
    tabs.className = 'uptime-tabs';
    for (const u of UPTIME_KEYS) {
      const btn = document.createElement('div');
      btn.className = 'uptime-tab' + (u.key === '90d' ? ' is-focus' : '');
      btn.innerHTML = `${u.label}<strong>${fmtPct(uptime[u.key])}</strong>`;
      tabs.appendChild(btn);
    }
    card.appendChild(tabs);

    card.appendChild(buildDayBars(detail?.dayBars));

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
    chart.appendChild(sparklineSvg(detail?.samples || []));
    response.appendChild(chart);
    card.appendChild(response);

    card.appendChild(buildMeta(mon, detail, status));
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
