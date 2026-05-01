const crypto = require('crypto');
const db = require('./db');

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Cache lifetime: per-reject explanations 30 days, insights 6h.
const TTL = { reject: 30 * 86400, insights: 6 * 3600 };

function isEnabled() {
  return Boolean(API_KEY);
}

function hashKey(parts) {
  return crypto.createHash('sha256').update(parts.join('')).digest('hex').slice(0, 32);
}

function cacheGet(key, ttl) {
  const row = db.prepare('SELECT response, created_at FROM ai_cache WHERE cache_key = ?').get(key);
  if (!row) return null;
  if (ttl && (Date.now() / 1000 - row.created_at) > ttl) return null;
  return row.response;
}

function cachePut(key, kind, summary, response, tokensIn = 0, tokensOut = 0) {
  db.prepare(`
    INSERT OR REPLACE INTO ai_cache (cache_key, kind, input_summary, response, model, tokens_in, tokens_out, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(key, kind, summary, response, MODEL, tokensIn, tokensOut, Math.floor(Date.now() / 1000));
}

async function callGemini(prompt, { maxTokens = 1200, temperature = 0.2, thinking = false } = {}) {
  if (!API_KEY) throw new Error('GEMINI_API_KEY not configured');
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      responseMimeType: 'text/plain',
      thinkingConfig: { thinkingBudget: thinking ? -1 : 0 },
    },
  };
  const r = await fetch(`${ENDPOINT}?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Gemini ${r.status}: ${txt.slice(0, 400)}`);
  }
  const data = await r.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  const usage = data?.usageMetadata || {};
  return {
    text: text.trim(),
    tokensIn: usage.promptTokenCount || 0,
    tokensOut: usage.candidatesTokenCount || 0,
  };
}

/* -------- per-reject explanation -------- */

function describeReject(row) {
  const lines = [];
  lines.push(`Quelle: ${row.source}`);
  lines.push(`Aktion: ${row.action}`);
  if (row.score != null) lines.push(`Score: ${row.score}${row.required_score ? ' / ' + row.required_score : ''}`);
  if (row.category) lines.push(`Kategorie: ${row.category}`);
  if (row.subject) lines.push(`Betreff: ${row.subject}`);
  if (row.envelope_from) lines.push(`Absender (envelope): ${row.envelope_from}`);
  if (row.display_from) lines.push(`Absender (Display): ${row.display_from}`);
  if (row.envelope_to) lines.push(`Empfänger: ${row.envelope_to}`);
  if (row.ip) lines.push(`Sender-IP: ${row.ip}`);
  if (row.helo) lines.push(`HELO: ${row.helo}`);
  if (row.reason) lines.push(`Reason: ${row.reason}`);

  if (row.symbols_json) {
    try {
      const sym = JSON.parse(row.symbols_json);
      const list = Object.entries(sym)
        .filter(([, v]) => v && (v.score || (v.options && v.options.length)))
        .sort((a, b) => Math.abs(b[1].score || 0) - Math.abs(a[1].score || 0))
        .slice(0, 12)
        .map(([k, v]) => {
          const opts = v.options && v.options.length ? ` [${v.options.slice(0, 3).join(', ')}]` : '';
          const sc = typeof v.score === 'number' ? ` (${v.score > 0 ? '+' : ''}${v.score.toFixed(2)})` : '';
          return `  - ${k}${sc}${opts}`;
        });
      if (list.length) lines.push('Rspamd-Symbole:\n' + list.join('\n'));
    } catch {}
  }
  if (row.raw && row.source === 'postscreen') {
    lines.push(`Logzeile: ${row.raw.slice(0, 400)}`);
  }
  return lines.join('\n');
}

function rejectCacheKey(row) {
  let symKey = '';
  if (row.symbols_json) {
    try {
      const sym = JSON.parse(row.symbols_json);
      symKey = Object.keys(sym).sort().join(',');
    } catch {}
  }
  return hashKey(['reject_v2', row.source, row.action, row.category || '', symKey, row.reason || '']);
}

async function analyzeReject(row) {
  const key = rejectCacheKey(row);
  const cached = cacheGet(key, TTL.reject);
  if (cached) return { text: cached, cached: true };

  const summary = describeReject(row);
  const prompt = `Du bist ein deutschsprachiger E-Mail-Sicherheitsexperte. Analysiere die folgende abgewiesene E-Mail und erkläre dem Postmaster in klarem, präzisen Deutsch (2 bis 4 kurze Absätze):

1. **Warum abgewiesen?** — was die einzelnen Symbole/Reasons konkret bedeuten
2. **Wie gefährlich war das?** — Phishing-Versuch, generischer Spam, Botnet-Wurf, Misskonfiguration eines legitimen Senders, …
3. **Maßnahmen-Empfehlung** — falls relevant: was du anpassen würdest (z. B. Whitelist, weiterer Filter, Sender ignorieren). Wenn keine nötig: das auch sagen.

Schreibe nüchtern, ohne Marketing-Sprache, ohne Emojis. Verwende **fett** für Symbol-Namen und Schlüsselbegriffe. Keine Einleitungsphrase wie "Hier ist die Analyse".

Daten:
${summary}`;

  const { text, tokensIn, tokensOut } = await callGemini(prompt, { maxTokens: 800 });
  cachePut(key, 'reject', summary.slice(0, 1000), text, tokensIn, tokensOut);
  return { text, cached: false, tokensIn, tokensOut };
}

/* -------- aggregate insights -------- */

function buildInsightsContext(days = 7) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const totals = db.prepare(`
    SELECT source, COUNT(*) n FROM rejects WHERE unix_time >= ? GROUP BY source
  `).all(since);
  const cats = db.prepare(`
    SELECT category, COUNT(*) n FROM rejects WHERE unix_time >= ? GROUP BY category ORDER BY n DESC
  `).all(since);
  const topSenders = db.prepare(`
    SELECT envelope_from, COUNT(*) n FROM rejects
    WHERE unix_time >= ? AND envelope_from IS NOT NULL AND envelope_from != ''
    GROUP BY envelope_from ORDER BY n DESC LIMIT 12
  `).all(since);
  const topIps = db.prepare(`
    SELECT ip, COUNT(*) n FROM rejects
    WHERE unix_time >= ? AND ip IS NOT NULL AND ip != ''
    GROUP BY ip ORDER BY n DESC LIMIT 12
  `).all(since);
  const topSubjects = db.prepare(`
    SELECT subject, COUNT(*) n FROM rejects
    WHERE unix_time >= ? AND subject IS NOT NULL AND subject != ''
    GROUP BY subject ORDER BY n DESC LIMIT 15
  `).all(since);
  const topSymbols = db.prepare(`
    SELECT symbols_json FROM rejects
    WHERE unix_time >= ? AND symbols_json IS NOT NULL
    LIMIT 500
  `).all(since);

  const symFreq = {};
  for (const row of topSymbols) {
    try {
      const obj = JSON.parse(row.symbols_json);
      for (const k of Object.keys(obj)) symFreq[k] = (symFreq[k] || 0) + 1;
    } catch {}
  }
  const topSym = Object.entries(symFreq).sort((a, b) => b[1] - a[1]).slice(0, 15);

  const lines = [];
  lines.push(`Zeitraum: letzte ${days} Tage`);
  lines.push(`\nVerteilung nach Quelle:\n${totals.map(t => `  ${t.source}: ${t.n}`).join('\n')}`);
  lines.push(`\nTop-Kategorien:\n${cats.slice(0, 12).map(c => `  ${c.category}: ${c.n}`).join('\n')}`);
  lines.push(`\nHäufigste Rspamd-Symbole:\n${topSym.map(([k, n]) => `  ${k}: ${n}×`).join('\n')}`);
  if (topSenders.length) lines.push(`\nTop-Absender:\n${topSenders.map(s => `  ${s.envelope_from}: ${s.n}`).join('\n')}`);
  if (topIps.length) lines.push(`\nTop-IPs:\n${topIps.map(s => `  ${s.ip}: ${s.n}`).join('\n')}`);
  if (topSubjects.length) lines.push(`\nWiederkehrende Subjects:\n${topSubjects.map(s => `  "${(s.subject || '').slice(0, 80)}": ${s.n}×`).join('\n')}`);

  return { context: lines.join('\n'), totals, cats };
}

async function generateInsights(days = 7) {
  const { context, totals, cats } = buildInsightsContext(days);
  const day = new Date().toISOString().slice(0, 13);
  const key = hashKey(['insights_v2', String(days), day, JSON.stringify(totals), JSON.stringify(cats.slice(0, 5))]);
  const cached = cacheGet(key, TTL.insights);
  if (cached) return { text: cached, cached: true };

  const prompt = `Du bist ein deutschsprachiger E-Mail-Postmaster-Assistent. Werte die folgenden Reject-Statistiken aus und gib eine kompakte Lage-Einschätzung in Markdown:

## Zusammenfassung
- 2-3 Sätze, was im Beobachtungszeitraum los war (Volumen-Charakter, Auffälligkeiten)

## Auffällige Muster
- 3-5 Bullet-Points: erkennbare Phishing-/Spam-Wellen, häufig wiederholte Subjects, problematische Sender, geografische/ASN-Cluster falls sichtbar

## Empfehlungen
- 2-4 konkrete, umsetzbare Aktionen (z. B. „Symbol X im Score erhöhen", „IP Y permanent blacklisten", „Subject-Pattern Z in Rspamd-Map aufnehmen")
- wenn nichts dringend: explizit sagen „aktuell keine Maßnahme nötig"

Schreibe nüchtern, knapp, ohne Marketing. Keine Einleitung wie "Hier ist die Analyse". Verwende **fett** für Symbol-/Subject-Namen und Schlüsselbegriffe.

Daten:
${context}`;

  const { text, tokensIn, tokensOut } = await callGemini(prompt, { maxTokens: 1500 });
  cachePut(key, 'insights', context.slice(0, 2000), text, tokensIn, tokensOut);
  return { text, cached: false, tokensIn, tokensOut };
}

module.exports = { isEnabled, analyzeReject, generateInsights, MODEL };
