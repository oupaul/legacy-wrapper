/**
 * Wrapper configuration.
 *
 * 所有設定都可以用環境變數覆蓋，方便 PM2 多實例部署。
 * 直接修改這裡的值作為預設值；PM2 ecosystem.config.cjs 中的 env 會蓋過它們。
 */

const target = process.env.LEGACY_TARGET || 'http://legacy-system.local';

// 自動從 target URL 提取 hostname，加入 allowlist（也可手動追加）
const targetHostname = (() => {
  try { return new URL(target).hostname; } catch { return ''; }
})();

export default {
  // 代理目標（舊系統網址）
  target,

  // 監聽 port
  port: parseInt(process.env.PORT || '3000', 10),

  // 注入功能開關
  injections: {
    ieShim:      process.env.INJECT_IE_SHIM      !== 'false',  // 預設 true
    activexMock: process.env.INJECT_ACTIVEX_MOCK !== 'false',  // 預設 true
    compatCss:   process.env.INJECT_COMPAT_CSS   !== 'false',  // 預設 true
  },

  // ── 認證設定 ──────────────────────────────────────────────────────────────
  auth: {
    timeoutMs: parseInt(process.env.LEGACY_TIMEOUT || '30000', 10),

    // 舊系統 TLS 1.0/1.1（症狀：EPROTO unsupported protocol）
    legacySsl: process.env.LEGACY_SSL === 'true',

    // 自簽憑證（LEGACY_SSL=true 時自動生效）
    rejectUnauthorized: process.env.LEGACY_REJECT_UNAUTHORIZED !== 'false',

    // true = 不轉發瀏覽器的 Authorization header，改用 serviceAccount
    stripClientAuth: process.env.LEGACY_STRIP_AUTH === 'true',

    // service account 模式（stripClientAuth=true 時才需要）
    // serviceAccount: {
    //   type: 'basic',
    //   username: process.env.PROXY_USER,
    //   password: process.env.PROXY_PASS,
    // },
  },

  // ── 注入規則 ──────────────────────────────────────────────────────────────
  rulesMode: 'merge',   // 'merge' | 'first'

  rules: [
    // { match: /^\/api\//, overrides: { ieShim: false, activexMock: false, compatCss: false } },
  ],

  // ── 安全 allowlist ────────────────────────────────────────────────────────
  // target hostname 自動加入；如需額外允許其他 host 手動追加
  allowedTargetHosts: [
    targetHostname,
    // '192.168.1.100',
  ].filter(Boolean),
};
