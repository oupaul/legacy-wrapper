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

// 從 REWRITE_ORIGINS 提取 hostname，也自動加入 allowlist
const rewriteOriginHostnames = (process.env.REWRITE_ORIGINS || '')
  .split(',')
  .map(s => { try { return new URL(s.trim()).hostname; } catch { return ''; } })
  .filter(Boolean);

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

    // 當伺服器沒有在 Content-Type 或 <meta> 宣告 charset 時的預設編碼
    // 例：'gb2312'、'gbk'、'big5'。留空 = 視為 UTF-8
    defaultCharset: process.env.LEGACY_CHARSET || null,

    // service account 模式（stripClientAuth=true 時才需要）
    // serviceAccount: {
    //   type: 'basic',
    //   username: process.env.PROXY_USER,
    //   password: process.env.PROXY_PASS,
    // },
  },

  // ── URL 替換 ──────────────────────────────────────────────────────────────
  // 設定後，HTML/JS/CSS 回應裡所有指向原始伺服器的絕對 URL 會被替換成 proxy URL。
  // 解決「瀏覽器繞過 proxy 直連原始 IP 導致 404/拒絕連線」的問題。
  //
  // PROXY_PUBLIC_URL = 使用者瀏覽器實際看到的 proxy 網址（含 port）
  //   例：http://10.201.15.31:3001
  proxyUrl: process.env.PROXY_PUBLIC_URL || null,

  // 額外需要被替換的上游 origin 清單（當頁面裡出現不同 port 或不同 hostname 的連結時使用）。
  // 每個值的格式同 proxyUrl：scheme + host + port，不含尾部斜線。
  //
  // 環境變數 REWRITE_ORIGINS：逗號分隔
  //   例：REWRITE_ORIGINS=http://192.168.1.100:6080,http://legacy.internal:8080
  //
  // 或直接在這裡手動列出：
  //   rewriteOrigins: ['http://192.168.1.100:6080'],
  rewriteOrigins: (process.env.REWRITE_ORIGINS || '')
    .split(',')
    .map(s => s.trim().replace(/\/$/, ''))
    .filter(Boolean),

  // ── 注入規則 ──────────────────────────────────────────────────────────────
  rulesMode: 'merge',   // 'merge' | 'first'

  rules: [
    // { match: /^\/api\//, overrides: { ieShim: false, activexMock: false, compatCss: false } },
  ],

  // ── 安全 allowlist ────────────────────────────────────────────────────────
  // target hostname 與 rewriteOrigins 的 hostname 自動加入；如需額外允許手動追加
  allowedTargetHosts: [
    targetHostname,
    ...rewriteOriginHostnames,
    // '192.168.1.100',
  ].filter(Boolean),
};
