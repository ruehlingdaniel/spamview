(() => {
'use strict';

const PAGE_SIZE = 50;
let state = {
  q: '',
  source: '',
  category: '',
  days: '7',
  page: 0,
  total: 0,
  categories: {},
  ai: { enabled: false, model: '' },
  insightsDays: '7',
};

function mdToHtml(md) {
  // Lightweight markdown: headings, bullets, bold, code, paragraphs.
  const lines = md.split('\n');
  let html = '';
  let inList = false;
  for (let raw of lines) {
    const line = raw.trimEnd();
    if (/^##\s+/.test(line)) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h2>${escape(line.replace(/^##\s+/, ''))}</h2>`;
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${formatInline(line.replace(/^[-*]\s+/, ''))}</li>`;
    } else if (line.trim() === '') {
      if (inList) { html += '</ul>'; inList = false; }
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p>${formatInline(line)}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}
function formatInline(s) {
  return escape(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const fmtTs = (unix) => {
  const d = new Date(unix * 1000);
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const HH = String(d.getHours()).padStart(2,'0');
  const MM = String(d.getMinutes()).padStart(2,'0');
  return `${dd}.${mm} ${HH}:${MM}`;
};
const fmtAge = (unix) => {
  const s = Math.floor(Date.now()/1000) - unix;
  if (s < 60) return `vor ${s}s`;
  if (s < 3600) return `vor ${Math.floor(s/60)}m`;
  if (s < 86400) return `vor ${Math.floor(s/3600)}h`;
  return `vor ${Math.floor(s/86400)}T`;
};
const escape = s => String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;');

async function loadStats() {
  const r = await fetch('/api/stats');
  const d = await r.json();
  const total = d.totals.reduce((a,b) => a + b.n, 0);
  $('#kpiAll').textContent = total.toLocaleString('de-DE');

  let postscreenN = 0, rspamdN = 0, quarantineN = 0;
  for (const t of d.totals) {
    if (t.source === 'postscreen') { postscreenN = t.n; $('#kpiPostscreen').textContent = t.n.toLocaleString('de-DE'); }
    if (t.source === 'rspamd') { rspamdN = t.n; $('#kpiRspamd').textContent = t.n.toLocaleString('de-DE'); }
    if (t.source === 'quarantine') { quarantineN = t.n; $('#kpiQuarantine').textContent = t.n.toLocaleString('de-DE'); }
  }

  // KPI trend: rate per hour
  const ratePerHour = (total / (7 * 24)).toFixed(1);
  $('#kpiTrend').textContent = `${ratePerHour} rejects/hour avg`;
  $('#sbRate').textContent = ratePerHour;

  // Statusbar
  const phishCat = d.byCategory.find(c => c.category === 'phishing');
  const brandCat = d.byCategory.find(c => c.category === 'brand_spoofing');
  $('#sbPhish').textContent = phishCat ? phishCat.n : '0';
  $('#sbBrand').textContent = brandCat ? brandCat.n : '0';
  $('#sbAi').textContent = state.ai.enabled ? 'online' : 'offline';
  if (!state.ai.enabled) $('#sbAi').className = 'statusbar-val';

  if (d.lastFetch && d.lastFetch.finished_at) {
    $('#lastFetch').textContent = `pull ${fmtAge(d.lastFetch.finished_at)} · ${d.lastFetch.inserted} new`;
  } else {
    $('#lastFetch').textContent = 'no pull yet';
  }

  // Category bars
  const maxCat = Math.max(...d.byCategory.map(c=>c.n), 1);
  $('#catBars').innerHTML = d.byCategory.slice(0, 12).map(c => `
    <div class="bar-row" data-category="${escape(c.category)}">
      <span class="key">${escape(c.label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(c.n/maxCat*100).toFixed(1)}%"></div></div>
      <span class="bar-num">${c.n}</span>
    </div>
  `).join('');
  $$('.bar-row').forEach(el => el.addEventListener('click', () => {
    state.category = el.dataset.category;
    $('#filterCategory').value = state.category;
    state.page = 0;
    loadTable();
  }));

  // Top senders
  const maxSender = Math.max(...d.topSenders.map(r => r.n), 1);
  $('#topSenders').innerHTML = d.topSenders.length
    ? d.topSenders.map(r => `
      <div class="list-row" data-q="${escape(r.envelope_from)}">
        <span class="key" title="${escape(r.envelope_from)}">${escape(r.envelope_from)}</span>
        <span class="mini-bar" style="--w:${(r.n/maxSender*100).toFixed(0)}%"></span>
        <span class="val">${r.n}</span>
      </div>`).join('')
    : '<div class="list-row"><span class="key">— no data —</span></div>';
  $$('#topSenders .list-row').forEach(el => el.addEventListener('click', () => {
    if (!el.dataset.q) return;
    state.q = el.dataset.q;
    $('#search').value = state.q;
    state.page = 0;
    loadTable();
  }));

  // Top IPs
  const maxIp = Math.max(...d.topIps.map(r => r.n), 1);
  $('#topIps').innerHTML = d.topIps.length
    ? d.topIps.map(r => `
      <div class="list-row" data-q="${escape(r.ip)}">
        <span class="key">${escape(r.ip)}</span>
        <span class="mini-bar" style="--w:${(r.n/maxIp*100).toFixed(0)}%"></span>
        <span class="val">${r.n}</span>
      </div>`).join('')
    : '<div class="list-row"><span class="key">— no data —</span></div>';
  $$('#topIps .list-row').forEach(el => el.addEventListener('click', () => {
    state.q = el.dataset.q;
    $('#search').value = state.q;
    state.page = 0;
    loadTable();
  }));

  drawDailyChart(d.perDay);

  // Populate category filter
  if (Object.keys(state.categories).length === 0) {
    const r2 = await fetch('/api/categories');
    state.categories = await r2.json();
    const sel = $('#filterCategory');
    Object.entries(state.categories).forEach(([k, v]) => {
      const opt = document.createElement('option');
      opt.value = k; opt.textContent = v;
      sel.appendChild(opt);
    });
  }
}

function drawDailyChart(perDay) {
  const canvas = $('#chartDaily');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const days = [...new Set(perDay.map(r => r.day))].sort();
  if (!days.length) {
    ctx.fillStyle = '#5d6678'; ctx.font = '12px Inter';
    ctx.fillText('Keine Daten', 10, 20);
    return;
  }
  const sources = ['postscreen', 'rspamd', 'quarantine'];
  const colors = { postscreen: '#f43f5e', rspamd: '#38bdf8', quarantine: '#a78bfa' };

  const buckets = days.map(day => {
    const obj = { day, postscreen: 0, rspamd: 0, quarantine: 0 };
    perDay.filter(r => r.day === day).forEach(r => { obj[r.source] = r.n; });
    obj.total = obj.postscreen + obj.rspamd + obj.quarantine;
    return obj;
  });

  const padL = 40, padR = 14, padT = 10, padB = 26;
  const cW = W - padL - padR, cH = H - padT - padB;
  const max = Math.max(...buckets.map(b => b.total), 1);
  const barW = cW / buckets.length * 0.7;
  const gap = cW / buckets.length * 0.3;

  // Y-axis grid
  ctx.strokeStyle = '#1e222b';
  ctx.fillStyle = '#4f535d';
  ctx.font = '10px "JetBrains Mono"';
  for (let i = 0; i <= 4; i++) {
    const y = padT + cH - (i / 4) * cH;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(Math.round(i / 4 * max).toString(), 4, y + 3);
  }

  buckets.forEach((b, i) => {
    const x = padL + i * (cW / buckets.length) + gap / 2;
    let y = padT + cH;
    sources.forEach(src => {
      const h = (b[src] / max) * cH;
      ctx.fillStyle = colors[src];
      ctx.fillRect(x, y - h, barW, h);
      y -= h;
    });
    if (i % Math.ceil(buckets.length / 7) === 0) {
      ctx.fillStyle = '#4f535d';
      ctx.font = '10px "JetBrains Mono"';
      ctx.fillText(b.day.slice(5), x, padT + cH + 16);
    }
  });
}

async function loadTable() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.source) params.set('source', state.source);
  if (state.category) params.set('category', state.category);
  if (state.days) params.set('days', state.days);
  params.set('limit', PAGE_SIZE);
  params.set('offset', state.page * PAGE_SIZE);

  const r = await fetch('/api/rejects?' + params);
  const d = await r.json();
  state.total = d.total;

  const tbody = $('#tbody');
  if (!d.rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#4f535d;padding:48px;font-family:var(--mono);text-transform:uppercase;font-size:10px;letter-spacing:0.1em">— no events —</td></tr>`;
  } else {
    tbody.innerHTML = d.rows.map(r => {
      const catLabel = state.categories[r.category] || r.category || '–';
      const subjOrReason = r.subject || r.reason || '';
      const ipDisplay = r.ip ? ` · ${r.ip}` : '';
      const score = r.max_score != null && r.max_score !== ''
        ? `<span class="score-pill ${r.max_score >= 12 ? '' : r.max_score >= 6 ? 'warn' : 'ham'}">${Number(r.max_score).toFixed(1)}</span>`
        : (r.score != null
            ? `<span class="score-pill ${r.score >= 12 ? '' : r.score >= 6 ? 'warn' : 'ham'}">${r.score.toFixed(1)}</span>`
            : '');
      const cnt = r.cnt || 1;
      const expandable = cnt > 1;
      const groupSig = JSON.stringify({
        source: r.source,
        envelope_from: r.envelope_from || '',
        subject: r.subject || '',
        category: r.category || '',
      });
      return `
        <tr data-id="${r.id}" class="main-row" data-group='${escape(groupSig).replace(/'/g, '&#39;')}'>
          <td class="col-expand">${expandable
            ? `<button class="expand-toggle" data-action="expand">▶</button>`
            : `<span class="expand-toggle disabled">·</span>`}</td>
          <td class="col-time">${fmtTs(r.unix_time)}</td>
          <td class="col-count"><span class="count-badge ${cnt >= 5 ? 'many' : ''}">${cnt}×</span></td>
          <td><span class="tag ${r.source}">${r.source}</span></td>
          <td><span class="tag cat">${escape(catLabel)}</span></td>
          <td class="col-from" title="${escape(r.envelope_from)}">${escape(r.envelope_from || '–')}</td>
          <td class="col-subject">${escape(subjOrReason)}<span style="color:#4f535d">${escape(ipDisplay)}</span></td>
          <td class="col-score">${score}</td>
        </tr>
      `;
    }).join('');
    $$('#tbody .main-row').forEach(tr => {
      const expandBtn = tr.querySelector('[data-action="expand"]');
      if (expandBtn) {
        expandBtn.addEventListener('click', e => { e.stopPropagation(); toggleGroupExpand(tr); });
      }
      tr.addEventListener('click', () => openDetail(tr.dataset.id));
    });
  }

  $('#resultCount').textContent = `${state.total.toLocaleString('de-DE')} Einträge`;
  $('#prevPage').disabled = state.page === 0;
  $('#nextPage').disabled = (state.page + 1) * PAGE_SIZE >= state.total;
  const last = Math.min(state.total, (state.page + 1) * PAGE_SIZE);
  $('#pageInfo').textContent = state.total
    ? `${state.page * PAGE_SIZE + 1}–${last} von ${state.total.toLocaleString('de-DE')}`
    : '–';
}

async function toggleGroupExpand(tr) {
  const btn = tr.querySelector('.expand-toggle');
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('sub-rows-block')) {
    // collapse
    next.remove();
    btn.textContent = '▶';
    btn.classList.remove('open');
    return;
  }
  btn.textContent = '▼';
  btn.classList.add('open');
  const sig = JSON.parse(tr.dataset.group.replace(/&#39;/g, "'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"'));
  const block = document.createElement('tr');
  block.className = 'sub-rows-block';
  block.innerHTML = `<td colspan="8" style="padding:0"><table style="width:100%"><tbody class="sub-list"><tr class="sub-row"><td colspan="8" class="loader">loading…</td></tr></tbody></table></td>`;
  tr.parentNode.insertBefore(block, tr.nextSibling);

  const params = new URLSearchParams({
    source: sig.source,
    envelope_from: sig.envelope_from,
    subject: sig.subject,
    category: sig.category,
  });
  if (state.days) params.set('days', state.days);
  try {
    const r = await fetch('/api/group?' + params);
    const data = await r.json();
    const subList = block.querySelector('.sub-list');
    if (!data.rows.length) {
      subList.innerHTML = `<tr class="sub-row"><td colspan="8" class="loader">— empty —</td></tr>`;
      return;
    }
    subList.innerHTML = data.rows.map(s => `
      <tr class="sub-row" data-id="${s.id}">
        <td colspan="8">
          <span class="sub-time">${fmtTs(s.unix_time)}</span>
          <span class="sub-ip">${escape(s.ip || '–')}</span>
          <span class="sub-to">→ ${escape(s.envelope_to || '–')}</span>
          <span class="sub-reason">${escape(s.reason || s.action || '')}</span>
          ${s.score != null ? `<span style="float:right" class="score-pill ${s.score >= 12 ? '' : s.score >= 6 ? 'warn' : 'ham'}">${s.score.toFixed(1)}</span>` : ''}
        </td>
      </tr>
    `).join('');
    $$('.sub-row[data-id]').forEach(el => el.addEventListener('click', () => openDetail(el.dataset.id)));
  } catch (e) {
    block.querySelector('.sub-list').innerHTML = `<tr class="sub-row"><td colspan="8" class="loader">error: ${escape(e.message || e)}</td></tr>`;
  }
}

async function loadAiStatus() {
  try {
    const r = await fetch('/api/ai/status');
    state.ai = await r.json();
  } catch {}
  try {
    const r = await fetch('/api/info');
    const info = await r.json();
    if (info.mailserver) {
      const el = document.getElementById('subtitle');
      if (el) el.textContent = `${info.mailserver} · ops console`;
    }
  } catch {}
}

async function loadInsights(force = false) {
  const days = state.insightsDays;
  const body = $('#insightsBody');
  if (!state.ai.enabled) {
    body.innerHTML = `<span class="insights-placeholder">KI nicht konfiguriert. Setze <code>GEMINI_API_KEY</code> in /etc/spamview.env und starte neu.</span>`;
    return;
  }
  body.innerHTML = '<span class="insights-placeholder">⏳ Analysiere…</span>';
  try {
    const url = `/api/ai/insights?days=${days}${force ? '&_=' + Date.now() : ''}`;
    const r = await fetch(url);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    const d = await r.json();
    body.innerHTML = mdToHtml(d.text);
    const meta = document.createElement('div');
    meta.className = 'insights-meta';
    meta.textContent = `Modell: ${state.ai.model} · ${d.cached ? 'aus Cache' : `${d.tokensIn || '?'} → ${d.tokensOut || '?'} Tokens`} · Zeitraum: ${d.days} T`;
    body.appendChild(meta);
  } catch (e) {
    body.innerHTML = `<div class="ai-error">Fehler: ${escape(e.message || e)}</div>`;
  }
}

async function runAiAnalysis(id) {
  const btn = $('#aiAnalyzeBtn');
  const out = $('#aiOutput');
  btn.disabled = true; btn.textContent = '⏳ Analysiere…';
  out.innerHTML = '';
  try {
    const r = await fetch(`/api/ai/analyze/${id}`, { method: 'POST' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    const d = await r.json();
    out.innerHTML = `<div class="ai-content">${mdToHtml(d.text)}</div>` +
      `<div class="insights-meta">Modell: ${state.ai.model}${d.cached ? ' · aus Cache' : ` · ${d.tokensIn || '?'} → ${d.tokensOut || '?'} Tokens`}</div>`;
    btn.style.display = 'none';
  } catch (e) {
    out.innerHTML = `<div class="ai-error">Fehler: ${escape(e.message || e)}</div>`;
    btn.disabled = false; btn.textContent = '🤖 KI-Analyse';
  }
}

async function openDetail(id) {
  const r = await fetch(`/api/reject/${id}`);
  const d = await r.json();
  if (!d) return;

  const symRows = d.symbols
    ? Object.entries(d.symbols)
        .filter(([k,v]) => v && (v.score || (v.options && v.options.length)))
        .sort((a,b) => Math.abs(b[1].score) - Math.abs(a[1].score))
        .map(([k,v]) => `
          <tr>
            <td class="sym">${escape(k)}</td>
            <td class="sym-score">${typeof v.score === 'number' ? (v.score > 0 ? '+' : '') + v.score.toFixed(2) : ''}</td>
            <td class="sym-options">${escape((v.options || []).join(', '))}</td>
          </tr>`).join('')
    : '';

  const bodyHtml = d.body
    ? `<div class="detail-section"><h4>Mail-Inhalt</h4><pre class="raw">${escape(d.body)}</pre></div>`
    : '';

  const rawHtml = d.raw
    ? `<div class="detail-section"><h4>Rohdaten / Logzeile</h4><pre class="raw">${escape(d.raw)}</pre></div>`
    : '';

  const symHtml = symRows
    ? `<div class="detail-section"><h4>Rspamd-Symbole</h4><table class="symbols-tbl">${symRows}</table></div>`
    : '';

  const aiBlock = state.ai.enabled
    ? `<div class="ai-section">
         <h4>🤖 KI-Analyse</h4>
         <button class="ai-btn" id="aiAnalyzeBtn">🤖 KI-Analyse starten</button>
         <div id="aiOutput"></div>
       </div>`
    : '';

  $('#modalBody').innerHTML = `
    <div class="detail-head">
      <h2>${escape(d.subject || d.reason || '(kein Subject)')}</h2>
      <div class="detail-meta">
        <span class="tag ${d.source}">${d.source}</span>
        <span class="tag cat" style="margin-left:8px">${escape(state.categories[d.category] || d.category || '')}</span>
        <span style="margin-left:12px">${fmtTs(d.unix_time)} · ${fmtAge(d.unix_time)}</span>
      </div>
    </div>
    ${aiBlock}
    <div class="detail-section">
      <h4>Header / Metadaten</h4>
      <div class="kv">
        <div class="k">Action</div><div class="v">${escape(d.action || '–')}</div>
        <div class="k">Score</div><div class="v">${d.score != null ? d.score.toFixed(2) + (d.required_score ? ' / ' + d.required_score.toFixed(0) : '') : '–'}</div>
        <div class="k">From (envelope)</div><div class="v">${escape(d.envelope_from || '–')}</div>
        <div class="k">From (Display)</div><div class="v">${escape(d.display_from || '–')}</div>
        <div class="k">To</div><div class="v">${escape(d.envelope_to || '–')}</div>
        <div class="k">IP</div><div class="v">${escape(d.ip || '–')}</div>
        <div class="k">HELO</div><div class="v">${escape(d.helo || '–')}</div>
        <div class="k">Größe</div><div class="v">${d.size ? d.size.toLocaleString('de-DE') + ' B' : '–'}</div>
        <div class="k">Reason</div><div class="v">${escape(d.reason || '–')}</div>
        <div class="k">RSpamd-ID</div><div class="v">${escape(d.rspamd_id || '–')}</div>
      </div>
    </div>
    ${symHtml}
    ${bodyHtml}
    ${rawHtml}
  `;
  $('#modal').classList.add('open');
  document.body.classList.add('modal-open');

  if (state.ai.enabled) {
    $('#aiAnalyzeBtn').addEventListener('click', () => runAiAnalysis(d.id));
  }
}

function closeModal() {
  $('#modal').classList.remove('open');
  document.body.classList.remove('modal-open');
}

function bindEvents() {
  let typingTimer;
  $('#search').addEventListener('input', e => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      state.page = 0;
      loadTable();
    }, 250);
  });
  $('#filterSource').addEventListener('change', e => { state.source = e.target.value; state.page = 0; loadTable(); });
  $('#filterCategory').addEventListener('change', e => { state.category = e.target.value; state.page = 0; loadTable(); });
  $('#filterDays').addEventListener('change', e => {
    state.days = e.target.value;
    state.page = 0;
    $('#sbWindow').textContent = state.days ? state.days + 'd' : 'all';
    loadTable();
  });
  $('#prevPage').addEventListener('click', () => { if (state.page > 0) { state.page--; loadTable(); } });
  $('#nextPage').addEventListener('click', () => { state.page++; loadTable(); });
  $('#refreshBtn').addEventListener('click', () => { loadStats(); loadTable(); });
  $('#modalClose').addEventListener('click', () => closeModal());
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  $$('.kpi').forEach(k => k.addEventListener('click', () => {
    const src = k.dataset.source;
    state.source = src === 'all' ? '' : src;
    $('#filterSource').value = state.source;
    state.page = 0;
    loadTable();
  }));
}

$('#insightsRefresh').addEventListener('click', () => loadInsights(true));
$('#insightsDays').addEventListener('change', e => { state.insightsDays = e.target.value; loadInsights(true); });

bindEvents();
loadAiStatus().then(() => {
  loadStats();
  loadTable();
  loadInsights();
});
setInterval(loadStats, 60000);
})();
