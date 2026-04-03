#!/usr/bin/env node
/**
 * diagnose.js — Legacy URL IE-compatibility analyser
 *
 * Usage:
 *   node tools/diagnose.js <url> [options]
 *
 * Options:
 *   --user <user>         HTTP Basic username
 *   --pass <pass>         HTTP Basic password
 *   --header <k:v>        Extra request header (repeatable)
 *   --no-tls-verify       Accept self-signed upstream TLS certs
 *   --json                Output raw JSON instead of human-readable report
 *   --rules               Show which config rules match this URL
 *
 * Examples:
 *   node tools/diagnose.js http://legacy.local/app/index.asp
 *   node tools/diagnose.js https://legacy.local/ --no-tls-verify --json
 */

import http  from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { explainRules } from '../middleware/rules.js';

// ── CLI arg parsing ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (!args.length || args[0] === '--help' || args[0] === '-h') {
  console.log(
    'Usage: node tools/diagnose.js <url> [--user u --pass p] [--header k:v] [--no-tls-verify] [--json] [--rules]'
  );
  process.exit(0);
}

const targetRaw   = args[0];
const flags       = {
  user:         argVal('--user'),
  pass:         argVal('--pass'),
  headers:      argMulti('--header'),
  noTlsVerify:  args.includes('--no-tls-verify'),
  json:         args.includes('--json'),
  showRules:    args.includes('--rules'),
};

function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
function argMulti(flag) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) result.push(args[++i]);
  }
  return result;
}

// ── HTTP fetch ────────────────────────────────────────────────────────────────

async function fetchPage(rawUrl) {
  const url = new URL(rawUrl);

  const reqHeaders = {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,*/*',
  };

  for (const kv of flags.headers) {
    const colon = kv.indexOf(':');
    if (colon > 0) {
      reqHeaders[kv.slice(0, colon).trim().toLowerCase()] = kv.slice(colon + 1).trim();
    }
  }

  if (flags.user && flags.pass) {
    const token = Buffer.from(`${flags.user}:${flags.pass}`).toString('base64');
    reqHeaders['authorization'] = `Basic ${token}`;
  }

  const mod = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  reqHeaders,
    };
    if (flags.noTlsVerify) options.rejectUnauthorized = false;

    const req = mod.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Detection patterns ────────────────────────────────────────────────────────

const PATTERNS = [
  // ── IE DOM / event model ──────────────────────────────────────────────────
  { id: 'document.all',       sev: 'error',   shim: 'ieShim',      re: /\bdocument\.all\b/,                 label: 'document.all' },
  { id: 'attachEvent',        sev: 'error',   shim: 'ieShim',      re: /\battachEvent\s*\(/,                label: 'attachEvent()' },
  { id: 'detachEvent',        sev: 'error',   shim: 'ieShim',      re: /\bdetachEvent\s*\(/,                label: 'detachEvent()' },
  { id: 'srcElement',         sev: 'warning', shim: 'ieShim',      re: /\bevent\.srcElement\b/,             label: 'event.srcElement' },
  { id: 'returnValue',        sev: 'warning', shim: 'ieShim',      re: /\bevent\.returnValue\b/,            label: 'event.returnValue' },
  { id: 'cancelBubble',       sev: 'warning', shim: 'ieShim',      re: /\bevent\.cancelBubble\b/,           label: 'event.cancelBubble' },
  { id: 'createEventObject',  sev: 'warning', shim: 'ieShim',      re: /\bdocument\.createEventObject\b/,  label: 'document.createEventObject()' },
  { id: 'fireEvent',          sev: 'warning', shim: 'ieShim',      re: /\b\.fireEvent\s*\(/,                label: '.fireEvent()' },
  { id: 'document.selection', sev: 'warning', shim: 'ieShim',      re: /\bdocument\.selection\b/,          label: 'document.selection' },

  // ── ActiveX / COM ─────────────────────────────────────────────────────────
  { id: 'ActiveXObject',      sev: 'error',   shim: 'activexMock', re: /\bnew\s+ActiveXObject\s*\(/,        label: 'new ActiveXObject()' },
  { id: 'window.external',    sev: 'warning', shim: 'activexMock', re: /\bwindow\.external\b/,              label: 'window.external' },
  { id: 'window.clipboardData', sev: 'warning', shim: 'activexMock', re: /\bwindow\.clipboardData\b/,      label: 'window.clipboardData' },
  { id: 'CollectGarbage',     sev: 'warning', shim: 'activexMock', re: /\bCollectGarbage\s*\(/,            label: 'CollectGarbage()' },
  { id: 'execScript',         sev: 'warning', shim: 'activexMock', re: /\bexecScript\s*\(/,                label: 'execScript()' },

  // ── IE-only dialogs ───────────────────────────────────────────────────────
  { id: 'showModalDialog',    sev: 'error',   shim: null,          re: /\bshowModalDialog\s*\(/,            label: 'showModalDialog() — not polyfillable' },
  { id: 'showModelessDialog', sev: 'error',   shim: null,          re: /\bshowModelessDialog\s*\(/,         label: 'showModelessDialog() — not polyfillable' },
  { id: 'createPopup',        sev: 'error',   shim: null,          re: /\bcreatePopup\s*\(/,                label: 'createPopup() — not polyfillable' },

  // ── VBScript ──────────────────────────────────────────────────────────────
  { id: 'vbscript-block',     sev: 'critical', shim: null,         re: /language\s*=\s*["']vbscript["']/i, label: 'VBScript block — cannot be emulated' },
  { id: 'vbscript-href',      sev: 'critical', shim: null,         re: /href\s*=\s*["']vbscript:/i,        label: 'VBScript href — cannot be emulated' },

  // ── IE conditional comments ───────────────────────────────────────────────
  { id: 'ie-conditional',     sev: 'info',    shim: null,          re: /<!--\[if\s+(?:lt\s+)?IE\s*/i,      label: 'IE conditional comment' },
  { id: 'ie-conditional-not', sev: 'info',    shim: null,          re: /<!--\[if\s+!IE\s*/i,               label: 'IE conditional comment (!IE)' },

  // ── Deprecated/removed APIs ───────────────────────────────────────────────
  { id: 'document.all.tags',  sev: 'error',   shim: 'ieShim',      re: /\bdocument\.all\.tags\s*\(/,       label: 'document.all.tags()' },
  { id: 'runtimeStyle',       sev: 'warning', shim: null,          re: /\bruntimeStyle\b/,                 label: 'element.runtimeStyle' },
  { id: 'currentStyle',       sev: 'warning', shim: null,          re: /\bcurrentStyle\b/,                 label: 'element.currentStyle' },
];

const SEVERITY_ORDER = { critical: 0, error: 1, warning: 2, info: 3 };

// ── Header checks ─────────────────────────────────────────────────────────────

function checkHeaders(headers, targetUrl) {
  const findings = [];

  if (!headers['x-ua-compatible']) {
    findings.push({
      id: 'missing-x-ua-compatible', sev: 'warning',
      label: 'X-UA-Compatible header missing — add "IE=edge" or proxy can inject it',
    });
  }

  const csp = headers['content-security-policy'];
  if (csp) {
    if (/script-src[^;]*'unsafe-inline'/i.test(csp) === false) {
      findings.push({
        id: 'csp-blocks-inline', sev: 'warning',
        label: `CSP may block injected inline scripts: ${csp.slice(0, 100)}`,
      });
    }
  }

  const isHttps = targetUrl.protocol === 'https:';
  if (isHttps && headers['strict-transport-security']) {
    findings.push({ id: 'hsts', sev: 'info', label: 'HSTS present — ensure all assets are served over HTTPS' });
  }

  const frameOptions = headers['x-frame-options'];
  if (frameOptions) {
    findings.push({ id: 'x-frame-options', sev: 'info', label: `X-Frame-Options: ${frameOptions} — may affect legacy iframe usage` });
  }

  return findings;
}

// ── HTML scanner ──────────────────────────────────────────────────────────────

function scanHtml(html, targetUrl) {
  const lines   = html.split('\n');
  const results = [];

  for (const pat of PATTERNS) {
    const matchLines = [];
    for (let i = 0; i < lines.length; i++) {
      if (pat.re.test(lines[i])) matchLines.push(i + 1);
    }
    if (matchLines.length > 0) {
      results.push({ ...pat, lines: matchLines });
    }
  }

  // Mixed content check (http:// resource on https page)
  if (targetUrl.protocol === 'https:') {
    const mixedRe = /(?:src|href|action)\s*=\s*["']http:\/\//gi;
    const mixedLines = [];
    for (let i = 0; i < lines.length; i++) {
      if (mixedRe.test(lines[i])) mixedLines.push(i + 1);
      mixedRe.lastIndex = 0;
    }
    if (mixedLines.length > 0) {
      results.push({ id: 'mixed-content', sev: 'error', shim: null, label: 'Mixed content (http:// on HTTPS page)', lines: mixedLines });
    }
  }

  return results.sort((a, b) => (SEVERITY_ORDER[a.sev] ?? 9) - (SEVERITY_ORDER[b.sev] ?? 9));
}

// ── Recommendation builder ────────────────────────────────────────────────────

function buildRecommendations(htmlFindings, headerFindings) {
  const needed = new Set();
  const warnings = [];

  for (const f of [...htmlFindings, ...headerFindings]) {
    if (f.shim)  needed.add(f.shim);
    if (f.sev === 'critical') warnings.push(f.label);
  }

  return { enableShims: [...needed], criticalWarnings: warnings };
}

// ── Output formatters ─────────────────────────────────────────────────────────

const SEV_ICON = { critical: '🔴', error: '🔴', warning: '🟡', info: '🔵' };

function printReport(url, statusCode, headers, htmlFindings, headerFindings, ruleExplanation) {
  const rec = buildRecommendations(htmlFindings, headerFindings);

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(` Legacy Compatibility Report`);
  console.log(`  URL   : ${url}`);
  console.log(`  Status: ${statusCode}`);
  console.log('══════════════════════════════════════════════════════════\n');

  // ── Response header checks
  console.log('── Response Header Checks ─────────────────────────────────');
  if (headerFindings.length === 0) {
    console.log('  ✅  No header issues detected.');
  } else {
    for (const f of headerFindings) {
      console.log(`  ${SEV_ICON[f.sev] ?? '⚪'}  [${f.sev.toUpperCase()}] ${f.label}`);
    }
  }

  // ── HTML analysis
  console.log('\n── HTML / JavaScript Analysis ─────────────────────────────');
  if (htmlFindings.length === 0) {
    console.log('  ✅  No IE-specific patterns detected.');
  } else {
    for (const f of htmlFindings) {
      const lineStr = f.lines.length <= 5
        ? `line${f.lines.length > 1 ? 's' : ''} ${f.lines.join(', ')}`
        : `${f.lines.length} occurrences (first: line ${f.lines[0]})`;
      const shimStr = f.shim ? `  →  enable ${f.shim}` : '';
      console.log(`  ${SEV_ICON[f.sev] ?? '⚪'}  [${f.sev.toUpperCase()}] ${f.label}  (${lineStr})${shimStr}`);
    }
  }

  // ── Recommendations
  console.log('\n── Recommendations ────────────────────────────────────────');
  if (rec.enableShims.length > 0) {
    console.log(`  Enable in config.js: ${rec.enableShims.join(', ')}`);
  } else {
    console.log('  No shims required.');
  }
  if (rec.criticalWarnings.length > 0) {
    console.log('\n  ⚠️  Critical (not automatable):');
    for (const w of rec.criticalWarnings) console.log(`    - ${w}`);
  }

  // ── Rule explanation
  if (ruleExplanation) {
    console.log('\n── Config Rule Matching ────────────────────────────────────');
    if (ruleExplanation.length === 0) {
      console.log('  (no rules configured)');
    } else {
      for (const r of ruleExplanation) {
        const icon = r.matched ? '✅' : '⬜';
        console.log(`  ${icon}  ${r.label}  →  ${JSON.stringify(r.overrides)}`);
      }
    }
  }

  console.log('\n══════════════════════════════════════════════════════════\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  let url;
  try {
    url = new URL(targetRaw);
  } catch {
    console.error(`Invalid URL: ${targetRaw}`);
    process.exit(1);
  }

  let result;
  try {
    result = await fetchPage(url.href);
  } catch (err) {
    console.error(`Failed to fetch ${url.href}: ${err.message}`);
    process.exit(1);
  }

  const { status, headers, body } = result;
  const htmlFindings   = scanHtml(body, url);
  const headerFindings = checkHeaders(headers, url);

  let ruleExplanation = null;
  if (flags.showRules) {
    ruleExplanation = explainRules({
      path:    url.pathname,
      url:     url.pathname + url.search,
      method:  'GET',
      headers: {},
    });
  }

  if (flags.json) {
    console.log(JSON.stringify({
      url:      url.href,
      status,
      headers:  headerFindings,
      html:     htmlFindings,
      rules:    ruleExplanation,
      recommendations: buildRecommendations(htmlFindings, headerFindings),
    }, null, 2));
  } else {
    printReport(url.href, status, headers, htmlFindings, headerFindings, ruleExplanation);
  }
}

main();
