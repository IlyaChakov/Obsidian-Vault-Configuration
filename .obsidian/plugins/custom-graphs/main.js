/*
  Custom Graphs — Obsidian plugin (no build step, plain JS)
  Provides a fenced code block processor to render charts from note properties.

  Usage (in your note):
  ```custom-graph
  type: bar
  style: dv         # default style (like your Dataview example)
  # file: path/to/other.md  # optional, default is current note
  # fields: auto             # or see README for custom fields
  # title: true
  # barH: 18
  # gap: 8
  # labelW: 120
  # valueW: 56
  # posFill: auto            # or hex
  # negFill: #d62728
  ```
*/

const { Plugin } = require('obsidian');

class CustomGraphsPlugin extends Plugin {
  onload() {
    this.registerMarkdownCodeBlockProcessor('custom-graph', async (source, el, ctx) => {
      let cfg = parseConfig(source);
      // defaults
      cfg = Object.assign(
        {
          type: 'bar',
          style: 'dv',
          file: undefined,
          date: undefined,          // e.g., 2025-09-24 | today | yesterday
          dateFormat: 'YYYY-MM-DD', // used to resolve file name
          dateFolder: undefined,    // optional folder for daily notes
          fields: 'default', // 'default' | 'auto' | string | array
          title: true,
          barH: 18,
          gap: 8,
          margin: { top: 20, right: 16, bottom: 20, left: 12 },
          labelW: 120,
          valueW: 56,
          posFill: 'auto',
          negFill: '#d62728',
          colors: undefined,   // map | array | palette name
          palette: undefined,  // palette name (fallback if no colors provided)
          precision: undefined
        },
        cfg || {}
      );

      // Resolve source path: by date -> by file -> current
      const resolvedPath = resolveSourcePath(this.app, ctx, cfg);
      const path = resolvedPath || ctx.sourcePath;
      const cache = this.app.metadataCache.getCache(path);
      const fm = (cache && cache.frontmatter) || {};

      // Resolve fields
      const fields = normalizeFields(cfg.fields);
      const rows = (fields || [])
        .map(({ label, key, color }) => ({ label, key, color, v: toNumber(fm[key]) }))
        .filter(r => Number.isFinite(r.v));

      // If fields=auto, discover all numeric properties from frontmatter
      if (cfg.fields === 'auto') {
        const auto = [];
        for (const k in fm) {
          if (!Object.prototype.hasOwnProperty.call(fm, k)) continue;
          if (k === 'position' || k === 'tags' || k === 'aliases') continue;
          const v = toNumber(fm[k]);
          if (Number.isFinite(v)) auto.push({ label: k, key: k, v });
        }
        rows.length = 0;
        rows.push(...auto);
      }

      const wrap = el.createDiv({ cls: 'cg-wrap' });
      const render = () => {
        wrap.empty();
        if (!rows.length) {
          wrap.createEl('p', { text: 'Нет числовых свойств для отображения.' });
          return;
        }
        if (cfg.type === 'bar') {
          renderBarChart({ el: wrap, rows, cfg, titleName: fileNameFromPath(path) });
        } else {
          wrap.createEl('p', { text: `Неизвестный тип графика: ${cfg.type}` });
        }
      };

      render();

      // Re-render on resize
      const ro = new ResizeObserver(() => render());
      ro.observe(wrap);
      this.register(() => ro.disconnect());
    });
  }
}

// Default field mapping (labels in Russian, keys in frontmatter)
const DEFAULT_FIELDS = [
  ['Всего', 'counts'],
  ['Создание', 'create'],
  ['Изменение', 'modify'],
  ['Удаление', 'delete'],
  ['Переименование', 'rename'],
  ['+ слов', 'words_added'],
  ['- слов', 'words_removed'],
  ['Δ слов', 'words_net']
];

function normalizeFields(fields) {
  if (!fields || fields === 'default') {
    return DEFAULT_FIELDS.map(([label, key]) => ({ label, key }));
  }
  if (fields === 'auto') return []; // handled separately

  // JSON array input
  if (Array.isArray(fields)) {
    // Support [ [label,key], ... ] or [ {label,key,color?}, ... ] or [label,key,color]
    return fields
      .map((it) => {
        if (Array.isArray(it) && it.length >= 2) {
          const obj = { label: String(it[0]), key: String(it[1]) };
          if (it.length >= 3) obj.color = String(it[2]);
          return obj;
        }
        if (it && typeof it === 'object' && it.label && it.key) {
          const obj = { label: String(it.label), key: String(it.key) };
          if (it.color) obj.color = String(it.color);
          return obj;
        }
        return null;
      })
      .filter(Boolean);
  }

  // Compact string: "Label1:key1, Label2:key2, ..."
  if (typeof fields === 'string') {
    return fields
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(pair => {
        const idx = pair.lastIndexOf(':');
        if (idx === -1) return null;
        const label = pair.slice(0, idx).trim();
        const key = pair.slice(idx + 1).trim();
        if (!label || !key) return null;
        return { label, key };
      })
      .filter(Boolean);
  }

  return DEFAULT_FIELDS.map(([label, key]) => ({ label, key }));
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/\s+/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function renderBarChart({ el, rows, cfg, titleName }) {
  const BAR_H = toInt(cfg.barH, 18);
  const GAP = toInt(cfg.gap, 8);
  const MARGIN = normalizeMargin(cfg.margin, { top: 20, right: 16, bottom: 20, left: 12 });
  const LABEL_W = toInt(cfg.labelW, 120);
  const VALUE_W = toInt(cfg.valueW, 56);
  const POS_FILL = cfg.posFill === 'auto'
    ? (getCss('--interactive-accent') || '#4c9aff')
    : String(cfg.posFill || '#4c9aff');
  const NEG_FILL = String(cfg.negFill || '#d62728');
  const SHOW_TITLE = !!cfg.title;
  const precision = typeof cfg.precision === 'number' ? cfg.precision : null;
  const palette = resolvePalette(cfg);

  const width = el.clientWidth || 640;
  const innerW = width - MARGIN.left - MARGIN.right - LABEL_W - VALUE_W;
  const height = MARGIN.top + MARGIN.bottom + rows.length * BAR_H + (rows.length - 1) * GAP;

  // Scale supports negative values
  const minVal = Math.min(0, ...rows.map(r => r.v));
  const maxVal = Math.max(1, ...rows.map(r => r.v));
  const span = maxVal - minVal;
  const scale = span > 0 ? (innerW / span) : 0;
  const baseX = MARGIN.left + LABEL_W + (-minVal) * scale;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.width = '100%';
  svg.style.height = 'auto';
  svg.classList.add('cg-svg');
  el.appendChild(svg);

  // Zero axis
  const axis0 = document.createElementNS(NS, 'line');
  axis0.setAttribute('x1', baseX);
  axis0.setAttribute('x2', baseX);
  axis0.setAttribute('y1', MARGIN.top - 6);
  axis0.setAttribute('y2', height - MARGIN.bottom + 6);
  axis0.setAttribute('stroke', getCss('--background-modifier-border') || '#ccc');
  axis0.setAttribute('opacity', '0.7');
  svg.appendChild(axis0);

  const textMuted = getCss('--text-muted') || '#666';
  const textNormal = getCss('--text-normal') || '#ddd';

  rows.forEach((r, i) => {
    const yTop = MARGIN.top + i * (BAR_H + GAP);

    // Label left
    const tl = document.createElementNS(NS, 'text');
    tl.setAttribute('x', MARGIN.left + LABEL_W - 6);
    tl.setAttribute('y', yTop + BAR_H / 2 + 2); // approx vertical align
    tl.setAttribute('text-anchor', 'end');
    tl.setAttribute('font-size', '11');
    tl.setAttribute('fill', textMuted);
    tl.textContent = r.label;
    svg.appendChild(tl);

    // Bar
    const val = r.v;
    const w = Math.max(0, Math.abs(val) * scale);
    const x = val >= 0 ? baseX : (baseX - w);
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', yTop);
    rect.setAttribute('width', w);
    rect.setAttribute('height', BAR_H);
    rect.setAttribute('rx', '3');
    const custom = resolveBarColor(r, i, cfg, palette);
    rect.setAttribute('fill', custom || (val >= 0 ? POS_FILL : NEG_FILL));
    const ttl = document.createElementNS(NS, 'title');
    ttl.textContent = `${r.label}: ${fmt(val, precision)}`;
    rect.appendChild(ttl);
    svg.appendChild(rect);

    // Value right column
    const tv = document.createElementNS(NS, 'text');
    tv.setAttribute('x', width - MARGIN.right);
    tv.setAttribute('y', yTop + BAR_H / 2 + 2);
    tv.setAttribute('text-anchor', 'end');
    tv.setAttribute('font-size', '11');
    tv.setAttribute('fill', textNormal);
    tv.textContent = String(fmt(val, precision));
    svg.appendChild(tv);
  });

  if (SHOW_TITLE) {
    const title = document.createElementNS(NS, 'text');
    title.setAttribute('x', MARGIN.left);
    title.setAttribute('y', 14);
    title.setAttribute('fill', textNormal);
    title.setAttribute('font-weight', '600');
    title.setAttribute('font-size', '12');
    title.textContent = titleName || '';
    svg.appendChild(title);
  }
}

function toInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : d;
}

function normalizeMargin(m, d) {
  if (!m || typeof m !== 'object') return d;
  const out = { ...d };
  for (const k of ['top', 'right', 'bottom', 'left']) {
    if (k in m) out[k] = toInt(m[k], d[k]);
  }
  return out;
}

function getCss(varName) {
  try {
    return getComputedStyle(document.body).getPropertyValue(varName).trim();
  } catch (_) {
    return '';
  }
}

function fmt(val, precision) {
  if (precision == null) return String(val);
  const f = Math.pow(10, precision);
  return String(Math.round(val * f) / f);
}

function parseConfig(src) {
  const text = String(src || '').trim();
  if (!text) return {};

  // Try JSON first
  if (text.startsWith('{') || text.startsWith('[')) {
    try { return JSON.parse(text); } catch (_) {}
  }

  // Very small YAML-ish parser for top-level key: value pairs and arrays
  // - fields can be:
  //   - a compact string: "Label1:key1, Label2:key2"
  //   - a JSON array
  const lines = text.split(/\r?\n/);
  const obj = {};
  let k = null;
  let arr = null;
  let mapKey = null;
  let mapIndent = 0;
  for (let raw of lines) {
    const line = raw.replace(/\t/g, '  ');

    // nested map item (e.g., colors: \n  key: "#fff")
    const mMapItem = line.match(/^(\s+)([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (mMapItem && mapKey) {
      const indent = mMapItem[1].length;
      if (indent > mapIndent) {
        const subKey = mMapItem[2];
        let v = mMapItem[3].trim();
        if (/^(true|false)$/i.test(v)) { obj[mapKey][subKey] = /^true$/i.test(v); continue; }
        const n = Number(v);
        if (Number.isFinite(n) && String(n) === v) { obj[mapKey][subKey] = n; continue; }
        if (v.startsWith('{') || v.startsWith('[')) {
          try { obj[mapKey][subKey] = JSON.parse(v); continue; } catch (_) {}
        }
        obj[mapKey][subKey] = stripQuotes(v);
        continue;
      } else {
        mapKey = null; // dedent
      }
    }
    // array item under current key
    const mItem = line.match(/^\s*-\s*(.*)$/);
    if (mItem && k) {
      arr = arr || [];
      const item = mItem[1].trim();
      // accept JSON-like array ["Label", key]
      if (item.startsWith('[')) {
        try {
          const parsed = JSON.parse(item.replace(/([^\[\]\s,:{}"'])(?=\s*[,:\]])/g, '"$1"'));
          arr.push(parsed);
        } catch (_) {
          arr.push(item);
        }
      } else {
        arr.push(item);
      }
      obj[k] = arr;
      continue;
    }

    const m = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (m) {
      k = m[1];
      let v = m[2].trim();
      if (!v) { // expect nested collection next lines
        if (k === 'colors') {
          obj[k] = {};
          mapKey = k;
          mapIndent = (raw.match(/^(\s*)/)?.[1] || '').length;
        } else {
          arr = [];
          obj[k] = arr;
        }
        continue;
      }

      // Try number/bool
      if (/^(true|false)$/i.test(v)) { obj[k] = /^true$/i.test(v); continue; }
      const n = Number(v);
      if (Number.isFinite(n) && String(n) === v) { obj[k] = n; continue; }

      // Try JSON for complex values
      if (v.startsWith('{') || v.startsWith('[')) {
        try { obj[k] = JSON.parse(v); continue; } catch (_) {}
      }
      obj[k] = stripQuotes(v);
    }
  }
  // Post-process fields array of arrays into objects
  if (Array.isArray(obj.fields)) {
    obj.fields = obj.fields.map(x => {
      if (Array.isArray(x) && x.length >= 2) return [String(x[0]), String(x[1])];
      return x;
    });
  }
  return obj;
}

function fileNameFromPath(p) {
  if (!p) return '';
  const i = p.lastIndexOf('/');
  const name = i >= 0 ? p.slice(i + 1) : p;
  return name.replace(/\.md$/i, '');
}

module.exports = CustomGraphsPlugin;

// ===== Helpers for colors/palettes =====
function stripQuotes(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) {
    return v.slice(1, -1);
  }
  return v;
}

function resolvePalette(cfg) {
  // If colors is a string, treat it as a palette name
  if (typeof cfg.colors === 'string') {
    const pal = getPalette(cfg.colors);
    if (pal) return pal;
  }
  if (typeof cfg.palette === 'string') {
    const pal = getPalette(cfg.palette);
    if (pal) return pal;
  }
  return null;
}

function getPalette(name) {
  const n = String(name || '').toLowerCase();
  const palettes = {
    category10: ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'],
    pastel: ['#a6cee3', '#b2df8a', '#fb9a99', '#fdbf6f', '#cab2d6', '#ffff99', '#1f78b4', '#33a02c'],
    obsidian: [
      getCss('--interactive-accent') || '#4c9aff',
      getCss('--text-accent') || '#a78bfa',
      getCss('--color-green') || '#10b981',
      getCss('--color-orange') || '#fb923c',
      getCss('--color-red') || '#ef4444',
      getCss('--color-cyan') || '#06b6d4'
    ]
  };
  return palettes[n] || null;
}

function isColor(x) {
  return typeof x === 'string' && x.length > 0;
}

function resolveBarColor(row, idx, cfg, palette) {
  const cs = cfg.colors;
  if (Array.isArray(cs) && cs.length) {
    const c = cs[idx % cs.length];
    if (isColor(c)) return c;
  } else if (cs && typeof cs === 'object' && !Array.isArray(cs)) {
    if (isColor(cs[row.key])) return cs[row.key];
    if (isColor(cs[row.label])) return cs[row.label];
  } else if (typeof cs === 'string') {
    const pal = palette || getPalette(cs);
    if (pal && pal.length) return pal[idx % pal.length];
  }
  if (isColor(row.color)) return row.color;
  if (palette && palette.length) return palette[idx % palette.length];
  return null;
}

// ===== Date → file resolution =====
function resolveSourcePath(app, ctx, cfg) {
  // If date given, try to resolve a daily note by date
  if (cfg.date) {
    const byDate = findDailyByDate(app, cfg.date, cfg.dateFormat || 'YYYY-MM-DD', cfg.dateFolder);
    if (byDate && byDate.path) return byDate.path;
  }
  // Else fall back to explicit file param
  if (cfg.file) return cfg.file;
  // Else current note
  return ctx.sourcePath;
}

function findDailyByDate(app, dateInput, dateFormat, dateFolder) {
  const m = getMoment();
  let formatted = null;
  if (m) {
    let md = null;
    const s = String(dateInput).trim().toLowerCase();
    if (s === 'today') md = m();
    else if (s === 'yesterday') md = m().subtract(1, 'day');
    else md = m(dateInput);
    if (md && md.isValid()) formatted = md.format(dateFormat || 'YYYY-MM-DD');
  } else {
    // Fallback: Date
    const d = parseDateFallback(dateInput);
    if (d) formatted = formatDateFallback(d, dateFormat || 'YYYY-MM-DD');
  }
  if (!formatted) return null;

  // If a folder is specified, try exact path first
  if (dateFolder) {
    const folder = trimSlashes(String(dateFolder));
    const path = folder ? folder + '/' + formatted + '.md' : formatted + '.md';
    const af = app.vault.getAbstractFileByPath(path);
    if (af && af.path) return af;
  }

  // Otherwise, search by file name across markdown files
  const target = formatted + '.md';
  const files = app.vault.getMarkdownFiles ? app.vault.getMarkdownFiles() : app.vault.getFiles();
  for (const f of files) {
    if (f.name === target) return f;
  }
  return null;
}

function getMoment() {
  try { return window?.moment || null; } catch (_) { return null; }
}

function parseDateFallback(input) {
  try {
    const d = new Date(input);
    if (!isNaN(d.getTime())) return d;
  } catch (_) {}
  return null;
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function formatDateFallback(d, fmt) {
  // minimal YYYY-MM-DD support
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  if (!fmt || fmt === 'YYYY-MM-DD') return `${yyyy}-${mm}-${dd}`;
  // very small formatter: supports YYYY, MM, DD tokens
  return String(fmt)
    .replace(/YYYY/g, String(yyyy))
    .replace(/MM/g, String(mm))
    .replace(/DD/g, String(dd));
}

function trimSlashes(p) {
  return String(p || '').replace(/^\/+/, '').replace(/\/+$/, '');
}
