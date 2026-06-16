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

const TASKS = [
  // RECALL — find one message (Gmail: list + a few metadata gets to identify it).
  { kind: 'recall', label: 'recall: an invite or event', mi: { tool: 'search', args: { query: 'invite event', limit: 5 } }, gmailQ: 'invite OR event' },
  { kind: 'recall', label: 'recall: a refund / payment', mi: { tool: 'search', args: { query: 'refund payment receipt', limit: 5 } }, gmailQ: 'refund OR receipt OR payment' },
  { kind: 'recall', label: 'recall: a security/login alert', mi: { tool: 'search', args: { query: 'login security alert', limit: 5 } }, gmailQ: 'security alert OR login' },
  // READ — put one full message in context (Gmail: messages.get format=full).
  { kind: 'read', label: 'read the single most relevant message', mi: { tool: 'read-top', args: { query: 'invite event', limit: 1 } }, gmailQ: 'invite OR event' },
  // SCAN — answer an AGGREGATION over many messages. Gmail must fetch EVERY match
  // to read it; mail-index returns the whole compact set in one ranked call.
  { kind: 'scan', label: 'scan: all purchases / receipts (6mo)', mi: { tool: 'search', args: { query: 'receipt OR order OR invoice OR payment OR purchase OR dispatched OR refund', limit: 200 } }, gmailQ: 'receipt OR order OR invoice OR payment OR purchase OR dispatched OR refund newer_than:6m' },
  { kind: 'scan', label: 'scan: every newsletter / digest (6mo)', mi: { tool: 'search', args: { query: 'newsletter OR digest OR weekly OR briefing OR unsubscribe', limit: 200 } }, gmailQ: 'unsubscribe OR newsletter OR digest newer_than:6m' },
  { kind: 'scan', label: 'scan: all meetings / calendar invites (6mo)', mi: { tool: 'search', args: { query: 'invite OR meeting OR calendar OR scheduled OR rsvp', limit: 200 } }, gmailQ: 'invite OR meeting OR calendar OR rsvp newer_than:6m' },
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

  if (t.kind === 'scan') {
    // SCAN: to ANSWER the aggregation the agent must read EVERY match. Gmail
    // list returns ids only, so cost = list + get×(matchN). We fetch a real
    // sample to get avg get-cost, then extrapolate to the true match count
    // (metadata format — generous to Gmail; full would be ~2.5× worse).
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

  return { label: t.label, kind: t.kind, miCalls, miTok, miHits, gmailCalls, gmailTok, note };
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

  // full table (may contain real-data-derived token counts; safe) → file
  const lines = [];
  lines.push('# mail-index vs stock Gmail-API MCP — token benchmark (operator-local)');
  lines.push('');
  lines.push(`Account: \`${ACCOUNT}\` · token count: ${COUNT_MODE}`);
  lines.push('');
  lines.push('## Fixed schema tax (injected every turn)');
  lines.push('');
  lines.push('| Server | Tools | Schema tokens |');
  lines.push('|---|--:|--:|');
  lines.push(`| mail-index | ${tax.miCount} | ${tax.miTax} |`);
  if (tax.gmailTax != null)
    lines.push(`| stock Gmail MCP (fixture) | ${tax.gmailCount} | ${tax.gmailTax} |`);
  lines.push('');
  lines.push('## Per-task result tax (tokens returned to answer the question)');
  lines.push('');
  lines.push('| Task | mail-index (calls / tokens) | Gmail API (calls / tokens) | Savings |');
  lines.push('|---|--:|--:|--:|');
  for (const r of rows)
    lines.push(
      `| ${r.label} | ${r.miCalls} / ${r.miTok} | ${r.gmailCalls} / ${r.gmailTok} | ${ratio(r.gmailTok, r.miTok)} |`,
    );
  lines.push(`| **TOTAL** | **${sumMi}** | **${sumGm}** | **${ratio(sumGm, sumMi)}** |`);
  lines.push('');
  const scanNotes = rows.filter((r) => r.kind === 'scan' && r.note);
  if (scanNotes.length) {
    lines.push('Scan-task Gmail cost detail (linear in matches):');
    for (const r of scanNotes) lines.push(`- ${r.label}: ${r.note}`);
    lines.push('');
  }
  lines.push(
    '> Gmail model: recall = list + top-3 metadata gets; read = 1 full get; ' +
      'scan = list + one metadata get per MATCH (sampled avg × match count). ' +
      'All generous to Gmail (metadata not full; real agents also guess queries and fetch more).',
  );
  const outPath = join(HERE, 'results.local.md');
  writeFileSync(outPath, lines.join('\n') + '\n');

  // safe aggregate summary → stdout
  console.log('\n=== mail-index vs stock Gmail-API MCP — token benchmark ===');
  console.log(`token count: ${COUNT_MODE}`);
  console.log(
    `schema tax:   mail-index ${tax.miTax} tok (${tax.miCount} tools)` +
      (tax.gmailTax != null ? `  vs Gmail ${tax.gmailTax} tok (${tax.gmailCount} tools)` : ''),
  );
  console.log(`per-task tax: mail-index ${sumMi} tok  vs Gmail ${sumGm} tok  →  ${ratio(sumGm, sumMi)} less`);
  for (const r of rows.filter((x) => x.kind === 'scan')) {
    console.log(
      `  scan "${r.label.replace(/^scan: /, '')}": mail-index ${r.miTok} tok (1 call, ${r.miHits ?? '?'} hits)` +
        `  vs Gmail ${r.gmailTok} tok (${r.gmailCalls} calls) → ${ratio(r.gmailTok, r.miTok)} less`,
    );
  }
  console.log(`full table → ${outPath} (gitignored; may name real senders)`);
}

main().catch((e) => {
  console.error('bench failed:', e.message);
  process.exit(1);
});
