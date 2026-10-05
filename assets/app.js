(() => {
  'use strict';

  const STATUS_LABEL = {
    up: 'Online',
    down: 'Offline',
    unknown: 'Unbekannt',
  };

  const UPTIME_KEYS = [
    { key: '24h', label: '24 Std' },
    { key: '7d', label: '7 Tage' },
    { key: '30d', label: '30 Tage' },
    { key: '90d', label: '90 Tage' },
  ];

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
    return `${Number(v).toFixed(v >= 99.95 ? 2 : 1).replace(/\.0$/, '')} %`;
  }

  function fmtMs(v) {
    if (v == null || !Number.isFinite(v)) return '–';
    return `${Math.round(v)} ms`;
  }

  function relativeChecked(ts) {
    if (!ts) return 'Zuletzt geprüft: unbekannt';
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (mins <= 0) return 'Zuletzt geprüft gerade eben';
    if (mins === 1) return 'Zuletzt geprüft vor 1 Min';
    return `Zuletzt geprüft vor ${mins} Min`;
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

  function barClass(pct) {
    if (pct == null) return 'bar--empty';
    if (pct >= 99) return 'bar--ok';
    if (pct >= 95) return 'bar--warn';
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
    const x = Math.min(window.innerWidth - 230, e.clientX + 12);
    const y = Math.max(8, e.clientY - 40);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  function sparklineSvg(samples) {
    const pts = (samples || [])
      .filter((s) => s.up && typeof s.ms === 'number')
      .map((s) => ({ t: s.t, ms: s.ms }));
    if (pts.length < 2) {
      return '<svg class="spark" viewBox="0 0 300 40" preserveAspectRatio="none"><text x="8" y="24" fill="#9a9ab0" font-size="10">Keine Antwortzeiten</text></svg>';
    }
    const w = 300;
    const h = 40;
    const pad = 3;
    const min = Math.min(...pts.map((p) => p.ms));
    const max = Math.max(...pts.map((p) => p.ms));
    const span = Math.max(1, max - min);
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t || t0 + 1;
    const tSpan = Math.max(1, t1 - t0);
    const coords = pts.map((p) => {
      const x = ((p.t - t0) / tSpan) * w;
      const y = h - pad - ((p.ms - min) / span) * (h - pad * 2);
      return [x, y];
    });
    const d = coords.map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(' ');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="sparkGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#F408FF"/><stop offset="100%" stop-color="#00D2FF"/>
      </linearGradient></defs>
      <path d="${d}"/></svg>`;
  }

  function buildDayBars(dayBars) {
    // Pad to 90 days visually
    const map = new Map((dayBars || []).map((d) => [d.d, d]));
    const days = [];
    const end = new Date();
    // Use Berlin date roughly via local — server stores Berlin keys
    for (let i = 89; i >= 0; i--) {
      const dt = new Date(end.getTime() - i * 86400000);
      const key = dt.toISOString().slice(0, 10); // close enough for bars; actual keys are Berlin
      days.push(map.get(key) || { d: key, pct: null, up: 0, down: 0 });
    }
    // Prefer actual dayBars order if length ~90
    const source = dayBars && dayBars.length ? dayBars : days;
    const wrap = document.createElement('div');
    wrap.className = 'bars';
    wrap.setAttribute('aria-label', '90-Tage-Uptime');
    // If fewer than 90, still show what we have left-aligned with empties
    const padded = [];
    const missing = Math.max(0, 90 - source.length);
    for (let i = 0; i < missing; i++) padded.push({ d: '', pct: null, up: 0, down: 0 });
    padded.push(...source.slice(-90));

    for (const d of padded) {
      const el = document.createElement('div');
      el.className = `bar ${barClass(d.pct)}`;
      if (d.d) {
        const downtimeMin = Math.round((d.down || 0) * 5);
        el.addEventListener('mouseenter', (e) => {
          showTip(
            e,
            `<strong>${d.d}</strong><br>Uptime: ${fmtPct(d.pct)}` +
              (d.down ? `<br>Downtime ≈ ${downtimeMin} Min` : '') +
              (d.avgMs != null ? `<br>Ø Antwort: ${fmtMs(d.avgMs)}` : ''),
          );
        });
        el.addEventListener('mousemove', moveTip);
        el.addEventListener('mouseleave', hideTip);
      }
      wrap.appendChild(el);
    }
    return wrap;
  }

  function renderMonitor(mon, detail) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = mon.id;

    const status = mon.status || 'unknown';
    const head = document.createElement('div');
    head.className = 'card__head';
    head.innerHTML = `
      <h3 class="card__title"><span class="icon">${mon.icon || ''}</span> ${escapeHtml(mon.name)}</h3>
      <span class="pill pill--${status}">${STATUS_LABEL[status] || status}</span>`;
    card.appendChild(head);

    const uptime = (detail && detail.meta && detail.meta.uptime) || mon.uptime || {};
    const tabs = document.createElement('div');
    tabs.className = 'uptime-tabs';
    for (const u of UPTIME_KEYS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'uptime-tab' + (u.key === '90d' ? ' is-active' : '');
      btn.innerHTML = `${u.label}<strong>${fmtPct(uptime[u.key])}</strong>`;
      btn.addEventListener('click', () => {
        tabs.querySelectorAll('.uptime-tab').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
      });
      tabs.appendChild(btn);
    }
    card.appendChild(tabs);

    card.appendChild(buildDayBars(detail?.dayBars));

    const samples = detail?.samples || [];
    const sparkWrap = document.createElement('div');
    sparkWrap.innerHTML = sparklineSvg(samples);
    card.appendChild(sparkWrap.firstChild);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const bits = [];
    bits.push(`Ø 24h: ${fmtMs(mon.avgMs24h ?? detail?.meta?.avgMs24h)}`);
    if (typeof mon.ms === 'number') bits.push(`Jetzt: ${fmtMs(mon.ms)}`);
    const extra = mon.extra || detail?.meta?.extra;
    if (extra) {
      if (extra.players != null) bits.push(`Spieler: ${extra.players}/${extra.max ?? '?'}`);
      if (extra.map) bits.push(`Map: ${escapeHtml(extra.map)}`);
      if (extra.status) bits.push(`Presence: ${escapeHtml(String(extra.status))}`);
      if (extra.status && mon.kind === 'http') bits.push(`HTTP ${extra.status}`);
    }
    if (mon.error && status === 'down') bits.push(`Fehler: ${escapeHtml(mon.error)}`);
    if (mon.link) bits.push(`<a href="${escapeAttr(mon.link)}" rel="noopener" target="_blank">Öffnen</a>`);
    if (mon.id === 'gameserver') {
      bits.push(
        `<a href="https://markgrafde.github.io/jgc-connect/" rel="noopener" target="_blank">Verbinden</a>`,
      );
    }
    meta.innerHTML = bits.join(' · ');
    card.appendChild(meta);
    return card;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  function renderOverall(summary) {
    const el = document.getElementById('overall');
    el.className = `overall overall--${summary.overall || 'unknown'}`;
    el.querySelector('.overall__label').textContent =
      summary.overallLabel || 'Status unbekannt';
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
      li.innerHTML =
        `<strong>${escapeHtml(i.monitorName)}</strong>` +
        (ongoing ? '<span class="badge-ongoing">laufend</span>' : '') +
        `<br><span style="color:var(--muted)">${fmtDateDe(i.start)}` +
        (i.end ? ` – ${fmtDateDe(i.end)}` : ' – jetzt') +
        ` · ${escapeHtml(i.duration || '')}</span>`;
      ul.appendChild(li);
    }
  }

  async function refresh() {
    try {
      const summary = await fetchJson('data/summary.json');
      renderOverall(summary);
      document.getElementById('last-checked').textContent = relativeChecked(summary.updatedAt);

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
      el.querySelector('.overall__label').textContent =
        'Statusdaten noch nicht verfügbar — erster Check läuft gleich.';
    }
  }

  refresh();
  setInterval(refresh, 60_000);
  setInterval(() => {
    // update "vor X Min" without refetch
    fetchJson('data/summary.json')
      .then((s) => {
        document.getElementById('last-checked').textContent = relativeChecked(s.updatedAt);
      })
      .catch(() => {});
  }, 30_000);
})();
