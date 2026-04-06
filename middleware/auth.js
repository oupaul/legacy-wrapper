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
import { URL } from 'node:url';
import { buildInjectedHtml } from './inject.js';
import config from '../config.js';

// ── Upstream connection config ────────────────────────────────────────────────

const targetUrl   = new URL(config.target);
const isHttps     = targetUrl.protocol === 'https:';
const httpModule  = isHttps ? https : http;
const upstreamPort = targetUrl.port
  ? parseInt(targetUrl.port, 10)
  : (isHttps ? 443 : 80);

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
    // Build forwarded headers
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (HOP_BY_HOP_REQ.has(lower)) continue;
      if (lower === 'authorization' && !shouldPassClientAuth()) continue;
      headers[k] = v;
    }
    headers['host'] = targetUrl.host;

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
      const body = Buffer.concat(bodyChunks);

      const options = {
        hostname: targetUrl.hostname,
        port:     upstreamPort,
        path:     req.url,
        method:   req.method,
        headers,
        agent:    agentFor(req.socket),   // ← NTLM connection binding
        timeout:  (config.auth?.timeoutMs ?? 30_000),
      };

      const upReq = httpModule.request(options, upRes => {
        const status      = upRes.statusCode;
        const contentType = upRes.headers['content-type'] || '';
        const isHtml      = contentType.includes('text/html');
        const isAuthChallenge = (status === 401 || status === 407);

        // Forward response headers
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (!HOP_BY_HOP_RES.has(k.toLowerCase())) {
            res.setHeader(k, v);
          }
        }
        res.statusCode = status;

        if (!isHtml || isAuthChallenge) {
          // Auth challenges and non-HTML: pipe straight through
          upRes.pipe(res, { end: true });
          upRes.on('end', resolve);
          upRes.on('error', reject);
          return;
        }

        // HTML: buffer → inject → send
        const chunks = [];
        upRes.on('data', c => chunks.push(c));
        upRes.on('end', () => {
          const raw      = Buffer.concat(chunks).toString('utf8');
          const patched  = buildInjectedHtml(raw, req.path);
          res.removeHeader('content-length');
          res.end(patched);
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
