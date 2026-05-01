const express = require('express');
const path = require('path');
const db = require('./db');
const ai = require('./ai');

const app = express();
const PORT = process.env.PORT || 3050;
const HOST = process.env.HOST || '127.0.0.1';

app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const CATEGORY_LABEL = {
  rbl: 'RBL/DNSBL',
  postscreen: 'Postscreen',
  pregreet: 'Pregreet',
  pipelining: 'Pipelining',
  bare_newline: 'Bare Newline',
  non_smtp: 'Non-SMTP',
  hangup: 'Hangup',
  blacklist: 'Blacklist',
  brand_spoofing: 'Marken-Spoofing',
  phishing: 'Phishing',
  malware_url: 'Malware-URL',
  bad_attachment: 'Anhang',
  dmarc_fail: 'DMARC-Fail',
  spf_fail: 'SPF-Fail',
  dkim_fail: 'DKIM-Fail',
  displayname_spoof: 'Display-Name-Spoof',
  bad_subject: 'Bad-Subject',
  bad_language: 'Sprache',
  spammy_content: 'Spam-Wörter',
  reject: 'Reject',
  'add header': 'Spam-Tag',
  'rewrite subject': 'Subject-Rewrite',
  'soft reject': 'Greylist/Soft',
  unknown: 'Sonstige',
};

app.get('/api/stats', (req, res) => {
  const totals = db.prepare(`
    SELECT source, COUNT(*) as n
    FROM rejects
    WHERE unix_time > strftime('%s','now') - 7*86400
    GROUP BY source
  `).all();

  const byCategory = db.prepare(`
    SELECT category, COUNT(*) as n
    FROM rejects
    WHERE unix_time > strftime('%s','now') - 7*86400
    GROUP BY category
    ORDER BY n DESC
  `).all();

  const perDay = db.prepare(`
    SELECT
      strftime('%Y-%m-%d', unix_time, 'unixepoch', 'localtime') as day,
      source,
      COUNT(*) as n
    FROM rejects
    WHERE unix_time > strftime('%s','now') - 14*86400
    GROUP BY day, source
    ORDER BY day
  `).all();

  const topSenders = db.prepare(`
    SELECT envelope_from, COUNT(*) as n
    FROM rejects
    WHERE envelope_from IS NOT NULL AND envelope_from != ''
      AND unix_time > strftime('%s','now') - 7*86400
    GROUP BY envelope_from ORDER BY n DESC LIMIT 15
  `).all();

  const topIps = db.prepare(`
    SELECT ip, COUNT(*) as n
    FROM rejects
    WHERE ip IS NOT NULL AND ip != ''
      AND unix_time > strftime('%s','now') - 7*86400
    GROUP BY ip ORDER BY n DESC LIMIT 15
  `).all();

  const lastFetch = db.prepare(`SELECT * FROM fetch_log ORDER BY id DESC LIMIT 1`).get();

  res.json({
    totals,
    byCategory: byCategory.map(r => ({ ...r, label: CATEGORY_LABEL[r.category] || r.category })),
    perDay,
    topSenders,
    topIps,
    lastFetch,
  });
});

function buildRejectFilter(query) {
  const { source, category, q, days } = query;
  const conditions = [];
  const params = {};
  const since = days ? Math.floor(Date.now() / 1000) - parseInt(days) * 86400 : null;

  if (source) { conditions.push('source = @source'); params.source = source; }
  if (category) { conditions.push('category = @category'); params.category = category; }
  if (since) { conditions.push('unix_time >= @since'); params.since = since; }
  if (q) {
    conditions.push(`(
      envelope_from LIKE @q OR envelope_to LIKE @q OR
      subject LIKE @q OR ip LIKE @q OR helo LIKE @q OR
      reason LIKE @q OR display_from LIKE @q
    )`);
    params.q = `%${q}%`;
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

app.get('/api/rejects', (req, res) => {
  const grouped = req.query.grouped !== '0';
  const { where, params } = buildRejectFilter(req.query);
  const lim = Math.min(parseInt(req.query.limit) || 100, 500);
  const off = parseInt(req.query.offset) || 0;

  if (!grouped) {
    const rows = db.prepare(`
      SELECT id, source, unix_time, ip, helo, envelope_from, envelope_to,
             display_from, subject, action, score, required_score,
             reason, category, size
      FROM rejects ${where}
      ORDER BY unix_time DESC LIMIT ${lim} OFFSET ${off}
    `).all(params);
    const total = db.prepare(`SELECT COUNT(*) as n FROM rejects ${where}`).get(params).n;
    return res.json({ rows, total, limit: lim, offset: off, grouped: false });
  }

  // Grouped mode: aggregate by source + envelope_from + subject + category.
  // The "representative" row data is taken from the latest event in each group.
  const groupQuery = `
    WITH g AS (
      SELECT
        source,
        COALESCE(envelope_from, '') AS gf,
        COALESCE(subject, '')        AS gs,
        COALESCE(category, '')       AS gc,
        COUNT(*)                     AS cnt,
        MIN(unix_time)               AS first_time,
        MAX(unix_time)               AS last_time,
        MAX(score)                   AS max_score,
        MAX(id)                      AS latest_id,
        COUNT(DISTINCT ip)           AS ip_count,
        COUNT(DISTINCT envelope_to)  AS rcpt_count
      FROM rejects ${where}
      GROUP BY source, gf, gs, gc
    )
    SELECT g.*,
           r.id, r.unix_time, r.ip, r.helo, r.envelope_from, r.envelope_to,
           r.display_from, r.subject, r.action, r.score, r.required_score,
           r.reason, r.category
    FROM g
    JOIN rejects r ON r.id = g.latest_id
    ORDER BY g.last_time DESC
    LIMIT ${lim} OFFSET ${off}
  `;
  const rows = db.prepare(groupQuery).all(params);
  const totalQ = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM rejects ${where}
      GROUP BY source, COALESCE(envelope_from,''), COALESCE(subject,''), COALESCE(category,'')
    )
  `).get(params).n;

  res.json({ rows, total: totalQ, limit: lim, offset: off, grouped: true });
});

app.get('/api/group', (req, res) => {
  const { source, envelope_from = '', subject = '', category = '', days } = req.query;
  const conditions = ['source = @source',
                      "COALESCE(envelope_from,'') = @envelope_from",
                      "COALESCE(subject,'') = @subject",
                      "COALESCE(category,'') = @category"];
  const params = { source, envelope_from, subject, category };
  if (days) {
    conditions.push('unix_time >= @since');
    params.since = Math.floor(Date.now() / 1000) - parseInt(days) * 86400;
  }
  const rows = db.prepare(`
    SELECT id, unix_time, ip, helo, envelope_to, display_from, score, reason, action
    FROM rejects WHERE ${conditions.join(' AND ')}
    ORDER BY unix_time DESC LIMIT 200
  `).all(params);
  res.json({ rows, total: rows.length });
});

app.get('/api/reject/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM rejects WHERE id = ?').get(parseInt(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.symbols_json) {
    try { row.symbols = JSON.parse(row.symbols_json); } catch {}
  }
  res.json(row);
});

app.get('/api/categories', (req, res) => {
  res.json(CATEGORY_LABEL);
});

app.get('/api/ai/status', (req, res) => {
  res.json({ enabled: ai.isEnabled(), model: ai.MODEL });
});

app.get('/api/info', (req, res) => {
  res.json({
    mailserver: process.env.MAILSERVER_HOST || '—',
    project: process.env.MAILCOW_PROJECT || 'mailcowdockerized',
  });
});

app.post('/api/ai/analyze/:id', async (req, res) => {
  if (!ai.isEnabled()) return res.status(503).json({ error: 'KI nicht konfiguriert (GEMINI_API_KEY fehlt)' });
  const row = db.prepare('SELECT * FROM rejects WHERE id = ?').get(parseInt(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  try {
    const result = await ai.analyzeReject(row);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/ai/insights', async (req, res) => {
  if (!ai.isEnabled()) return res.status(503).json({ error: 'KI nicht konfiguriert (GEMINI_API_KEY fehlt)' });
  const days = Math.max(1, Math.min(30, parseInt(req.query.days) || 7));
  try {
    const result = await ai.generateInsights(days);
    res.json({ ...result, days });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, HOST, () => console.log(`[spamview] listening on ${HOST}:${PORT}`));
