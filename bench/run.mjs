#!/usr/bin/env node
/**
 * mail-index vs. a stock Gmail-API MCP — token benchmark.
 *
 * Measures the two token taxes an MCP server imposes on an agent's context:
 *   1. FIXED schema tax — the tool definitions injected every turn (tools/list).
 *   2. PER-TASK result tax — the tokens each tool RETURNS to answer a question.
 *
 * The mail-index side calls the real MCP server over stdio. The Gmail side uses
 * REAL Gmail API payloads (fetched via the `gws` CLI) — the exact JSON a stock
 * Gmail MCP (e.g. messages.list + messages.get) hands the model — so this is a
 * faithful comparison, not a strawman. We model the Gmail "find then read" path
 * honestly (see GMAIL MODEL below) and document every assumption.
 *
 * Token counting: uses the Anthropic count_tokens API when ANTHROPIC_API_KEY is
 * set (Claude-accurate); otherwise a chars/4 approximation. The HEADLINE is the
 * ratio, which is stable across tokenizers.
 *
 * Usage:
 *   node bench/run.mjs [--account personal] [--gmail-tools bench/gmail-mcp-tools.json]
 * Real subjects/senders may appear in results → written to bench/results.local.md
 * (gitignored). Aggregate ratios are printed to stdout (safe to share).
 *
 * GMAIL MODEL (per search/recall task), kept deliberately GENEROUS to Gmail:
 *   - messages.list(q) returns {id, threadId} ONLY (no snippet) — real gws output.
 *   - To identify the answer among hits, the agent must messages.get each
 *     candidate. We charge the top-3 candidates at format=metadata + ONE
 *     format=full for the chosen answer. (Real agents often fetch more / guess
 *     the query several times; we charge the best case.)
 *   - mail-index search returns ranked snippet rows in ONE call; get_message is
 *     one compact (optionally body-level) call.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const NODE = process.execPath;
const MCP_ENTRY = join(REPO, 'dist', 'mcp', 'index.js');

const args = parseFlags(process.argv.slice(2));
const ACCOUNT = args.account ?? 'personal';
const GMAIL_TOOLS_PATH = args['gmail-tools'] ?? join(HERE, 'gmail-mcp-tools.json');
const CONFIG_DIR = resolveConfigDir(ACCOUNT);

// ---- token counting -------------------------------------------------------

const APX = (s) => Math.ceil((s ?? '').length / 4);
let COUNT_MODE = 'chars/4 (approx — set ANTHROPIC_API_KEY for exact Claude counts)';

async function countTokens(text) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return APX(text);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: text || ' ' }],
      }),
    });
    if (!res.ok) return APX(text);
    const j = await res.json();
    COUNT_MODE = 'Anthropic count_tokens API (claude-sonnet-4-6)';
    return j.input_tokens ?? APX(text);
  } catch {
    return APX(text);
  }
}

// ---- mail-index MCP stdio client ------------------------------------------

function mcpSession() {
  const child = spawn(NODE, [MCP_ENTRY], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const waiters = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const myId = ++id;
      waiters.set(myId, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    });
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  return {
    async init() {
      await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bench', version: '1' },
      });
      notify('notifications/initialized', {});
    },
    listTools: () => rpc('tools/list', {}),
    call: (name, a) => rpc('tools/call', { name, arguments: a }),
    close: () => child.kill(),
  };
}

function toolResultText(msg) {
  const c = msg?.result?.content;
  return Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : JSON.stringify(msg?.result ?? {});
}

// ---- Gmail API via gws ----------------------------------------------------

function gws(params) {
  return new Promise((resolve, reject) => {
    const child = spawn('gws', ['gmail', 'users', 'messages', ...params], {
      env: { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: CONFIG_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`gws exited ${code}: ${err.slice(0, 200)}`)),
    );
  });
}

const gmailList = (q, max = 10) =>
  gws(['list', '--params', JSON.stringify({ userId: 'me', q, maxResults: max })]);
const gmailGet = (id, format) =>
  gws(['get', '--params', JSON.stringify({ userId: 'me', id, format })]);

// ---- the task suite (generic; queries derive real ids at runtime) ---------

// 30 common use cases. kind drives the Gmail cost model:
//   recall  — find one message: list + top-3 metadata gets to identify it.
//   read    — read one message fully: list + 1 format=full get.
//   scan    — aggregate over many ("list all X"): list + one metadata get PER MATCH
//             (sampled avg × match count). You must read each to answer.
//   relational — contacts/graph/"what did I miss": the stock Gmail MCP has no
//             primitive, so it must scan + aggregate the mailbox (modeled as a
//             scan over the broad query). mail-index answers from precomputed
//             structure in one compact call.
const S = 200; // mail-index search limit for scan/relational
const TASKS = [
  // ---- A. Aggregation / "list all …" (scan) ----
  { cat: 'aggregate', kind: 'scan', label: 'all supplier / vendor emails (6mo)', mi: { tool: 'search', args: { query: 'invoice OR purchase order OR quote OR supplier OR vendor OR shipment OR delivery', limit: S } }, gmailQ: 'invoice OR "purchase order" OR quote OR supplier OR vendor OR shipment newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all purchases & receipts (6mo)', mi: { tool: 'search', args: { query: 'receipt OR order OR invoice OR payment OR purchase OR dispatched OR refund', limit: S } }, gmailQ: 'receipt OR order OR invoice OR payment OR purchase OR dispatched OR refund newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all invoices received (6mo)', mi: { tool: 'search', args: { query: 'invoice OR bill OR amount due OR statement', limit: S } }, gmailQ: 'invoice OR bill OR "amount due" OR statement newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all newsletters / subscriptions (6mo)', mi: { tool: 'search', args: { query: 'newsletter OR digest OR weekly OR briefing OR unsubscribe', limit: S } }, gmailQ: 'unsubscribe OR newsletter OR digest newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all meetings / calendar invites (6mo)', mi: { tool: 'search', args: { query: 'invite OR meeting OR calendar OR scheduled OR rsvp', limit: S } }, gmailQ: 'invite OR meeting OR calendar OR rsvp newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all travel / flight / hotel confirmations (6mo)', mi: { tool: 'search', args: { query: 'flight OR booking OR reservation OR itinerary OR hotel OR check-in', limit: S } }, gmailQ: 'flight OR booking OR reservation OR itinerary OR hotel newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all shipping / delivery notifications (6mo)', mi: { tool: 'search', args: { query: 'shipped OR dispatched OR delivery OR tracking OR out for delivery', limit: S } }, gmailQ: 'shipped OR dispatched OR delivery OR tracking newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all bank / financial statements (6mo)', mi: { tool: 'search', args: { query: 'statement OR balance OR deposit OR transaction OR account summary', limit: S } }, gmailQ: 'statement OR balance OR deposit OR transaction newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all recruiter / job emails (6mo)', mi: { tool: 'search', args: { query: 'role OR position OR opportunity OR recruiter OR hiring OR interview', limit: S } }, gmailQ: 'role OR position OR opportunity OR recruiter OR hiring newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all customer-support threads (6mo)', mi: { tool: 'search', args: { query: 'support OR ticket OR case OR enquiry OR help OR issue', limit: S } }, gmailQ: 'support OR ticket OR case OR enquiry OR issue newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all password-reset / security alerts (6mo)', mi: { tool: 'search', args: { query: 'security alert OR password OR verify OR login OR sign-in OR code', limit: S } }, gmailQ: '"security alert" OR password OR verify OR login OR "sign-in" newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all event invitations (6mo)', mi: { tool: 'search', args: { query: 'invited OR join us OR event OR webinar OR rsvp OR you are invited', limit: S } }, gmailQ: 'invited OR event OR webinar OR rsvp newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all subscription / recurring charges (6mo)', mi: { tool: 'search', args: { query: 'subscription OR renew OR auto-renew OR billed OR your plan OR membership', limit: S } }, gmailQ: 'subscription OR renew OR billed OR membership newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'everything about insurance (6mo)', mi: { tool: 'search', args: { query: 'insurance OR policy OR coverage OR claim OR premium', limit: S } }, gmailQ: 'insurance OR policy OR coverage OR claim newer_than:6m' },
  { cat: 'aggregate', kind: 'scan', label: 'all messages mentioning a contract (6mo)', mi: { tool: 'search', args: { query: 'contract OR agreement OR signature OR terms OR sign here', limit: S } }, gmailQ: 'contract OR agreement OR signature OR terms newer_than:6m' },

  // ---- B. Recall / find-one (generic real-world intents) ----
  { cat: 'recall', kind: 'recall', label: 'a payment / account deposit confirmation', mi: { tool: 'search', args: { query: 'deposit confirmation payment', limit: 5 } }, gmailQ: 'deposit OR "payment confirmation"' },
  { cat: 'recall', kind: 'recall', label: 'a security alert email', mi: { tool: 'search', args: { query: 'security alert', limit: 5 } }, gmailQ: '"security alert"' },
  { cat: 'recall', kind: 'recall', label: 'an event invitation', mi: { tool: 'search', args: { query: 'event invitation rsvp', limit: 5 } }, gmailQ: 'invitation OR rsvp OR event' },
  { cat: 'recall', kind: 'recall', label: 'a refund notification', mi: { tool: 'search', args: { query: 'refund order', limit: 5 } }, gmailQ: 'refund' },
  { cat: 'recall', kind: 'recall', label: 'a recruiter / job-opportunity message', mi: { tool: 'search', args: { query: 'role opportunity recruiter', limit: 5 } }, gmailQ: 'role OR recruiter OR opportunity' },
  { cat: 'recall', kind: 'recall', label: 'a recent order / dispatch confirmation', mi: { tool: 'search', args: { query: 'order dispatched confirmation', limit: 5 } }, gmailQ: 'order OR dispatched OR confirmation' },
  { cat: 'recall', kind: 'recall', label: 'an appointment / booking confirmation', mi: { tool: 'search', args: { query: 'appointment booking confirmed', limit: 5 } }, gmailQ: 'appointment OR booking OR confirmed' },
  { cat: 'recall', kind: 'recall', label: 'a news / market briefing', mi: { tool: 'search', args: { query: 'market economy briefing', limit: 5 } }, gmailQ: 'market OR economy OR briefing' },
  { cat: 'recall', kind: 'recall', label: 'a payment receipt', mi: { tool: 'search', args: { query: 'receipt payment', limit: 5 } }, gmailQ: 'receipt OR "payment to"' },
  { cat: 'recall', kind: 'recall', label: 'a login / verification-code notice', mi: { tool: 'search', args: { query: 'login verification code new device', limit: 5 } }, gmailQ: '"new device" OR "verification code" OR "login attempt"' },

  // ---- C. Read / relationship / "what did I miss" ----
  { cat: 'read', kind: 'read', label: 'read the single most relevant invoice', mi: { tool: 'read-top', args: { query: 'invoice amount due', limit: 1 } }, gmailQ: 'invoice OR "amount due"' },
  { cat: 'read', kind: 'read', label: 'read the latest order/shipping update', mi: { tool: 'read-top', args: { query: 'order shipped delivery', limit: 1 } }, gmailQ: 'order OR shipped OR delivery' },
  { cat: 'relational', kind: 'relational', label: 'who do I correspond with most (top contacts)', mi: { tool: 'list_contacts', args: { sort: 'engagement', limit: 25 } }, gmailQ: 'newer_than:6m' },
  { cat: 'relational', kind: 'relational', label: 'which companies do I have back-and-forth with', mi: { tool: 'list_contacts', args: { filter: 'correspondent', limit: 25 } }, gmailQ: 'newer_than:6m -category:promotions' },
  { cat: 'relational', kind: 'relational', label: 'catch me up on what I missed this week', mi: { tool: 'catch_up', args: { since: '7d' } }, gmailQ: 'newer_than:7d' },
];

const SCAN_SAMPLE = 8; // real gets sampled per scan to derive avg cost, then extrapolate

// ---- run ------------------------------------------------------------------

async function schemaTax(mcp) {
  const mi = await mcp.listTools();
  const miTools = mi.result.tools;
  const miTax = await countTokens(JSON.stringify(miTools));
  let gmailTax = null;
  let gmailCount = null;
  try {
    const g = JSON.parse(readFileSync(GMAIL_TOOLS_PATH, 'utf8'));
    const gTools = g.tools ?? g;
    gmailCount = gTools.length;
    gmailTax = await countTokens(JSON.stringify(gTools));
  } catch {
    /* no fixture — skip */
  }
  return { miCount: miTools.length, miTax, gmailCount, gmailTax };
}

async function runTask(mcp, t) {
  // ---- mail-index side: one (or two, for a read) compact calls ----
  let miText = '';
  let miCalls = 0;
  if (t.mi.tool === 'read-top') {
    const s = await mcp.call('search', t.mi.args);
    miCalls++;
    const stext = toolResultText(s);
    miText += stext;
    const ref = (JSON.parse(stext).hits ?? [])[0]?.ref;
    if (ref) {
      const m = await mcp.call('get_message', { ref, level: 'body' });
      miCalls++;
      miText += toolResultText(m);
    }
  } else {
    const r = await mcp.call(t.mi.tool, t.mi.args);
    miCalls++;
    miText = toolResultText(r);
  }
  const miTok = await countTokens(miText);
  const miHits = safeHitCount(miText);

  // ---- gmail side: real payloads ----
  let gmailTok;
  let gmailCalls;
  let note = '';

  if (t.kind === 'scan' || t.kind === 'relational') {
    // SCAN/RELATIONAL: to ANSWER, the agent must read EVERY match. Gmail list
    // returns ids only, so cost = list + get×(matchN). (For relational tasks —
    // top contacts, "what did I miss" — Gmail has no primitive, so it must scan
    // + aggregate the mailbox; same cost model.) We fetch a real sample for avg
    // get-cost, then extrapolate to the match count (metadata format — generous
    // to Gmail; full would be ~2.5× worse).
    const listRaw = await gmailList(t.gmailQ, 200);
    const ids = (JSON.parse(listRaw).messages ?? []).map((m) => m.id);
    const matchN = ids.length;
    const sampleIds = ids.slice(0, Math.min(SCAN_SAMPLE, matchN));
    let sampleTok = 0;
    for (const id of sampleIds) sampleTok += await countTokens(await gmailGet(id, 'metadata'));
    const avgGet = sampleIds.length ? sampleTok / sampleIds.length : 0;
    const listTok = await countTokens(listRaw);
    gmailTok = Math.round(listTok + avgGet * matchN);
    gmailCalls = 1 + matchN; // 1 list + one get per match
    note = `${matchN} matches × ~${Math.round(avgGet)} tok/get (sampled ${sampleIds.length}, extrapolated)`;
  } else {
    let gmailText = '';
    gmailCalls = 0;
    const listRaw = await gmailList(t.gmailQ, 10);
    gmailCalls++;
    gmailText += listRaw;
    const ids = (JSON.parse(listRaw).messages ?? []).map((m) => m.id);
    if (t.kind === 'read') {
      if (ids[0]) {
        gmailText += await gmailGet(ids[0], 'full');
        gmailCalls++;
      }
    } else {
      // recall: identify the answer among hits — top-3 metadata gets (generous).
      for (const id of ids.slice(0, 3)) {
        gmailText += await gmailGet(id, 'metadata');
        gmailCalls++;
      }
    }
    gmailTok = await countTokens(gmailText);
  }

  return { cat: t.cat, label: t.label, kind: t.kind, miCalls, miTok, miHits, gmailCalls, gmailTok, note };
}

function safeHitCount(text) {
  try {
    const o = JSON.parse(text);
    return (o.hits ?? o.matches ?? o.results ?? []).length || null;
  } catch {
    return null;
  }
}

function resolveConfigDir(account) {
  const cfgPath = join(
    process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config'),
    'mail-index',
    'config.json',
  );
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const a = cfg.accounts?.[account];
  if (!a) throw new Error(`account "${account}" not in ${cfgPath}`);
  return a.configDir.replace(/^~(?=$|\/)/, process.env.HOME);
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] == null ? true : argv[++i];
    }
  }
  return out;
}

async function main() {
  const mcp = mcpSession();
  await mcp.init();

  const tax = await schemaTax(mcp);
  const rows = [];
  for (const t of TASKS) rows.push(await runTask(mcp, t));
  mcp.close();

  const sumMi = rows.reduce((a, r) => a + r.miTok, 0);
  const sumGm = rows.reduce((a, r) => a + r.gmailTok, 0);
  const ratio = (g, m) => (m > 0 ? (g / m).toFixed(1) + '×' : '—');

  // Task labels are generic and token counts carry no message content, so the
  // table is COMMITTABLE (bench/RESULTS-USECASES.md). Grouped by category.
  const CATS = [
    ['aggregate', 'A. Aggregation — "list all …" (read every match)'],
    ['recall', 'B. Recall — find one message'],
    ['read', 'C. Read one message in full'],
    ['relational', 'D. Relational — contacts / "what did I miss" (no Gmail primitive)'],
  ];
  const lines = [];
  lines.push('# 30 common use cases — mail-index vs a stock Gmail-API MCP (token cost)');
  lines.push('');
  lines.push(`Tokens an agent's context pays to **answer** each question. Account \`${ACCOUNT}\` · token count: ${COUNT_MODE} · reproduce: \`node bench/run.mjs\`.`);
  lines.push('');
  lines.push('**Fixed schema tax** (every turn): mail-index ' + `${tax.miTax} tok (${tax.miCount} tools)` + (tax.gmailTax != null ? ` · stock Gmail MCP ${tax.gmailTax} tok (${tax.gmailCount} tools)` : '') + '.');
  lines.push('');
  for (const [cat, title] of CATS) {
    const group = rows.filter((r) => r.cat === cat);
    if (!group.length) continue;
    const gMi = group.reduce((a, r) => a + r.miTok, 0);
    const gGm = group.reduce((a, r) => a + r.gmailTok, 0);
    lines.push(`## ${title}`);
    lines.push('');
    lines.push('| Use case | mail-index (calls / tok) | Gmail MCP (calls / tok) | Savings |');
    lines.push('|---|--:|--:|--:|');
    for (const r of group)
      lines.push(`| ${r.label} | ${r.miCalls} / ${r.miTok.toLocaleString()} | ${r.gmailCalls} / ${r.gmailTok.toLocaleString()} | ${ratio(r.gmailTok, r.miTok)} |`);
    lines.push(`| **subtotal (${group.length})** | **${gMi.toLocaleString()}** | **${gGm.toLocaleString()}** | **${ratio(gGm, gMi)}** |`);
    lines.push('');
  }
  lines.push(`## Overall (${rows.length} use cases)`);
  lines.push('');
  lines.push('| | mail-index | Gmail MCP | Savings |');
  lines.push('|---|--:|--:|--:|');
  lines.push(`| total tokens to answer | **${sumMi.toLocaleString()}** | **${sumGm.toLocaleString()}** | **${ratio(sumGm, sumMi)}** |`);
  lines.push('');
  lines.push('> Gmail cost model (generous to Gmail): recall = list + top-3 metadata gets; read = 1 full get; aggregate/relational = list + one *metadata* get per match (sampled avg × match count; full payloads are ~2.5× heavier). Gmail `list` returns ids only, so every match must be fetched to be read. Relational tasks (top contacts, "what did I miss") have no Gmail primitive — the agent must scan + aggregate the mailbox; mail-index answers from precomputed structure in one compact call. Match counts cap at the Gmail API page size, so large aggregations are *under*-counted for Gmail.');
  writeFileSync(join(HERE, 'RESULTS-USECASES.md'), lines.join('\n') + '\n');

  // stdout summary
  console.log('\n=== 30 use cases — mail-index vs stock Gmail-API MCP (tokens to answer) ===');
  console.log(`token count: ${COUNT_MODE}`);
  console.log(`schema tax:   mail-index ${tax.miTax} tok (${tax.miCount} tools)` + (tax.gmailTax != null ? `  vs Gmail ${tax.gmailTax} tok (${tax.gmailCount} tools)` : ''));
  for (const [cat, title] of CATS) {
    const g = rows.filter((r) => r.cat === cat);
    if (!g.length) continue;
    const gMi = g.reduce((a, r) => a + r.miTok, 0);
    const gGm = g.reduce((a, r) => a + r.gmailTok, 0);
    console.log(`  ${title.split('—')[0].trim().padEnd(16)} (${g.length})  mail-index ${gMi.toLocaleString().padStart(7)} tok  vs Gmail ${gGm.toLocaleString().padStart(9)} tok  → ${ratio(gGm, gMi)}`);
  }
  console.log(`OVERALL (${rows.length}):  mail-index ${sumMi.toLocaleString()} tok  vs Gmail ${sumGm.toLocaleString()} tok  →  ${ratio(sumGm, sumMi)} less`);
  console.log('committable table → bench/RESULTS-USECASES.md');
}

main().catch((e) => {
  console.error('bench failed:', e.message);
  process.exit(1);
});
