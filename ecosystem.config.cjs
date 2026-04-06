/**
 * PM2 Ecosystem 設定
 *
 * 每個 app = 一個代理目標（一個舊系統）。
 * 複製其中一個 app 區塊就能新增目標。
 *
 * 啟動：  pm2 start ecosystem.config.cjs
 * 重啟：  pm2 restart all
 * 狀態：  pm2 status
 * 日誌：  pm2 logs
 * 設開機自啟：pm2 startup  →  pm2 save
 */

module.exports = {
  apps: [

    // ── 範例 1：ZyWALL USG（TLS 1.0 舊系統）────────────────────────────────
    {
      name:   'zywall',            // pm2 顯示名稱，自由命名
      script: 'server.js',
      env: {
        PORT:          '3000',
        LEGACY_TARGET: 'https://220.135.120.242:444',
        LEGACY_SSL:    'true',     // TLS 1.0 + 自簽憑證
        NODE_ENV:      'production',
      },
    },

    // ── 範例 2：內網舊 ERP（HTTP，無憑證問題）─────────────────────────────
    // {
    //   name:   'legacy-erp',
    //   script: 'server.js',
    //   env: {
    //     PORT:          '3001',
    //     LEGACY_TARGET: 'http://192.168.1.100',
    //     NODE_ENV:      'production',
    //   },
    // },

    // ── 範例 3：內網舊 OA（HTTPS 自簽憑證）───────────────────────────────
    // {
    //   name:   'legacy-oa',
    //   script: 'server.js',
    //   env: {
    //     PORT:                       '3002',
    //     LEGACY_TARGET:              'https://192.168.1.200',
    //     LEGACY_REJECT_UNAUTHORIZED: 'false',
    //     NODE_ENV:                   'production',
    //   },
    // },

  ],
};
