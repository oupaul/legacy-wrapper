import * as cheerio from 'cheerio';
import { resolveFlags } from './rules.js';

/**
 * Build the list of <script> / <link> tags to prepend based on active flags.
 */
function buildTags(flags) {
  const tags = [];

  if (flags.ieShim) {
    tags.push('<script src="/inject/ie-shim.js"></script>');
  }
  if (flags.activexMock) {
    tags.push('<script src="/inject/activex-mock.js"></script>');
  }
  if (flags.compatCss) {
    tags.push('<link rel="stylesheet" href="/inject/compat.css">');
  }

  return tags.join('\n    ');
}

// ── VBScript → JavaScript transpiler ─────────────────────────────────────────
// Covers the common subset found in classic ASP pages:
//   Sub/Function, If/ElseIf/Else/End If, For/Next, For Each/Next,
//   While/Wend, Do While/Loop, Dim, Set, Select Case (basic),
//   Exit Sub/Function, True/False/Null/Nothing/Empty, & concat, msgbox.

/** Replace VBScript literal keywords with JS equivalents (word-boundary, case-insensitive). */
function vbLiterals(s) {
  return s
    .replace(/\bTrue\b/gi,    'true')
    .replace(/\bFalse\b/gi,   'false')
    .replace(/\bNull\b/gi,    'null')
    .replace(/\bNothing\b/gi, 'null')
    .replace(/\bEmpty\b/gi,   "''");
}

/** Convert a VBScript expression to JS (literals + string concat). */
function vbExpr(e) {
  let s = vbLiterals(e.trim());
  s = s.replace(/\s+&\s+/g, ' + ');   // VBScript & string concat → JS +
  return s;
}

/** Convert a VBScript condition to JS (operators + literals). */
function vbCondToJs(cond) {
  let c = vbExpr(cond);
  c = c.replace(/<>/g,         '!==');
  c = c.replace(/\bAnd\b/gi,   '&&');
  c = c.replace(/\bOr\b/gi,    '||');
  c = c.replace(/\bNot\b/gi,   '!');
  // VBScript = in conditions means equality → ===
  c = c.replace(/(?<![=!<>])=(?!=)/g, '===');
  return c;
}

function transpileVBScriptBlock(vbs) {
  // Resolve line continuations
  let src = vbs.replace(/[ \t]+_\r?\n[ \t]*/g, ' ');

  const lines    = src.split(/\r?\n/);
  const subNames = [];

  // First pass: collect Sub/Function names for event-attr fixup
  for (const line of lines) {
    const m = line.match(/^\s*(?:Sub|Function)\s+(\w+)/i);
    if (m) subNames.push(m[1]);
  }

  const out = [
    '/* transpiled from VBScript */',
    'function trim(s){return String(s).trim();}',
    '',
  ];

  let inSelectCase = false;   // rudimentary Select Case tracking

  for (const raw of lines) {
    let l = raw;

    // ── Comments ──────────────────────────────────────────────────────────────
    l = l.replace(/^(\s*)'(.*)$/, '$1//$2');

    // ── Sub / Function ────────────────────────────────────────────────────────
    const subM = l.match(/^(\s*)Sub\s+(\w+)\s*(?:\(([^)]*)\))?\s*(?:\/\/.*)?$/i);
    if (subM) {
      out.push(`${subM[1]}function ${subM[2]}(${subM[3] || ''}) {`);
      continue;
    }
    const fnM = l.match(/^(\s*)Function\s+(\w+)\s*(?:\(([^)]*)\))?\s*(?:\/\/.*)?$/i);
    if (fnM) {
      out.push(`${fnM[1]}function ${fnM[2]}(${fnM[3] || ''}) {`);
      continue;
    }

    // ── End Sub / End Function ────────────────────────────────────────────────
    if (/^\s*End\s+(Sub|Function)\s*(?:\/\/.*)?$/i.test(l)) {
      out.push(l.replace(/^(\s*)End\s+(Sub|Function)\s*(?:\/\/.*)?$/i, '$1}'));
      continue;
    }

    // ── Exit Sub / Exit Function → return ─────────────────────────────────────
    if (/^\s*Exit\s+(Sub|Function)\s*(?:\/\/.*)?$/i.test(l)) {
      out.push(l.replace(/^(\s*)Exit\s+(Sub|Function)\s*(?:\/\/.*)?$/i, '$1return;'));
      continue;
    }

    // ── Select Case → switch ──────────────────────────────────────────────────
    const selM = l.match(/^(\s*)Select\s+Case\s+(.+?)\s*(?:\/\/.*)?$/i);
    if (selM) {
      out.push(`${selM[1]}switch (${vbExpr(selM[2])}) {`);
      inSelectCase = true;
      continue;
    }
    if (inSelectCase) {
      const caseM = l.match(/^(\s*)Case\s+Else\s*(?:\/\/.*)?$/i);
      if (caseM) { out.push(`${caseM[1]}default:`); continue; }
      const caseVals = l.match(/^(\s*)Case\s+(.+?)\s*(?:\/\/.*)?$/i);
      if (caseVals) {
        const cases = caseVals[2].split(',').map(v => `case ${vbExpr(v.trim())}:`).join(' ');
        out.push(`${caseVals[1]}${cases}`);
        continue;
      }
      if (/^\s*End\s+Select\s*(?:\/\/.*)?$/i.test(l)) {
        out.push(l.replace(/^(\s*)End\s+Select\s*(?:\/\/.*)?$/i, '$1}'));
        inSelectCase = false;
        continue;
      }
    }

    // ── ElseIf ────────────────────────────────────────────────────────────────
    const elseifM = l.match(/^(\s*)ElseIf\s+(.*?)\s+Then\s*(?:\/\/.*)?$/i);
    if (elseifM) {
      out.push(`${elseifM[1]}} else if (${vbCondToJs(elseifM[2])}) {`);
      continue;
    }

    // ── If … Then (block vs single-line) ──────────────────────────────────────
    const ifLineM = l.match(/^(\s*)If\s+(.*?)\s+Then(.*?)(?:'.*)?$/i);
    if (ifLineM) {
      const afterThen = ifLineM[3].trim().replace(/\/\/.*$/, '').trim();
      if (afterThen) {
        // Single-line:  If cond Then stmt [Else stmt2]
        const elseIdx = afterThen.search(/\bElse\b/i);
        if (elseIdx >= 0) {
          const thenStmt = vbExpr(afterThen.slice(0, elseIdx).trim());
          const elseStmt = vbExpr(afterThen.slice(elseIdx + 4).trim());
          out.push(`${ifLineM[1]}if (${vbCondToJs(ifLineM[2])}) { ${thenStmt}; } else { ${elseStmt}; }`);
        } else {
          out.push(`${ifLineM[1]}if (${vbCondToJs(ifLineM[2])}) { ${vbExpr(afterThen)}; }`);
        }
      } else {
        // Block If
        out.push(`${ifLineM[1]}if (${vbCondToJs(ifLineM[2])}) {`);
      }
      continue;
    }

    // ── Else / End If ─────────────────────────────────────────────────────────
    if (/^\s*Else\s*(?:\/\/.*)?$/i.test(l)) {
      out.push(l.replace(/^(\s*)Else\s*(?:\/\/.*)?$/i, '$1} else {'));
      continue;
    }
    if (/^\s*End\s+If\s*(?:\/\/.*)?$/i.test(l)) {
      out.push(l.replace(/^(\s*)End\s+If\s*(?:\/\/.*)?$/i, '$1}'));
      continue;
    }

    // ── For i = start To end [Step n] ─────────────────────────────────────────
    const forM = l.match(/^(\s*)For\s+(\w+)\s*=\s*(.+?)\s+To\s+(.+?)(?:\s+Step\s+(.+?))?\s*(?:\/\/.*)?$/i);
    if (forM) {
      const [, ind, iv, start, end, step] = forM;
      const sv  = step ? vbExpr(step) : '1';
      const op  = (step && step.trim().startsWith('-')) ? '>=' : '<=';
      out.push(`${ind}for (var ${iv} = ${vbExpr(start)}; ${iv} ${op} ${vbExpr(end)}; ${iv} += ${sv}) {`);
      continue;
    }

    // ── For Each x In coll ────────────────────────────────────────────────────
    const forEachM = l.match(/^(\s*)For\s+Each\s+(\w+)\s+In\s+(.+?)\s*(?:\/\/.*)?$/i);
    if (forEachM) {
      out.push(`${forEachM[1]}var _fe_ = Array.from(${vbExpr(forEachM[3])} || []); for (var _fi_ = 0; _fi_ < _fe_.length; _fi_++) { var ${forEachM[2]} = _fe_[_fi_];`);
      continue;
    }

    // ── Next ──────────────────────────────────────────────────────────────────
    if (/^\s*Next\b/i.test(l)) {
      out.push(l.replace(/^(\s*)Next\b.*/i, '$1}'));
      continue;
    }

    // ── While / Wend ──────────────────────────────────────────────────────────
    const whileM = l.match(/^(\s*)While\s+(.*?)\s*(?:\/\/.*)?$/i);
    if (whileM) {
      out.push(`${whileM[1]}while (${vbCondToJs(whileM[2])}) {`);
      continue;
    }
    if (/^\s*Wend\s*(?:\/\/.*)?$/i.test(l)) {
      out.push(l.replace(/^(\s*)Wend\s*(?:\/\/.*)?$/i, '$1}'));
      continue;
    }

    // ── Do While / Do Until / Do / Loop ──────────────────────────────────────
    const doWhileM = l.match(/^(\s*)Do\s+While\s+(.*?)\s*(?:\/\/.*)?$/i);
    if (doWhileM) { out.push(`${doWhileM[1]}while (${vbCondToJs(doWhileM[2])}) {`); continue; }
    const doUntilM = l.match(/^(\s*)Do\s+Until\s+(.*?)\s*(?:\/\/.*)?$/i);
    if (doUntilM) { out.push(`${doUntilM[1]}while (!(${vbCondToJs(doUntilM[2])})) {`); continue; }
    if (/^\s*Do\s*(?:\/\/.*)?$/i.test(l)) { out.push(l.replace(/^(\s*)Do\s*(?:\/\/.*)?$/i, '$1do {')); continue; }
    if (/^\s*Loop\b/i.test(l)) { out.push(l.replace(/^(\s*)Loop\b.*/i, '$1}')); continue; }

    // ── Dim / ReDim → var ─────────────────────────────────────────────────────
    const dimM = l.match(/^(\s*)(?:Re)?Dim\s+(?:Preserve\s+)?(.+?)\s*(?:\/\/.*)?$/i);
    if (dimM) {
      out.push(`${dimM[1]}var ${dimM[2]};`);
      continue;
    }

    // ── Set obj = expr → obj = expr ───────────────────────────────────────────
    l = l.replace(/^(\s*)Set\s+/i, '$1');

    // ── Call func(args) → func(args) ─────────────────────────────────────────
    l = l.replace(/^(\s*)Call\s+/i, '$1');

    // ── msgbox expr → alert(expr) ─────────────────────────────────────────────
    l = l.replace(/\bmsgbox\s+(.+)$/gi, (_, expr) => `alert(${expr.trim()})`);

    // ── Statement-level literal + concat normalization ────────────────────────
    l = vbLiterals(l);
    l = l.replace(/\s+&\s+/g, ' + ');

    out.push(l);
  }

  return { js: out.join('\n'), subNames };
}

// ── Main injection entry point ────────────────────────────────────────────────

/**
 * Parse `html`, inject shim tags into <head>, transpile VBScript to JS,
 * and return the modified HTML string.
 *
 * @param {string} html
 * @param {string|object} pathnameOrReq — path string OR full Express req object
 */
export function buildInjectedHtml(html, pathnameOrReq = '/') {
  const req   = typeof pathnameOrReq === 'string'
    ? { path: pathnameOrReq, url: pathnameOrReq, method: 'GET', headers: {} }
    : pathnameOrReq;
  const flags = resolveFlags(req);
  const tags  = buildTags(flags);

  const $ = cheerio.load(html, { decodeEntities: false });

  // ── Step 1: Transpile VBScript blocks ──────────────────────────────────────
  const allSubNames = [];
  const formNames   = [];

  $('form[name]').each((_, el) => {
    const name = $(el).attr('name');
    if (name && /^\w+$/.test(name)) formNames.push(name);
  });

  $('script').each((_, el) => {
    const lang = ($(el).attr('language') || '').toLowerCase();
    const type = ($(el).attr('type')     || '').toLowerCase();
    if (lang === 'vbscript' || type === 'text/vbscript') {
      const raw = $(el).html() || '';
      // Strip HTML comment wrappers <!-- ... -->  (IE trick to hide scripts)
      const vbs = raw.replace(/^[\s\S]*?<!--/, '').replace(/-->[\s\S]*$/, '');
      const { js, subNames } = transpileVBScriptBlock(vbs);
      allSubNames.push(...subNames);
      $(el).removeAttr('language');
      $(el).removeAttr('type');
      $(el).html(js);
      console.info('[inject] VBScript transpiled — subs:', subNames.join(', '));
    }
  });

  // Inject form-name aliases as global vars so transpiled code can use bare names.
  // Placed at end of <body> so DOM is ready when the script runs.
  if (allSubNames.length > 0 && formNames.length > 0) {
    const aliases = formNames
      .map(n => `var ${n} = document.forms['${n}'];`)
      .join('\n');
    $('body').append(`\n<script>\n${aliases}\n</script>`);
  }

  // ── Step 2: Fix onclick="SubName" → onclick="SubName()" ───────────────────
  // VBScript event attrs reference Sub names without parentheses;
  // in JS that evaluates the function object without calling it.
  if (allSubNames.length > 0) {
    const subSet = new Set(allSubNames);
    const evAttrs = [
      'onclick','onchange','onsubmit','onload','onfocus','onblur',
      'onkeydown','onkeyup','onkeypress','onmousedown','onmouseup','ondblclick',
    ];
    $('*').each((_, el) => {
      for (const attr of evAttrs) {
        const val = $(el).attr(attr);
        if (val && subSet.has(val.trim())) {
          $(el).attr(attr, `${val.trim()}()`);
        }
      }
    });
  }

  // ── Step 3: Inject shim <script>/<link> tags into <head> ──────────────────
  if (tags) {
    if ($('head').length) {
      $('head').prepend('\n    ' + tags + '\n  ');
    } else {
      const firstScript = $('script').first();
      if (firstScript.length) {
        firstScript.before(tags);
      } else {
        $('body').prepend(tags);
      }
    }
  }

  return $.html();
}
