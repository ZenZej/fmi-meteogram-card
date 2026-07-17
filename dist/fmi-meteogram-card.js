/**
 * FMI Meteogram Card — a Lovelace custom card that draws the weather-page
 * meteogram (temperature + rain + wind + weather symbols) from the
 * `fmi_harmonie` integration's forecast sensors, merged with a measured
 * outdoor-temperature history for the recent past.
 *
 * No build step: this file IS the source. Loaded as an ES module, so asset
 * URLs (the symbol PNGs) resolve relative to this file via import.meta.url —
 * which works whether HACS serves it from /hacsfiles/ or you drop it in
 * /config/www/ (/local/).
 *
 * The rendering is ported from weather-page/assets/js/chart.js; see that file
 * and the POC for the design intent. Data plumbing reads Home Assistant entity
 * attributes and history.
 */

// Symbol assets live in ./symbols/ next to this module.
const ASSET_BASE = new URL('./symbols/', import.meta.url).href;

// --- Temperature colour scale (from the user's ApexCharts color_threshold,
// softened for light and brightened for dark). [°C, hex] ascending.
const CHART = {
  light: {
    grid: '#d5dce4', divider: '#b4c0cf', tick: '#1f2a37', rain: '#a9c3e3', fillOpacity: 0.16,
    stops: [[-20,'#7b1fa2'],[-15,'#4030a3'],[-10,'#1156b0'],[-5,'#0f8fd6'],[0,'#12b3a0'],
            [5,'#6fbf3b'],[10,'#d8c62a'],[15,'#f2a53c'],[20,'#f2712c'],[25,'#e24b57'],[30,'#d0338a']],
  },
  dark: {
    grid: '#33465a', divider: '#48607a', tick: '#e9eff5', rain: '#3f5f86', fillOpacity: 0.22,
    stops: [[-20,'#b061d6'],[-15,'#6f63e0'],[-10,'#3f86e6'],[-5,'#35b0ef'],[0,'#2fd0bb'],
            [5,'#8fd85a'],[10,'#ecdd4a'],[15,'#f6b85f'],[20,'#f78a4e'],[25,'#ef6a75'],[30,'#e85aa6']],
  },
};

// weather-page wind-speed buckets -> arrow icon (includes/helpers.php).
function windIconForSpeed(ms) {
  if (ms < 3) return 'wind_low.png';
  if (ms < 7) return 'wind_medium.png';
  if (ms < 15) return 'wind_high.png';
  return 'wind_storm.png';
}

// TODO(verify-live): day/night per hour. weather-page derives this from the
// location's sunrise/sunset. Placeholder: local hour heuristic. Replace with a
// solar calc (or an FMI-provided value) once verified against the real site.
function sunStatus(date) {
  const h = date.getHours();
  return (h >= 5 && h < 22) ? 'day' : 'night';
}

const NS = 'http://www.w3.org/2000/svg';
const XLINK = 'http://www.w3.org/1999/xlink';
function svgEl(tag, attrs, text) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) {
    e.setAttribute(k, attrs[k]);
    // <image href> is SVG2; older WebViews (e.g. the HA companion app on some
    // tablets) only honour the SVG1.1 xlink:href. Set both so icons render there.
    if (k === 'href') e.setAttributeNS(XLINK, 'xlink:href', attrs[k]);
  }
  if (text != null) e.textContent = text;
  return e;
}
function smoothPath(pts) {
  if (pts.length < 3) return 'M ' + pts.map(p => p[0] + ' ' + p[1]).join(' L ');
  let d = 'M ' + pts[0][0] + ' ' + pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i-1] || pts[i], p1 = pts[i], p2 = pts[i+1], p3 = pts[i+2] || pts[i+1];
    d += ' C ' + (p1[0]+(p2[0]-p0[0])/6) + ' ' + (p1[1]+(p2[1]-p0[1])/6) + ' ' +
         (p2[0]-(p3[0]-p1[0])/6) + ' ' + (p2[1]-(p3[1]-p1[1])/6) + ' ' + p2[0] + ' ' + p2[1];
  }
  return d;
}
const dayKey = d => d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();

function hex2rgb(h){ return [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)]; }
function rgb2hex(a){ return '#' + a.map(x => Math.round(x).toString(16).padStart(2,'0')).join(''); }
function tempColor(v, stops) {
  if (v <= stops[0][0]) return stops[0][1];
  if (v >= stops[stops.length-1][0]) return stops[stops.length-1][1];
  for (let i = 0; i < stops.length-1; i++) {
    if (v >= stops[i][0] && v <= stops[i+1][0]) {
      const f = (v-stops[i][0])/(stops[i+1][0]-stops[i][0]), a = hex2rgb(stops[i][1]), b = hex2rgb(stops[i+1][1]);
      return rgb2hex(a.map((x,k) => x + (b[k]-x)*f));
    }
  }
  return stops[stops.length-1][1];
}

class FmiMeteogramCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._hass = null;
    this._config = null;
    this._measured = null;       // [{time, temp}] from outdoor-temp history
    this._measuredFor = null;    // entity id the cache is for
    this._ro = null;
  }

  // --- Lovelace config ----------------------------------------------------
  setConfig(config) {
    // Resolve the seven fmi_harmonie sensors from a prefix, or take explicit
    // entity ids. Prefix default matches an integration instance named
    // "FMI HARMONIE" (-> sensor.fmi_harmonie_*).
    const prefix = config.prefix || 'sensor.fmi_harmonie';
    const e = config.entities || {};
    this._config = {
      title: config.title || 'Forecast',
      hours_past: config.hours_past ?? 12,
      hours_future: config.hours_future ?? 24,
      outdoor_temperature: config.outdoor_temperature || null,
      entities: {
        temperature: e.temperature || `${prefix}_temperature`,
        feels_like: e.feels_like || `${prefix}_feels_like`,
        precipitation: e.precipitation || `${prefix}_precipitation`,
        wind_speed: e.wind_speed || `${prefix}_wind_speed`,
        wind_direction: e.wind_direction || `${prefix}_wind_direction`,
        weather_symbol: e.weather_symbol || `${prefix}_weather_symbol`,
      },
    };
    if (this._hass) this._update();
  }

  set hass(hass) {
    this._hass = hass;
    this._maybeFetchMeasured();
    this._update();
  }

  getCardSize() { return 4; }

  connectedCallback() {
    this._ro = new ResizeObserver(() => this._render());
    this._ro.observe(this);
  }
  disconnectedCallback() { if (this._ro) this._ro.disconnect(); }

  // --- Data ---------------------------------------------------------------
  _forecast(entityId) {
    return this._hass?.states?.[entityId]?.attributes?.forecast || [];
  }

  // Merge the per-parameter forecast arrays into one point-per-hour series,
  // trimmed to now .. now + hours_future, then prepend measured past.
  _buildSeries() {
    const ent = this._config.entities;
    const idx = arr => Object.fromEntries(arr.map(p => [p.datetime, p.value]));
    const feels = idx(this._forecast(ent.feels_like));
    const rain = idx(this._forecast(ent.precipitation));
    const wspd = idx(this._forecast(ent.wind_speed));
    const wdir = idx(this._forecast(ent.wind_direction));
    const symb = idx(this._forecast(ent.weather_symbol));

    const now = Date.now() / 1000;
    const horizon = now + this._config.hours_future * 3600;
    const future = this._forecast(ent.temperature)
      .map(p => {
        const t = Date.parse(p.datetime) / 1000;
        return {
          time: t, temp: p.value, measured: false,
          feels_like: feels[p.datetime] ?? null,
          rain: rain[p.datetime] ?? 0,
          wind_speed: wspd[p.datetime] ?? null,
          wind_dir: wdir[p.datetime] ?? null,
          symbol: symb[p.datetime] ?? null,
        };
      })
      .filter(p => p.time >= now - 3600 && p.time <= horizon);

    const pastRaw = (this._measured || [])
      .filter(p => p.time >= now - this._config.hours_past * 3600 && p.time < future[0]?.time);
    const past = this._hourlyThin(pastRaw)
      .map(p => ({ time: p.time, temp: p.temp, measured: true,
                   feels_like: null, rain: 0, wind_speed: null, wind_dir: null, symbol: null }));

    return past.concat(future).sort((a, b) => a.time - b.time);
  }

  // HA records the outdoor sensor on every change (often sub-minute), so the raw
  // measured history holds far more points than the hourly forecast. Since the
  // x-axis spaces points by index, those dense points would dwarf the forecast
  // and shove it off the right edge. Thin to ~one sample per clock hour (the
  // one nearest the hour mark), matching the forecast cadence.
  _hourlyThin(rows) {
    const byHour = new Map();
    for (const p of rows) {
      const hour = Math.round(p.time / 3600);
      const cur = byHour.get(hour);
      if (!cur || Math.abs(p.time - hour * 3600) < Math.abs(cur.time - hour * 3600)) byHour.set(hour, p);
    }
    return [...byHour.values()].sort((a, b) => a.time - b.time);
  }

  // Pull the outdoor sensor's recent history once per entity change. HA gives a
  // card only the CURRENT state via hass.states, so the measured past needs a
  // history fetch (websocket). Re-renders when it resolves.
  async _maybeFetchMeasured() {
    const id = this._config?.outdoor_temperature;
    if (!id || !this._hass || this._measuredFor === id) return;
    this._measuredFor = id;
    try {
      const start = new Date(Date.now() - (this._config.hours_past + 1) * 3600 * 1000).toISOString();
      const res = await this._hass.callWS({
        type: 'history/history_during_period',
        start_time: start,
        entity_ids: [id],
        minimal_response: true,
        no_attributes: true,
      });
      const rows = (res && res[id]) || [];
      this._measured = rows
        .map(r => ({ time: (r.lu ?? r.last_updated ?? Date.parse(r.last_changed) / 1000),
                     temp: parseFloat(r.s ?? r.state) }))
        .filter(p => Number.isFinite(p.temp) && Number.isFinite(p.time));
      this._render();
    } catch (err) {
      // Non-fatal: render forecast-only.
      // eslint-disable-next-line no-console
      console.warn('fmi-meteogram-card: measured history fetch failed', err);
    }
  }

  _theme() {
    if (this._hass?.themes?.darkMode != null) return this._hass.themes.darkMode ? 'dark' : 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // --- Render -------------------------------------------------------------
  _update() {
    if (!this._config) return;
    if (!this.shadowRoot.firstChild) this._scaffold();
    this._render();
  }

  _scaffold() {
    const root = this.shadowRoot;
    root.innerHTML = `
      <style>
        ha-card { padding: 8px 12px; }
        #chart svg { display:block; }
        .empty { padding:20px 8px; color: var(--secondary-text-color, #8fa0b1); font-size:13px; }
      </style>
      <ha-card>
        <div id="chart"></div>
      </ha-card>`;
  }

  _render() {
    if (!this._config || !this._hass) return;
    const root = this.shadowRoot;
    if (!root.firstChild) this._scaffold();

    const pts = this._buildSeries();
    const chart = root.getElementById('chart');
    if (!pts.length) {
      chart.innerHTML = '<div class="empty">No forecast data. Check the entity prefix / that fmi_harmonie is set up.</div>';
      return;
    }
    this._draw(chart, pts);
  }

  _draw(el, pts) {
    const th = CHART[this._theme()];
    el.innerHTML = '';
    const hasSymbols = pts.some(p => p.symbol != null);
    const hasWind = pts.some(p => p.wind_speed != null);

    const n = pts.length, dates = pts.map(p => new Date(p.time * 1000));
    const W = Math.max(Math.round(this.clientWidth) || 470, 320);
    // Layout: reserve the icon row (top) and wind row (bottom) only if present.
    const iconY = 18, tTop = hasSymbols ? 52 : 22, tBot = 150;
    const hoursY = 174, windY = 208;
    const H = hasWind ? 224 : 190;
    const padL = 34, padR = 36;

    const temps = pts.map(p => p.temp);
    const feelsVals = pts.filter(p => p.feels_like != null).map(p => p.feels_like);
    const rains = pts.map(p => p.rain);
    const tMin = Math.floor(Math.min(...temps, ...feelsVals)) - 1;
    const tMax = Math.ceil(Math.max(...temps)) + 1;
    // Rain axis spans the full plot height (ticks + bars top-to-bottom), same
    // vertical extent as the °C axis.
    const rMax = Math.max(...rains, 1), rainH = tBot - tTop;
    const xs = i => padL + i * (W - padL - padR) / (n - 1);
    const yT = t => tTop + (1 - (t - tMin) / (tMax - tMin)) * (tBot - tTop);
    const linePts = pts.map((p, i) => [xs(i), yT(p.temp)]);
    const feelsPts = pts.map((p, i) => p.feels_like != null ? [xs(i), yT(p.feels_like)] : null).filter(Boolean);

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img',
      'aria-label': 'temperature, rain and wind, past and forecast' });

    // temperature gradient (colour-by-value)
    const defs = svgEl('defs', {});
    const grad = svgEl('linearGradient', { id: 'tempgrad', gradientUnits: 'userSpaceOnUse', x1: 0, y1: yT(tMax), x2: 0, y2: yT(tMin) });
    const NST = 20;
    for (let i = 0; i <= NST; i++) { const f = i / NST, temp = tMax - (tMax - tMin) * f;
      grad.appendChild(svgEl('stop', { offset: (f * 100).toFixed(1) + '%', 'stop-color': tempColor(temp, th.stops) })); }
    defs.appendChild(grad); svg.appendChild(defs);

    // gridlines + °C ticks
    const step = (tMax - tMin) <= 12 ? 2 : 5;
    for (let t = Math.ceil(tMin / step) * step; t < tMax; t += step) { const gy = yT(t);
      svg.appendChild(svgEl('line', { x1: padL, y1: gy, x2: W - padR, y2: gy, stroke: th.grid, 'stroke-width': 1 }));
      svg.appendChild(svgEl('text', { x: padL - 6, y: gy + 4, 'text-anchor': 'end', 'font-size': 13, 'font-weight': 600, fill: th.tick }, t + '°'));
    }
    // rain (mm) axis
    const rTicks = rMax <= 1 ? [0, 0.5, 1] : (rMax <= 2 ? [0, 1, 2] : [0, Math.round(rMax / 2), Math.ceil(rMax)]);
    rTicks.forEach(rv => { const ry = tBot - (rv / rMax) * rainH;
      svg.appendChild(svgEl('text', { x: W - padR + 6, y: ry + 4, 'text-anchor': 'start', 'font-size': 12, 'font-weight': 600, fill: th.tick }, rv)); });
    // rain bars
    const bw = (W - padL - padR) / n * 0.5;
    for (let j = 0; j < n; j++) if (pts[j].rain > 0) { const hh = pts[j].rain / rMax * rainH;
      svg.appendChild(svgEl('rect', { x: xs(j) - bw / 2, y: tBot - hh, width: bw, height: hh, rx: 2, fill: th.rain })); }
    // area + feels + temp line, colour-by-temperature
    svg.appendChild(svgEl('path', { d: smoothPath(linePts) + ` L ${xs(n-1)} ${tBot} L ${xs(0)} ${tBot} Z`, fill: 'url(#tempgrad)', 'fill-opacity': th.fillOpacity }));
    svg.appendChild(svgEl('path', { d: smoothPath(feelsPts), fill: 'none', stroke: 'url(#tempgrad)', 'stroke-width': 2, 'stroke-dasharray': '2 4', 'stroke-linecap': 'round', opacity: 0.85 }));
    svg.appendChild(svgEl('path', { d: smoothPath(linePts), fill: 'none', stroke: 'url(#tempgrad)', 'stroke-width': 3.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    // midnight dividers + hour ticks
    for (let i = 1; i < n; i++) if (dayKey(dates[i]) !== dayKey(dates[i-1])) { const dx = (xs(i) + xs(i-1)) / 2;
      svg.appendChild(svgEl('line', { x1: dx, y1: tTop, x2: dx, y2: tBot, stroke: th.divider, 'stroke-width': 1, 'stroke-dasharray': '3 3' })); }
    for (let k = 0; k < n; k += 3) { const h = dates[k].getHours(); const lbl = (h < 10 ? '0' : '') + h;
      svg.appendChild(svgEl('text', { x: xs(k), y: hoursY, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 600, fill: th.tick }, lbl)); }

    // weather-symbol row across the top (every 3rd hour), day/night variant
    if (hasSymbols) for (let s = 0; s < n; s += 3) { if (pts[s].symbol == null) continue;
      svg.appendChild(svgEl('image', {
        href: `${ASSET_BASE}${sunStatus(dates[s])}/${pts[s].symbol}.png`,
        x: xs(s) - 16, y: iconY - 16, width: 32, height: 32 }));
    }
    // wind-arrow row along the bottom, rotated to direction
    // TODO(verify-live): confirm rotation sense — FMI WindDirection is the
    // bearing the wind blows FROM; the arrow may need +180 to point downwind.
    if (hasWind) for (let w = 0; w < n; w += 2) { if (pts[w].wind_speed == null) continue;
      const rot = pts[w].wind_dir ?? 0;
      svg.appendChild(svgEl('image', {
        href: `${ASSET_BASE}${windIconForSpeed(pts[w].wind_speed)}`,
        x: xs(w) - 8.5, y: windY - 8.5, width: 17, height: 17,
        transform: `rotate(${rot} ${xs(w)} ${windY})` }));
    }

    // "now" marker at the past/forecast boundary
    const ni = pts.findIndex(p => !p.measured);
    if (ni > 0) { const nx = xs(ni);
      svg.appendChild(svgEl('line', { x1: nx, y1: tTop, x2: nx, y2: tBot, stroke: th.divider, 'stroke-width': 1.5 }));
      svg.appendChild(svgEl('text', { x: nx + 4, y: tTop + 11, 'text-anchor': 'start', 'font-size': 11, 'font-weight': 700, fill: th.tick }, 'now'));
    }

    el.appendChild(svg);
  }

  // Stub config for the card picker.
  static getStubConfig() {
    return { type: 'custom:fmi-meteogram-card', prefix: 'sensor.fmi_harmonie', title: 'Forecast' };
  }
}

customElements.define('fmi-meteogram-card', FmiMeteogramCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'fmi-meteogram-card',
  name: 'FMI Meteogram Card',
  description: 'Meteogram (temperature, rain, wind, symbols) from the fmi_harmonie integration.',
});

// eslint-disable-next-line no-console
console.info('%c FMI-METEOGRAM-CARD %c scaffolding ', 'background:#182430;color:#8fd85a', 'background:#3f86e6;color:#fff');

export { FmiMeteogramCard };
