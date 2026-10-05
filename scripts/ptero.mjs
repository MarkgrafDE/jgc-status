/**
 * Pterodactyl power-state (Client API, fallback Application+Wings).
 * Wings tokens are never written to disk / data/.
 */

export function normalizeBase(url) {
  try {
    return new URL(url).origin;
  } catch {
    return String(url || '').replace(/\/+$/, '');
  }
}

export function normalizePower(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'running' || s === 'starting' || s === 'stopping' || s === 'offline') return s;
  return 'unknown';
}

/**
 * @returns {'online'|'restart'|'stopped'|'disconnected'|'crashed'|'unknown'}
 */
export function deriveServiceState({ power, probeOk, prevPower, prevDerived }) {
  // Neustart nur wenn Panel start/stop meldet UND Probe noch fehlschlägt.
  if (power === 'starting' || power === 'stopping') {
    return probeOk ? 'online' : 'restart';
  }
  // Panel "offline" = gestoppt/Wartung — NIEMALS crashed (auch nicht nach running).
  // Crash ohne Stop-Übergang ist am Panel nicht zuverlässig von "Stop" unterscheidbar;
  // echte Störungen: power=running + Probe fail → disconnected.
  if (power === 'offline') {
    return 'stopped';
  }
  if (power === 'running') return probeOk ? 'online' : 'disconnected';
  // power unknown
  if (probeOk) return 'online';
  // Sticky maintenance if we already knew stopped/restart and panel is unreachable
  if (prevDerived === 'stopped' || prevDerived === 'restart') return prevDerived;
  return 'disconnected';
}

export function isDowntimeState(state) {
  return state === 'disconnected' || state === 'crashed';
}

export function isMaintenanceState(state) {
  return state === 'stopped' || state === 'restart';
}

export const STATE_META = {
  online: { label: 'Online', emoji: '🟢', badge: 'up' },
  restart: { label: 'Neustart', emoji: '🔄', badge: 'restart' },
  stopped: { label: 'Gestoppt', emoji: '⏹️', badge: 'stopped' },
  disconnected: { label: 'Verbindung getrennt', emoji: '🔌', badge: 'down' },
  crashed: { label: 'Abgestürzt', emoji: '💥', badge: 'down' },
  unknown: { label: 'Unbekannt', emoji: '❓', badge: 'unknown' },
};

async function fetchJson(url, headers, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

let wingsCache = null;

async function wingsState(panelBase, apiKey, serverId) {
  const list = await fetchJson(`${panelBase}/api/application/servers?per_page=100`, {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/vnd.pterodactyl.v1+json',
  });
  const items = Array.isArray(list?.data) ? list.data : [];
  const hit = items.find((it) => {
    const a = it?.attributes || {};
    return (
      String(a.identifier) === serverId ||
      String(a.uuid) === serverId ||
      String(a.id) === serverId ||
      String(a.uuid || '').startsWith(serverId)
    );
  });
  if (!hit) throw new Error(`Ptero: Server ${serverId} nicht gefunden`);
  const attrs = hit.attributes;
  const uuid = attrs.uuid;
  const nodeId = Number(attrs.node);
  const now = Date.now();
  if (!wingsCache || wingsCache.nodeId !== nodeId || now - wingsCache.fetchedAt > 600_000) {
    const node = await fetchJson(`${panelBase}/api/application/nodes/${nodeId}`, {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/vnd.pterodactyl.v1+json',
    });
    const na = node.attributes || {};
    const cfg = await fetchJson(`${panelBase}/api/application/nodes/${nodeId}/configuration`, {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/vnd.pterodactyl.v1+json',
    });
    const token = cfg.token || cfg.attributes?.token;
    if (!token) throw new Error('Ptero: Wings-Token fehlt');
    wingsCache = {
      nodeId,
      base: `${na.scheme || 'http'}://${na.fqdn}:${na.daemon_listen || 8080}`,
      token,
      fetchedAt: now,
    };
  }
  const data = await fetchJson(`${wingsCache.base}/api/servers/${uuid}`, {
    Authorization: `Bearer ${wingsCache.token}`,
    Accept: 'application/json',
  });
  return normalizePower(data.state || data.utilization?.state);
}

export async function fetchPteroPowerState(panelUrl, apiKey, serverId) {
  if (!panelUrl || !apiKey || !serverId) {
    return { ok: false, power: 'unknown', source: 'none', error: 'nicht konfiguriert' };
  }
  const base = normalizeBase(panelUrl);
  try {
    const data = await fetchJson(`${base}/api/client/servers/${serverId}/resources`, {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/vnd.pterodactyl.v1+json',
    });
    return { ok: true, power: normalizePower(data?.attributes?.current_state), source: 'client' };
  } catch (err) {
    const status = err?.status;
    if (status === 401 || status === 403 || status === 404 || String(apiKey).startsWith('papp_')) {
      try {
        const power = await wingsState(base, apiKey, serverId);
        return { ok: true, power, source: 'wings' };
      } catch (err2) {
        return {
          ok: false,
          power: 'unknown',
          source: 'none',
          error: (err2?.message || String(err2)).slice(0, 160),
        };
      }
    }
    return {
      ok: false,
      power: 'unknown',
      source: 'none',
      error: (err?.message || String(err)).slice(0, 160),
    };
  }
}
