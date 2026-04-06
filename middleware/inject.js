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
// Handles the common subset found in classic ASP form pages:
//   Sub/End Sub, If/ElseIf/Else/End If, msgbox, trim(), basic operators.

function vbCondToJs(cond) {
  let c = cond.trim();
  // String inequality
  c = c.replace(/<>/g, '!==');
  // Boolean operators
  c = c.replace(/\bAnd\b/gi, '&&');
  c = c.replace(/\bOr\b/gi,  '||');
  c = c.replace(/\bNot\b/gi, '!');
  // VBScript = is equality in conditions (not assignment) → ===
  // Guard: don't replace =< >= == !=
  c = c.replace(/(?<![=!<>])=(?!=)/g, '===');
  return c;
}

function transpileVBScriptBlock(vbs) {
  // Resolve line continuations first
  let src = vbs.replace(/[ \t]+_\r?\n[ \t]*/g, ' ');

  const lines    = src.split(/\r?\n/);
  const subNames = [];

  // First pass: collect Sub names (needed for event-attribute fixup)
  for (const line of lines) {
    const m = line.match(/^\s*Sub\s+(\w+)/i);
    if (m) subNames.push(m[1]);
  }

  // Helpers injected at the top of the transpiled block
  const out = [
    '/* transpiled from VBScript */',
    'function trim(s){return String(s).trim();}',
    '',
  ];

  for (const raw of lines) {
    let l = raw;

    // VBScript comment  ' text → // text
    l = l.replace(/^(\s*)'(.*)$/, '$1//$2');

    // Sub Name / Sub Name() → function Name() {
    const subM = l.match(/^(\s*)Sub\s+(\w+)\s*(?:\([^)]*\))?\s*(?:\/\/.*)?$/i);
    if (subM) {
      out.push(`${subM[1]}function ${subM[2]}() {`);
      continue;
    }

    // End Sub → }
    if (/^\s*End\s+Sub\s*(?:\/\/.*)?$/i.test(l)) {
      out.push(l.replace(/^(\s*)End\s+Sub\s*(?:\/\/.*)?$/i, '$1}'));
      continue;
    }

    // ElseIf condition Then → } else if (condition) {
    const elseifM = l.match(/^(\s*)ElseIf\s+(.*?)\s+Then\s*(?:\/\/.*)?$/i);
    if (elseifM) {
      out.push(`${elseifM[1]}} else if (${vbCondToJs(elseifM[2])}) {`);
      continue;
    }

    // If condition Then → if (condition) {
    const ifM = l.match(/^(\s*)If\s+(.*?)\s+Then\s*(?:\/\/.*)?$/i);
    if (ifM) {
      out.push(`${ifM[1]}if (${vbCondToJs(ifM[2])}) {`);
      continue;
    }

    // Else → } else {
    if (/^\s*Else\s*(?:\/\/.*)?$/i.test(l)) {
      out.push(l.replace(/^(\s*)Else\s*(?:\/\/.*)?$/i, '$1} else {'));
      continue;
    }

    // End If → }
    if (/^\s*End\s+If\s*(?:\/\/.*)?$/i.test(l)) {
      out.push(l.replace(/^(\s*)End\s+If\s*(?:\/\/.*)?$/i, '$1}'));
      continue;
    }

    // msgbox expr  →  alert(expr)
    l = l.replace(/\bmsgbox\s+(.+)$/gi, (_, expr) => `alert(${expr.trim()})`);

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
