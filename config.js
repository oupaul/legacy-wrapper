/**
 * Wrapper configuration.
 * Edit this file to match your environment — no other files need to change.
 */

export default {
  // The legacy system being proxied
  target: process.env.LEGACY_TARGET || 'http://legacy-system.local',

  // Port this wrapper listens on
  port: parseInt(process.env.PORT || '3000', 10),

  // Injection feature flags — set false to disable individual shims globally
  injections: {
    ieShim:      true,   // document.all, attachEvent, window.event, srcElement
    activexMock: true,   // ActiveXObject, window.external stubs
    compatCss:   true,   // zoom:1 and other IE layout triggers
  },

  // ── Authentication ──────────────────────────────────────────────────────────
  // Leave auth undefined (or {}) to rely on pure client-header passthrough.
  // NTLM and Kerberos (Negotiate) tokens from the browser are forwarded
  // transparently; NTLM connection binding is handled automatically.
  auth: {
    // Upstream request timeout in milliseconds
    timeoutMs: 30_000,

    // Set true to accept self-signed certificates on the upstream (intranet)
    rejectUnauthorized: true,

    // Set true to strip the client's own Authorization header and force the
    // proxy to authenticate using serviceAccount credentials instead.
    stripClientAuth: false,

    // Service-account credentials (only needed when stripClientAuth: true).
    // type: 'basic'  → sends HTTP Basic auth to upstream.
    // NTLM service-account: requires ntlm-auth package (see README).
    // serviceAccount: {
    //   type: 'basic',
    //   username: process.env.PROXY_USER,
    //   password: process.env.PROXY_PASS,
    // },
  },

  // ── Injection rules ─────────────────────────────────────────────────────────
  // Rules are matched in order.  By default ALL matching rules are merged
  // (last write wins).  Set rulesMode: 'first' to restore first-match-wins.
  rulesMode: 'merge',   // 'merge' | 'first'

  rules: [
    // ── Simple format (path prefix or regex) ──────────────────────────────
    // { match: /^\/reports\//, overrides: { activexMock: false } },
    // { match: '/admin/',      overrides: { ieShim: false } },

    // ── Rich format (multi-condition) ──────────────────────────────────────
    // {
    //   label: 'API endpoints — skip all injection',
    //   conditions: [{ type: 'path', match: /^\/api\// }],
    //   overrides: { ieShim: false, activexMock: false, compatCss: false },
    // },
    //
    // {
    //   label: 'Print view — disable compat CSS (already print-optimised)',
    //   conditions: [
    //     { type: 'query', key: 'mode', match: 'print' },
    //   ],
    //   overrides: { compatCss: false },
    // },
    //
    // {
    //   label: 'Reports section GET only',
    //   conditions: [
    //     { type: 'path',   match: /^\/reports\// },
    //     { type: 'method', match: ['GET', 'HEAD'] },
    //   ],
    //   operator: 'AND',
    //   overrides: { activexMock: false },
    // },
  ],

  // Allowlist of upstream hosts the proxy will forward to (security guard)
  allowedTargetHosts: [
    'legacy-system.local',
  ],
};
