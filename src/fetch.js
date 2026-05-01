#!/usr/bin/env node
/**
 * Pulls reject data from a remote Mailcow server into local SQLite.
 *
 * Required env vars:
 *   MAILSERVER_HOST  — fqdn / ip of the mailserver
 *   MAILSERVER_USER  — ssh user (must have sudo + docker access)
 *   MAILSERVER_KEY   — path to ssh private key
 * Optional:
 *   MAILCOW_PROJECT  — docker compose project (default: mailcowdockerized)
 *   MAILCOW_PATH     — path to mailcow on remote (default: /opt/mailcow-dockerized)
 *   IGNORE_HOSTS     — comma-separated regex list of envelope_from / helo to drop
 */
const { execSync, execFileSync } = require('child_process');
const zlib = require('zlib');
const db = require('./db');

const HOST = process.env.MAILSERVER_HOST;
const USER = process.env.MAILSERVER_USER || 'debian';
const KEY  = process.env.MAILSERVER_KEY  || '/var/lib/spamview/.ssh/id_ed25519';
const PROJ = process.env.MAILCOW_PROJECT || 'mailcowdockerized';
const MPATH = process.env.MAILCOW_PATH   || '/opt/mailcow-dockerized';

if (!HOST) { console.error('MAILSERVER_HOST not set'); process.exit(1); }

const TARGET = `${USER}@${HOST}`;
const C_POSTFIX = `${PROJ}-postfix-mailcow-1`;
const C_REDIS   = `${PROJ}-redis-mailcow-1`;
const C_RSPAMD  = `${PROJ}-rspamd-mailcow-1`;
const C_MYSQL   = `${PROJ}-mysql-mailcow-1`;
const SSH_OPTS = ['-i', KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];

const IGNORE_PATTERNS = (process.env.IGNORE_HOSTS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(s => { try { return new RegExp(s, 'i'); } catch { return null; } })
  .filter(Boolean);

function isOwnNoise(envFrom, helo) {
  if (!IGNORE_PATTERNS.length) return false;
  const s = `${envFrom || ''} ${helo || ''}`;
  return IGNORE_PATTERNS.some(p => p.test(s));
}

function sshExec(remoteCmd, opts = {}) {
  return execFileSync('ssh', [...SSH_OPTS, TARGET, remoteCmd], {
    encoding: opts.encoding || 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
}

function logRun(state) {
  const now = Math.floor(Date.now() / 1000);
  if (state.id == null) {
    const r = db.prepare('INSERT INTO fetch_log (started_at) VALUES (?)').run(now);
    state.id = r.lastInsertRowid;
    return;
  }
  db.prepare('UPDATE fetch_log SET finished_at=?, ok=?, inserted=?, message=? WHERE id=?')
    .run(now, state.ok ? 1 : 0, state.inserted || 0, state.message || '', state.id);
}

function fingerprint(parts) {
  const crypto = require('crypto');
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

const insertStmt = db.prepare(`
INSERT OR IGNORE INTO rejects
(source, unix_time, rspamd_id, ip, helo, envelope_from, envelope_to,
 display_from, subject, action, score, required_score, symbols_json,
 reason, category, size, raw, body, fingerprint)
VALUES (@source, @unix_time, @rspamd_id, @ip, @helo, @envelope_from,
        @envelope_to, @display_from, @subject, @action, @score, @required_score,
        @symbols_json, @reason, @category, @size, @raw, @body, @fingerprint)
`);

function classifyRspamd(action, symbols) {
  if (!symbols || typeof symbols !== 'object') return action;
  if (symbols.SPOOFED_BRAND_DN) return 'brand_spoofing';
  if (symbols.PHISHED_OPENPHISH || symbols.PHISHED_PHISHTANK || symbols.PHISHING) return 'phishing';
  if (symbols.URLHAUS_ABUSE_CH || symbols.BAZAAR_ABUSE_CH) return 'malware_url';
  if (symbols.MIME_DOUBLE_BAD_EXTENSION || symbols.MIME_BAD_ATTACHMENT) return 'bad_attachment';
  if (symbols.DMARC_POLICY_REJECT || symbols.DMARC_POLICY_QUARANTINE) return 'dmarc_fail';
  if (symbols.R_SPF_FAIL || symbols.R_SPF_SOFTFAIL) return 'spf_fail';
  if (symbols.R_DKIM_REJECT) return 'dkim_fail';
  if (symbols.RBL_INTERSERVER_BAD_IP || symbols.GLOBAL_SMTP_FROM_BL) return 'rbl';
  if (symbols.FROM_NEQ_DISPLAY_NAME) return 'displayname_spoof';
  if (symbols.BAD_SUBJECT_00) return 'bad_subject';
  if (symbols.BAD_LANG || symbols.LANG_FILTER) return 'bad_language';
  if (symbols.BAD_WORDS || symbols.BAD_WORDS_DE) return 'spammy_content';
  return action || 'unknown';
}

function pullRspamdHistory() {
  console.log('[rspamd] pulling history list...');
  const remote = `
    set -e
    REDISPASS=$(sudo grep ^REDISPASS ${MPATH}/mailcow.conf | cut -d= -f2)
    sudo docker exec ${C_REDIS} sh -c "
      redis-cli -a '$REDISPASS' --no-auth-warning LLEN rs_historyrspamd_zst >/tmp/.len
      LEN=\\$(cat /tmp/.len)
      i=0
      while [ \\$i -lt \\$LEN ]; do
        redis-cli -a '$REDISPASS' --no-auth-warning LINDEX rs_historyrspamd_zst \\$i > /tmp/.entry 2>/dev/null
        printf '%s\\n' \\"\\$(base64 -w0 /tmp/.entry)\\"
        i=\\$((i+1))
      done
    "
  `;

  const out = sshExec(remote);
  const lines = out.split('\n').filter(Boolean);
  console.log(`[rspamd] got ${lines.length} entries`);

  let inserted = 0;
  for (const b64 of lines) {
    try {
      const compressed = Buffer.from(b64, 'base64');
      let payload = compressed;
      while (payload.length && payload[payload.length - 1] === 0x0a) {
        payload = payload.slice(0, -1);
      }
      if (payload.length === 0) continue;
      const raw = zlib.zstdDecompressSync ? zlib.zstdDecompressSync(payload) : null;
      if (!raw) {
        const tmp = '/tmp/.zst-entry';
        require('fs').writeFileSync(tmp, payload);
        const json = execSync(`zstd -dc ${tmp}`, { maxBuffer: 32 * 1024 * 1024 }).toString();
        processRspamdEntry(json);
        inserted++;
        continue;
      }
      processRspamdEntry(raw.toString());
      inserted++;
    } catch (e) { /* skip corrupt entry */ }
  }

  function processRspamdEntry(jsonStr) {
    let obj;
    try { obj = JSON.parse(jsonStr); } catch { return; }
    if (!obj || !obj.action) return;
    if (!['reject', 'add header', 'soft reject', 'rewrite subject'].includes(obj.action)) return;
    if (isOwnNoise(obj.sender_smtp || obj.sender_mime, obj.helo)) return;
    const symbols = obj.symbols || {};
    const fp = fingerprint(['rspamd', obj['message-id'] || obj.id || '', obj.unix_time || 0]);
    const symKeys = Object.keys(symbols);
    insertStmt.run({
      source: 'rspamd',
      unix_time: obj.unix_time || obj.time || Math.floor(Date.now() / 1000),
      rspamd_id: obj['message-id'] || obj.id || null,
      ip: obj.ip || null,
      helo: obj.helo || null,
      envelope_from: (obj.sender_smtp && obj.sender_smtp !== 'unknown' ? obj.sender_smtp : null)
                  || (obj.from_smtp || obj.smtp_from || null),
      envelope_to: Array.isArray(obj.rcpt_smtp) && obj.rcpt_smtp.length ? obj.rcpt_smtp.join(', ')
                  : (Array.isArray(obj.rcpt_mime) ? obj.rcpt_mime.join(', ') : null),
      display_from: obj.sender_mime || (Array.isArray(obj.from_mime) ? obj.from_mime.join(', ') : (obj.from_mime || null)),
      subject: obj.subject || null,
      action: obj.action,
      score: typeof obj.score === 'number' ? obj.score : null,
      required_score: typeof obj.required_score === 'number' ? obj.required_score : null,
      symbols_json: JSON.stringify(symKeys.reduce((acc, k) => {
        const s = symbols[k];
        acc[k] = { score: s.score || 0, options: s.options || [] };
        return acc;
      }, {})),
      reason: symKeys.slice(0, 5).join(', '),
      category: classifyRspamd(obj.action, symbols),
      size: obj.size || null,
      raw: jsonStr.length < 32000 ? jsonStr : jsonStr.slice(0, 32000),
      body: null,
      fingerprint: fp,
    });
  }

  return inserted;
}

function pullPostscreenLogs() {
  console.log('[postscreen] pulling logs...');
  const remote = `sudo docker logs --since 168h ${C_POSTFIX} 2>&1 | grep -E "postscreen.*(reject|HANGUP|BLACKLIST|PREGREET|BARE NEWLINE|NON-SMTP|PIPELINING)"`;
  let out;
  try { out = sshExec(remote); } catch (e) { if (e.stdout) out = e.stdout.toString(); else throw e; }
  const lines = out.split('\n').filter(Boolean);
  console.log(`[postscreen] got ${lines.length} log lines`);

  const yearNow = new Date().getFullYear();
  let inserted = 0;
  for (const line of lines) {
    const tsMatch = line.match(/^(\w{3} \d+ \d{2}:\d{2}:\d{2})/);
    let unix_time;
    if (tsMatch) {
      const dt = new Date(`${tsMatch[1]} ${yearNow} UTC`);
      unix_time = Math.floor(dt.getTime() / 1000);
      if (unix_time > Date.now() / 1000 + 86400) unix_time -= 365 * 86400;
    } else { unix_time = Math.floor(Date.now() / 1000); }

    const ipMatch = line.match(/client \[([^\]]+)\]/) || line.match(/from \[([^\]]+)\]/);
    const ip = ipMatch ? ipMatch[1] : null;
    const fromMatch = line.match(/from=<([^>]*)>/);
    const toMatch = line.match(/to=<([^>]*)>/);
    const heloMatch = line.match(/helo=<([^>]*)>/);
    let reason = 'postscreen reject';
    let category = 'postscreen';
    const rblMatch = line.match(/blocked using ([\w\.\-]+)/);
    if (rblMatch) { reason = `RBL: ${rblMatch[1]}`; category = 'rbl'; }
    else if (/PREGREET/.test(line)) { reason = 'PREGREET'; category = 'pregreet'; }
    else if (/PIPELINING/.test(line)) { reason = 'PIPELINING'; category = 'pipelining'; }
    else if (/BARE NEWLINE/.test(line)) { reason = 'BARE NEWLINE'; category = 'bare_newline'; }
    else if (/NON-SMTP/.test(line)) { reason = 'NON-SMTP COMMAND'; category = 'non_smtp'; }
    else if (/HANGUP/.test(line)) { reason = 'HANGUP'; category = 'hangup'; }
    else if (/BLACKLIST/.test(line)) { reason = 'Postscreen blacklist'; category = 'blacklist'; }

    if (isOwnNoise(fromMatch?.[1], heloMatch?.[1])) continue;

    const fp = fingerprint(['postscreen', unix_time, ip || '', fromMatch?.[1] || '', toMatch?.[1] || '', reason]);
    insertStmt.run({
      source: 'postscreen',
      unix_time,
      rspamd_id: null,
      ip,
      helo: heloMatch ? heloMatch[1] : null,
      envelope_from: fromMatch ? fromMatch[1] : null,
      envelope_to: toMatch ? toMatch[1] : null,
      display_from: null,
      subject: null,
      action: 'reject',
      score: null,
      required_score: null,
      symbols_json: null,
      reason,
      category,
      size: null,
      raw: line,
      body: null,
      fingerprint: fp,
    });
    inserted++;
  }
  return inserted;
}

function pullQuarantine() {
  console.log('[quarantine] pulling DB...');
  const remote = `
    set -e
    DBPW=$(sudo grep ^DBROOT ${MPATH}/mailcow.conf | cut -d= -f2)
    sudo docker exec ${C_MYSQL} mariadb -u root -p"$DBPW" mailcow -B -N -e "
      SELECT id, qid, IFNULL(subject,''), IFNULL(score,0), IFNULL(ip,''), action,
             IFNULL(symbols,'{}'), sender, IFNULL(rcpt,''), IFNULL(domain,''),
             UNIX_TIMESTAMP(created), IFNULL(msg,'')
      FROM quarantine ORDER BY created DESC LIMIT 5000
    " 2>/dev/null | base64 -w0
  `;
  let out;
  try { out = sshExec(remote).trim(); } catch { return 0; }
  if (!out) return 0;
  const decoded = Buffer.from(out, 'base64').toString();
  const rows = decoded.split('\n').filter(Boolean);
  let inserted = 0;
  for (const row of rows) {
    const cols = row.split('\t');
    if (cols.length < 12) continue;
    const [id, qid, subject, score, ip, action, symbols, sender, rcpt, domain, ts, body] = cols;
    let symObj = {};
    try { symObj = JSON.parse(symbols); } catch {}
    const fp = fingerprint(['quarantine', qid, ts]);
    insertStmt.run({
      source: 'quarantine',
      unix_time: parseInt(ts, 10) || Math.floor(Date.now() / 1000),
      rspamd_id: qid,
      ip,
      helo: null,
      envelope_from: sender,
      envelope_to: rcpt,
      display_from: null,
      subject,
      action,
      score: parseFloat(score) || null,
      required_score: null,
      symbols_json: JSON.stringify(symObj),
      reason: Object.keys(symObj).slice(0, 5).join(', '),
      category: classifyRspamd(action, symObj),
      size: body ? body.length : null,
      raw: null,
      body: body && body.length < 200000 ? body : (body ? body.slice(0, 200000) : null),
      fingerprint: fp,
    });
    inserted++;
  }
  return inserted;
}

function main() {
  const state = { ok: false, inserted: 0, message: '' };
  logRun(state);
  try {
    let n = 0;
    n += pullRspamdHistory();
    n += pullPostscreenLogs();
    n += pullQuarantine();
    state.inserted = n;
    state.ok = true;
    state.message = `inserted/seen ${n}`;
    console.log(`[fetch] done: ${n} entries processed`);
  } catch (e) {
    state.message = String(e.message || e).slice(0, 1000);
    console.error('[fetch] FAILED', e);
  } finally { logRun(state); }
}

if (require.main === module) main();
module.exports = { main };
