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

  const lines     = src.split(/\r?\n/);
  const subNames  = [];
  const arrayNames = [];

  // First pass: collect Sub/Function names and array names
  for (const line of lines) {
    const sm = line.match(/^\s*(?:Sub|Function)\s+(\w+)/i);
    if (sm) subNames.push(sm[1]);
    // Dim varName(n) or Dim varName(n, m) → array
    const dm = line.match(/^\s*(?:Re)?Dim\s+(?:Preserve\s+)?(\w+)\s*\(/i);
    if (dm) arrayNames.push(dm[1]);
  }

  // ── VBScript built-in functions available to transpiled code ────────────────
  const VB_RUNTIME = [
    '/* VBScript runtime shims */',
    'function trim(s){return String(s).trim();}',
    'function Trim(s){return String(s).trim();}',
    'function LTrim(s){return String(s).replace(/^\\s+/,"");}',
    'function RTrim(s){return String(s).replace(/\\s+$/,"");}',
    'function Left(s,n){return String(s).substring(0,n);}',
    'function Right(s,n){s=String(s);return s.substring(s.length-n);}',
    'function Mid(s,st,ln){s=String(s);return ln===undefined?s.substring(st-1):s.substring(st-1,st-1+ln);}',
    'function Len(s){return s==null?"":String(s).length;}',
    'function UCase(s){return String(s).toUpperCase();}',
    'function LCase(s){return String(s).toLowerCase();}',
    'function InStr(a,b){return typeof a==="number"?String(arguments[1]).indexOf(arguments[2])+1:String(a).indexOf(b)+1;}',
    'function InStrRev(s,f){return String(s).lastIndexOf(f)+1;}',
    'function Replace(s,f,r){return String(s).split(f).join(r);}',
    'function Split(s,d,n){var r=String(s).split(d===undefined?",":d);return n>0?r.slice(0,n):r;}',
    'function Join(a,d){return (a||[]).join(d===undefined?",":d);}',
    'function UBound(a,d){if(!Array.isArray(a)||!a.length)return -1;return(!d||d===1)?a.length-1:(Array.isArray(a[0])?a[0].length-1:-1);}',
    'function LBound(){return 0;}',
    'function IsArray(a){return Array.isArray(a);}',
    'function IsNull(a){return a===null||a===undefined;}',
    'function IsEmpty(a){return a===undefined||a===null||a==="";}',
    'function IsNumeric(a){return !isNaN(parseFloat(a))&&isFinite(a);}',
    'function CStr(a){return a==null?"":String(a);}',
    'function CInt(a){return parseInt(a)||0;}',
    'function CLng(a){return parseInt(a)||0;}',
    'function CDbl(a){return parseFloat(a)||0;}',
    'function CBool(a){return!!a;}',
    'function Abs(n){return Math.abs(n);}',
    'function Int(n){return Math.floor(n);}',
    'function Rnd(){return Math.random();}',
    'function MsgBox(m){alert(m);}',
    'function msgbox(m){alert(m);}',
    '',
  ];

  const out = ['/* transpiled from VBScript */', ...VB_RUNTIME];

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

    // ── Dim / ReDim → var (with array dimension support) ─────────────────────
    const dimM = l.match(/^(\s*)(?:Re)?Dim\s+(?:Preserve\s+)?(.+?)\s*(?:\/\/.*)?$/i);
    if (dimM) {
      // Each Dim clause may be "name" or "name(n)" or "name(n, m)"
      const decls = dimM[2].split(',').map(part => {
        part = part.trim();
        const arrM = part.match(/^(\w+)\s*\(([^)]*)\)$/);
        if (!arrM) return part;                        // scalar: Dim x → var x
        const dims = arrM[2].split(',').map(d => parseInt(d.trim(), 10) + 1);
        if (dims.length === 1) {
          return `${arrM[1]} = new Array(${dims[0]})`;
        }
        // 2-D: Dim x(n, m)
        const [rows, cols] = dims;
        return `${arrM[1]} = (function(){var _a=[];for(var _i=0;_i<${rows};_i++){_a[_i]=new Array(${cols});}return _a;}())`;
      });
      out.push(`${dimM[1]}var ${decls.join(', ')};`);
      continue;
    }

    // ── Set obj = expr → obj = expr ───────────────────────────────────────────
    l = l.replace(/^(\s*)Set\s+/i, '$1');

    // ── Call func(args) → func(args) ─────────────────────────────────────────
    l = l.replace(/^(\s*)Call\s+/i, '$1');

    // ── msgbox expr → alert(expr) ─────────────────────────────────────────────
    l = l.replace(/\bmsgbox\s+(.+)$/gi, (_, expr) => `alert(${expr.trim()})`);

    // ── VBScript array subscript: arr(i) → arr[i], arr(i,j) → arr[i][j] ───────
    // Only for identifiers that were declared as arrays via Dim arr(n).
    for (const arrName of arrayNames) {
      l = l.replace(
        new RegExp(`\\b${arrName}\\s*\\(([^)]+)\\)`, 'g'),
        (_, args) => {
          const idxs = args.split(',').map(a => a.trim());
          return arrName + idxs.map(i => `[${i}]`).join('');
        }
      );
    }

    // ── Statement-level literal + concat normalization ────────────────────────
    l = vbLiterals(l);
    l = l.replace(/\s+&\s+/g, ' + ');

    out.push(l);
  }

  return { js: out.join('\n'), subNames };
}

// ── VBScript global function shims (always-on when ieShim is active) ──────────
// IE made VBScript built-ins (InStr, UCase, etc.) available to JavaScript when
// VBScript was also loaded on the page.  Classic ASP menu/toolbar JS files often
// call these functions.  We inject them unconditionally so they're available
// even on pages that have no inline VBScript blocks.
const VB_GLOBALS_SCRIPT = `<script>
/* VBScript global function shims — always available on IE-era pages */
if(typeof InStr==='undefined'){window.InStr=function(a,b){return typeof a==="number"?String(arguments[1]).indexOf(arguments[2])+1:String(a).indexOf(b)+1;};}
if(typeof InStrRev==='undefined'){window.InStrRev=function(s,f){return String(s).lastIndexOf(f)+1;};}
if(typeof Left==='undefined'){window.Left=function(s,n){return String(s).substring(0,n);};}
if(typeof Right==='undefined'){window.Right=function(s,n){s=String(s);return s.substring(s.length-n);};}
if(typeof Mid==='undefined'){window.Mid=function(s,st,ln){s=String(s);return ln===undefined?s.substring(st-1):s.substring(st-1,st-1+ln);};}
if(typeof Len==='undefined'){window.Len=function(s){return s==null?0:String(s).length;};}
if(typeof UCase==='undefined'){window.UCase=function(s){return String(s).toUpperCase();};}
if(typeof LCase==='undefined'){window.LCase=function(s){return String(s).toLowerCase();};}
if(typeof Trim==='undefined'){window.Trim=function(s){return String(s).trim();};}
if(typeof LTrim==='undefined'){window.LTrim=function(s){return String(s).replace(/^\\s+/,'');};}
if(typeof RTrim==='undefined'){window.RTrim=function(s){return String(s).replace(/\\s+$/,'');};}
if(typeof Replace==='undefined'){window.Replace=function(s,f,r){return String(s).split(f).join(r);};}
if(typeof Split==='undefined'){window.Split=function(s,d,n){var r=String(s).split(d===undefined?',':d);return n>0?r.slice(0,n):r;};}
if(typeof Join==='undefined'){window.Join=function(a,d){return(a||[]).join(d===undefined?',':d);};}
if(typeof UBound==='undefined'){window.UBound=function(a,d){if(!Array.isArray(a)||!a.length)return -1;return(!d||d===1)?a.length-1:(Array.isArray(a[0])?a[0].length-1:-1);};}
if(typeof LBound==='undefined'){window.LBound=function(){return 0;};}
if(typeof IsArray==='undefined'){window.IsArray=function(a){return Array.isArray(a);};}
if(typeof IsNull==='undefined'){window.IsNull=function(a){return a===null||a===undefined;};}
if(typeof IsEmpty==='undefined'){window.IsEmpty=function(a){return a===undefined||a===null||a==='';};}
if(typeof IsNumeric==='undefined'){window.IsNumeric=function(a){return!isNaN(parseFloat(a))&&isFinite(a);};}
if(typeof CStr==='undefined'){window.CStr=function(a){return a==null?'':String(a);};}
if(typeof CInt==='undefined'){window.CInt=function(a){return parseInt(a)||0;};}
if(typeof CLng==='undefined'){window.CLng=function(a){return parseInt(a)||0;};}
if(typeof CDbl==='undefined'){window.CDbl=function(a){return parseFloat(a)||0;};}
if(typeof CBool==='undefined'){window.CBool=function(a){return!!a;};}
if(typeof Abs==='undefined'){window.Abs=function(n){return Math.abs(n);};}
if(typeof Int==='undefined'){window.Int=function(n){return Math.floor(n);};}
if(typeof Rnd==='undefined'){window.Rnd=function(){return Math.random();};}
if(typeof MsgBox==='undefined'){window.MsgBox=function(m){alert(m);};}
if(typeof msgbox==='undefined'){window.msgbox=function(m){alert(m);};}
if(typeof Now==='undefined'){window.Now=function(){return new Date();};}
if(typeof Date==='undefined'||typeof DateAdd==='undefined'){window.DateAdd=function(i,n,d){var r=new Date(d);if(i==='d')r.setDate(r.getDate()+n);return r;};}
if(typeof FormatNumber==='undefined'){window.FormatNumber=function(n,d){return Number(n).toFixed(d===undefined?2:d);};}
if(typeof FormatCurrency==='undefined'){window.FormatCurrency=function(n){return Number(n).toFixed(2);};}
</script>`;

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

  // ── Step 3: Normalize Windows backslash paths in URL attributes ───────────
  // IE accepted href="..\folder\file.asp"; modern browsers need forward slashes.
  $('a, link, script, img, form, input, iframe').each((_, el) => {
    for (const attr of ['href', 'src', 'action']) {
      const val = $(el).attr(attr);
      if (val && val.includes('\\')) {
        $(el).attr(attr, val.replace(/\\/g, '/'));
      }
    }
  });

  // ── Step 4: Inject shim <script>/<link> tags into <head> ──────────────────
  const headContent = (flags.ieShim ? VB_GLOBALS_SCRIPT + '\n    ' : '') + (tags || '');
  if (headContent.trim()) {
    if ($('head').length) {
      $('head').prepend('\n    ' + headContent + '\n  ');
    } else {
      const firstScript = $('script').first();
      if (firstScript.length) {
        firstScript.before(headContent);
      } else {
        $('body').prepend(headContent);
      }
    }
  }

  return $.html();
}
