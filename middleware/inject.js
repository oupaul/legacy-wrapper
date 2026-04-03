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

/**
 * Parse `html`, inject shim tags into <head>, return modified HTML string.
 */
/**
 * @param {string} html
 * @param {string|object} pathnameOrReq — path string OR full Express req object
 */
export function buildInjectedHtml(html, pathnameOrReq = '/') {
  const req   = typeof pathnameOrReq === 'string'
    ? { path: pathnameOrReq, url: pathnameOrReq, method: 'GET', headers: {} }
    : pathnameOrReq;
  const flags = resolveFlags(req);
  const tags = buildTags(flags);

  if (!tags) return html; // nothing to inject

  const $ = cheerio.load(html, { decodeEntities: false });

  if ($('head').length) {
    $('head').prepend('\n    ' + tags + '\n  ');
  } else {
    // Malformed HTML with no <head> — inject before first <script> or at top of <body>
    const firstScript = $('script').first();
    if (firstScript.length) {
      firstScript.before(tags);
    } else {
      $('body').prepend(tags);
    }
  }

  return $.html();
}
