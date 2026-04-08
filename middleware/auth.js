/**
 * auth.js — Auth-aware reverse proxy handler
 *
 * Replaces http-proxy-middleware to give us full control over:
 *   - NTLM multi-round connection binding (per-client-socket agent)
 *   - Kerberos / Basic / Bearer header passthrough
 *   - WWW-Authenticate / Proxy-Authenticate challenge forwarding
 *   - HTML injection pipeline (calls inject.js)
 *
 * NTLM handshake overview (3 round-trips, SAME upstream TCP connection):
 *   1. Client → Proxy → Server: GET  (no auth)
 *   2. Server → Proxy → Client: 401  WWW-Authenticate: NTLM
 *   3. Client → Proxy → Server: GET  Authorization: NTLM <type1-negotiate>
 *   4. Server → Proxy → Client: 401  WWW-Authenticate: NTLM <type2-challenge>
 *   5. Client → Proxy → Server: GET  Authorization: NTLM <type3-authenticate>
 *   6. Server → Proxy → Client: 200
 *
 * Steps 3–6 MUST use the same upstream TCP connection.
 * We enforce this with maxSockets:1 keepAlive agents, one per client socket.
 */

import http  from 'node:http';
import https from 'node:https';
import tls   from 'node:tls';
import { constants } from 'node:crypto';
import { URL } from 'node:url';
import iconv from 'iconv-lite';
import { buildInjectedHtml } from './inject.js';
import config from '../config.js';

// ── Upstream connection config ────────────────────────────────────────────────

const targetUrl   = new URL(config.target);
const isHttps     = targetUrl.protocol === 'https:';
const httpModule  = isHttps ? https : http;
const upstreamPort = targetUrl.port
  ? parseInt(targetUrl.port, 10)
  : (isHttps ? 443 : 80);

// ── URL 替換設定 ──────────────────────────────────────────────────────────
// 原始伺服器的 origin（e.g. http://111.198.160.165:88）
const upstreamOrigin = `${targetUrl.protocol}//${targetUrl.host}`;
// proxy 的公開 URL（e.g. http://10.201.15.31:3001），null = 不替換
const proxyPublicUrl = config.proxyUrl
  ? config.proxyUrl.replace(/\/$/, '')   // 去尾部斜線
  : null;

// ── 額外上游 origin 路由表 ─────────────────────────────────────────────────
// config.rewriteOrigins 中的每個 entry 被正規化為：
//   { origin, prefix, hostname, port, isHttps }
//
// 路徑前綴規則：
//   http://server:6080/some/page → /~6080/some/page（前綴 = /~<port>）
//   請求到 /~6080/some/page 時，proxy 剝除前綴並轉發到 http://server:6080/some/page
//
// 這樣同一個 proxy 實例可以代理多個不同 port 的上游，無需額外 PM2 實例。
const rewriteRoutes = (config.rewriteOrigins || []).map(entry => {
  const originStr = (typeof entry === 'string' ? entry : entry.origin).replace(/\/$/, '');
  const originUrl = new URL(originStr);
  const routePort = originUrl.port
    ? parseInt(originUrl.port, 10)
    : (originUrl.protocol === 'https:' ? 443 : 80);

  // 允許手動指定前綴；預設用 /~<port>
  const prefix = (typeof entry === 'object' && entry.prefix)
    ? entry.prefix.replace(/\/$/, '')
    : `/~${routePort}`;

  // 允許手動指定不同的轉發目標；預設就是 origin 本身
  const targetStr = (typeof entry === 'object' && entry.target)
    ? entry.target.replace(/\/$/, '')
    : originStr;
  const tUrl = new URL(targetStr);
  const tPort = tUrl.port
    ? parseInt(tUrl.port, 10)
    : (tUrl.protocol === 'https:' ? 443 : 80);

  return {
    origin:    originStr,          // 要替換的來源 origin
    prefix,                        // URL 前綴（e.g. /~6080）
    hostname:  tUrl.hostname,
    port:      tPort,
    isHttps:   tUrl.protocol === 'https:',
    host:      tUrl.host,          // hostname:port 或純 hostname
  };
});

// 將請求路徑對應到 rewriteRoute（若路徑以 route.prefix 開頭）
function matchRoute(urlPath) {
  for (const route of rewriteRoutes) {
    if (urlPath === route.prefix || urlPath.startsWith(route.prefix + '/') ||
        urlPath.startsWith(route.prefix + '?')) {
      return route;
    }
  }
  return null;
}

function rewriteUrls(text) {
  if (!proxyPublicUrl) return text;
  // 主 target origin → proxyPublicUrl（無前綴）
  if (text.includes(upstreamOrigin)) {
    text = text.replaceAll(upstreamOrigin, proxyPublicUrl);
  }
  // 額外 origin → proxyPublicUrl + prefix
  for (const route of rewriteRoutes) {
    if (text.includes(route.origin)) {
      text = text.replaceAll(route.origin, proxyPublicUrl + route.prefix);
    }
  }
  return text;
}

// ── Charset detection ─────────────────────────────────────────────────────────
// Returns the charset name found in the Content-Type header or HTML meta tags,
// or null if unknown (caller should default to utf-8).

function detectCharset(contentTypeHeader, buf) {
  // 1. Content-Type header is most authoritative
  const m = (contentTypeHeader || '').match(/charset=([\w-]+)/i);
  if (m) return m[1];

  // 2. BOM
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'utf-8';

  // 3. Sniff HTML <meta charset> from the first 4 KB (read as latin1 to preserve bytes)
  const snippet = buf.slice(0, 4096).toString('latin1');
  const mm = snippet.match(/charset=["']?([\w-]+)/i);
  if (mm) return mm[1];

  // 4. Config-level fallback (LEGACY_CHARSET env var)
  if (config.auth?.defaultCharset) return config.auth.defaultCharset;

  return null;
}

// Lower TLS minimum if upstream is a legacy HTTPS server (TLS 1.0 / 1.1)
if (isHttps && config.auth?.legacySsl) {
  tls.DEFAULT_MIN_VERSION = 'TLSv1';
}

// ── Per-client-socket agent pool (NTLM connection binding) ────────────────────
// Each client socket gets exactly one upstream agent.
// maxSockets:1 forces all requests from that client to reuse one upstream conn.

const socketAgents = new Map();

function agentFor(clientSocket) {
  if (!socketAgents.has(clientSocket)) {
    const agentOpts = { keepAlive: true, maxSockets: 1 };
    if (isHttps && config.auth?.legacySsl) {
      agentOpts.rejectUnauthorized = false;
      agentOpts.minVersion = 'TLSv1';
      agentOpts.ciphers = 'ALL:@SECLEVEL=0';
      agentOpts.secureOptions =
        constants.SSL_OP_LEGACY_SERVER_CONNECT |
        constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION;
    } else if (isHttps && config.auth?.rejectUnauthorized === false) {
      agentOpts.rejectUnauthorized = false;
    }
    const agent = new httpModule.Agent(agentOpts);
    socketAgents.set(clientSocket, agent);
    clientSocket.once('close', () => {
      const a = socketAgents.get(clientSocket);
      if (a) a.destroy();
      socketAgents.delete(clientSocket);
    });
  }
  return socketAgents.get(clientSocket);
}

// ── Header filter lists ───────────────────────────────────────────────────────

// Strip from upstream response before forwarding to client
const HOP_BY_HOP_RES = new Set([
  'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade',
]);

// Strip from client request before forwarding upstream (except auth headers)
const HOP_BY_HOP_REQ = new Set([
  'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'host',
]);

// ── Auth-config helpers ───────────────────────────────────────────────────────

const authCfg = config.auth || {};

/**
 * Optionally inject service-account credentials for upstream NTLM/Basic auth.
 * Used when the proxy itself authenticates rather than passing client tokens.
 * Leave config.auth undefined to rely on pure header passthrough instead.
 */
function maybeAddServiceAuth(headers) {
  if (!authCfg.serviceAccount) return;

  const { username, password, type = 'basic' } = authCfg.serviceAccount;

  if (type === 'basic') {
    const token = Buffer.from(`${username}:${password}`).toString('base64');
    headers['authorization'] = `Basic ${token}`;
  }
  // NTLM service-account auth would require ntlm-auth package negotiation;
  // left as extension point — see README for details.
}

/**
 * Determine if we should pass through the client's own Authorization header.
 * Default: yes (passthrough mode).
 * Set config.auth.stripClientAuth = true to force service-account-only mode.
 */
function shouldPassClientAuth() {
  return !authCfg.stripClientAuth;
}

// ── Core proxy request ────────────────────────────────────────────────────────

function forwardRequest(req, res) {
  return new Promise((resolve, reject) => {
    // Detect route prefix in the request path (e.g. /~6080/some/page)
    const activeRoute = matchRoute(req.url);
    // Strip the prefix from the path before forwarding
    const upstreamPath = activeRoute
      ? (req.url.slice(activeRoute.prefix.length) || '/')
      : req.url;
    // Select the correct upstream target for this request
    const fwdHostname   = activeRoute ? activeRoute.hostname   : targetUrl.hostname;
    const fwdPort       = activeRoute ? activeRoute.port       : upstreamPort;
    const fwdHttpModule = activeRoute
      ? (activeRoute.isHttps ? https : http)
      : httpModule;
    const fwdOrigin     = activeRoute ? activeRoute.origin     : upstreamOrigin;
    const fwdHost       = activeRoute ? activeRoute.host       : targetUrl.host;

    // Build forwarded headers
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (HOP_BY_HOP_REQ.has(lower)) continue;
      if (lower === 'authorization' && !shouldPassClientAuth()) continue;

      // Rewrite Referer / Origin so the upstream sees its own domain,
      // not the proxy URL. Some servers reject requests with foreign Referer.
      if (proxyPublicUrl && (lower === 'referer' || lower === 'origin')) {
        // Replace proxyPublicUrl + route.prefix → fwdOrigin
        let val = v;
        if (activeRoute) {
          val = val.replace(proxyPublicUrl + activeRoute.prefix, fwdOrigin);
        }
        val = val.replace(proxyPublicUrl, upstreamOrigin);
        headers[k] = val;
        continue;
      }

      headers[k] = v;
    }
    headers['host'] = fwdHost;

    maybeAddServiceAuth(headers);

    // Detect auth scheme for logging
    const authHeader  = (req.headers['authorization'] || '').split(' ')[0].toUpperCase();
    const isNtlm      = authHeader === 'NTLM';
    const isNegotiate = authHeader === 'NEGOTIATE';
    if (isNtlm || isNegotiate) {
      console.info(`[auth] ${isNtlm ? 'NTLM' : 'Kerberos'} token from ${req.socket.remoteAddress}`);
    }

    // Buffer request body
    const bodyChunks = [];
    req.on('data', c => bodyChunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(bodyChunks);

      // ── Re-encode URL-form-encoded POST body: UTF-8 → upstream legacy charset ──
      // We serve HTML decoded to UTF-8, so the browser submits form data in UTF-8.
      // Classic ASP servers read Request.Form with GB2312/GBK codepage — Chinese
      // field values (e.g. collector name, department) arrive as garbled bytes,
      // causing SQL queries to return 0 results.
      // Fix: percent-encode each form value using the upstream charset's bytes.
      const legacyCharset = config.auth?.defaultCharset;
      const reqCt = (req.headers['content-type'] || '').toLowerCase();
      if (body.length > 0 &&
          legacyCharset && !/^utf-?8$/i.test(legacyCharset) &&
          reqCt.includes('application/x-www-form-urlencoded')) {
        try {
          // Percent-encode bytes from a Buffer: unreserved chars pass through,
          // everything else (including all high bytes) gets %XX encoded.
          const pctEncode = buf => {
            let out = '';
            for (const b of buf) {
              if (b === 0x20) { out += '+'; }
              else if (
                (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) ||
                (b >= 0x30 && b <= 0x39) ||
                b === 0x2D || b === 0x5F || b === 0x2E || b === 0x7E
              ) {
                out += String.fromCharCode(b); // A-Z a-z 0-9 - _ . ~
              } else {
                out += '%' + b.toString(16).padStart(2, '0').toUpperCase();
              }
            }
            return out;
          };

          const params = new URLSearchParams(body.toString('utf8'));
          const parts  = [];
          for (const [k, v] of params.entries()) {
            parts.push(pctEncode(iconv.encode(k, legacyCharset)) +
                       '=' +
                       pctEncode(iconv.encode(v, legacyCharset)));
          }
          body = Buffer.from(parts.join('&'), 'ascii');
          headers['content-length'] = String(body.length);
          console.info(`[auth] re-encoded POST body UTF-8→${legacyCharset} (${body.length}B)`);
        } catch (e) {
          console.warn('[auth] POST charset re-encode failed:', e.message);
        }
      }

      const options = {
        hostname: fwdHostname,
        port:     fwdPort,
        path:     upstreamPath,
        method:   req.method,
        headers,
        agent:    agentFor(req.socket),   // ← NTLM connection binding
        timeout:  (config.auth?.timeoutMs ?? 30_000),
      };

      const upReq = fwdHttpModule.request(options, upRes => {
        const status      = upRes.statusCode;
        const contentType = upRes.headers['content-type'] || '';
        const isHtml      = contentType.includes('text/html');
        const isJs        = /javascript/.test(contentType);
        const isCss       = contentType.includes('text/css');
        const isAuthChallenge = (status === 401 || status === 407);

        // ── 404 圖片 fallback ───────────────────────────────────────────────
        // 部分舊系統用圖片 onload 觸發頁面跳轉，圖片 404 會導致頁面卡死。
        // 對 404 的圖片回傳 1×1 透明 GIF，讓 onload 能正常觸發。
        if (status === 404 && /\.(gif|png|jpg|jpeg|bmp|ico|webp)(\?|$)/i.test(req.url)) {
          // 1×1 transparent GIF (35 bytes)
          const transparentGif = Buffer.from(
            '47494638396101000100800000ffffff00000021f90400000000002c00000000' +
            '010001000002024401003b', 'hex'
          );
          upRes.resume(); // drain upstream response
          res.writeHead(200, {
            'Content-Type':  'image/gif',
            'Content-Length': transparentGif.length,
            'Cache-Control':  'no-store',
          });
          res.end(transparentGif);
          resolve();
          return;
        }

        // AJAX requests (ExtJS, jQuery, fetch): never inject shims — the caller
        // expects raw JSON/XML, not an HTML document with injected scripts.
        const isXhr = (req.headers['x-requested-with'] || '').toLowerCase()
          === 'xmlhttprequest';

        // Forward response headers (with cookie + redirect rewriting)
        for (const [k, v] of Object.entries(upRes.headers)) {
          const lower = k.toLowerCase();
          if (HOP_BY_HOP_RES.has(lower)) continue;

          // Rewrite Location redirect to go through proxy
          // Main origin → proxyPublicUrl; extra origins → proxyPublicUrl + prefix
          if (lower === 'location' && proxyPublicUrl) {
            const rewritten = (Array.isArray(v) ? v : [v]).map(url => {
              if (url.startsWith(upstreamOrigin))
                return proxyPublicUrl + url.slice(upstreamOrigin.length);
              for (const route of rewriteRoutes) {
                if (url.startsWith(route.origin))
                  return proxyPublicUrl + route.prefix + url.slice(route.origin.length);
              }
              return url;
            });
            res.setHeader(k, rewritten.length === 1 ? rewritten[0] : rewritten);
            continue;
          }

          // Rewrite Set-Cookie: strip Domain so cookie is valid on proxy host,
          // strip Secure flag if proxy is HTTP, rewrite paths if needed
          if (lower === 'set-cookie') {
            const cookies = (Array.isArray(v) ? v : [v]).map(cookie =>
              cookie
                .replace(/;\s*Domain=[^;]*/gi, '')        // remove Domain= attribute
                .replace(/;\s*Secure(?=;|$)/gi, '')        // remove Secure if proxy is HTTP
            );
            res.setHeader(k, cookies);
            continue;
          }

          res.setHeader(k, v);
        }
        res.statusCode = status;

        // ── Decide whether to buffer (inject + rewrite) or pipe straight through
        const needsRewrite  = proxyPublicUrl && (isHtml || isJs || isCss) && !isAuthChallenge;
        const needsInject   = isHtml && !isXhr;

        if (!needsRewrite && !needsInject) {
          upRes.pipe(res, { end: true });
          upRes.on('end', resolve);
          upRes.on('error', reject);
          return;
        }

        // Buffer → transform → send
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          const rawBuf = Buffer.concat(chunks);

          // Decode with proper charset (GB2312 / GBK / Big5 → UTF-8 string)
          const charset    = detectCharset(contentType, rawBuf);
          const isNonUtf8  = charset && !/^utf-?8$/i.test(charset);
          let text = isNonUtf8
            ? iconv.decode(rawBuf, charset)
            : rawBuf.toString('utf8');

          if (needsInject) {
            // Trust Content-Type: text/html. The looksLikeHtml check was meant
            // to guard against AJAX responses mis-labelled as text/html, but we
            // already exclude XHR via !isXhr. Classic ASP pages produced by
            // Visual InterDev often start with a <SCRIPT> tag *before* the
            // <!DOCTYPE>, so the old check rejected them — never injecting the
            // ie-shim, leaving ToolBar_Supported permanently false.
            // We keep a weak guard only for obviously non-HTML content.
            const preview = text.trimStart().toLowerCase();
            const looksNonHtml = preview.startsWith('{') ||   // JSON object
                                 preview.startsWith('[') ||   // JSON array
                                 preview.startsWith('<?xml'); // XML
            if (!looksNonHtml) {
              text = buildInjectedHtml(text, req);
            }
          }

          // Replace all upstream origin references with proxy URL
          // Handles: HTML src/href, JS window.location, CSS url(), etc.
          if (needsRewrite) {
            text = rewriteUrls(text);
          }

          // After decoding to UTF-8, update charset declarations so the browser
          // renders correctly instead of re-interpreting as the original encoding.
          // This applies to ALL buffered content (HTML, JS, CSS), not just HTML.
          if (isNonUtf8) {
            if (isHtml) {
              // Update <meta charset> and <meta http-equiv Content-Type charset>
              text = text.replace(
                /(<meta[^>]+charset=["']?)([\w-]+)/gi,
                '$1utf-8'
              );
            }
            // Replace existing charset= in Content-Type header, or append it
            let newCT = contentType.replace(/charset=[\w-]+/gi, 'charset=utf-8');
            if (newCT && !/charset=/i.test(newCT)) {
              newCT = newCT.replace(/;\s*$/, '').trimEnd() + '; charset=utf-8';
            }
            if (newCT) res.setHeader('content-type', newCT);
          }

          res.removeHeader('content-length');
          if (needsInject) {
            res.setHeader('Cache-Control', 'no-store');
            // Clear-Site-Data forces the browser to discard ALL cached resources
            // for this origin.  Only works on HTTPS (browsers silently ignore it
            // on HTTP and log a console warning).
            const isSecure = req.secure ||
              (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
            if (isSecure && Date.now() < Date.UTC(2026, 3, 30)) {
              res.setHeader('Clear-Site-Data', '"cache"');
            }
          }
          res.end(text);
          resolve();
        });
        upRes.on('error', reject);
      });

      upReq.on('timeout', () => {
        upReq.destroy(new Error('upstream request timed out'));
      });
      upReq.on('error', reject);

      if (body.length > 0) upReq.write(body);
      upReq.end();
    });

    req.on('error', reject);
  });
}

// ── Express middleware factory ────────────────────────────────────────────────

export function createAuthProxy() {
  return async function authProxy(req, res, next) {
    try {
      await forwardRequest(req, res);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
      } else {
        console.error('[auth-proxy]', err.message);
        res.status(502).send('Legacy wrapper: upstream unavailable.');
      }
    }
  };
}

export { socketAgents }; // exposed for health-check / metrics
