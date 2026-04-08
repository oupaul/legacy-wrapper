# legacy-wrapper

Reverse proxy that injects IE-compatibility shims into an unmodified legacy web system, allowing Classic ASP / IE-era pages to run in modern browsers (Chrome, Edge).

## Quick start

```bash
npm install
LEGACY_TARGET=http://your-legacy-host.local node server.js
```

Browse to `http://localhost:3000` — the wrapper forwards every request to the legacy system and injects shims into every HTML response.

## Project layout

```
legacy-wrapper/
├── server.js               # Express entry point + /inject static + proxy
├── config.js               # All tuneable options
├── middleware/
│   ├── auth.js             # NTLM/Basic auth + HTML injection pipeline
│   └── inject.js           # HTML injection logic (shim tags + inline scripts)
└── injector/               # Static assets served at /inject/*
    ├── ie-shim.js          # document.all, attachEvent, window.event, …
    ├── activex-mock.js     # ActiveXObject / window.external stubs (full XMLDOM)
    └── compat.css          # IE layout quirk fixes
```

## Configuration (`config.js`)

| Key | Default | Description |
|-----|---------|-------------|
| `target` | `http://legacy-system.local` | Upstream legacy system URL |
| `port` | `3000` | Listening port |
| `injections.ieShim` | `true` | IE DOM / event shims (`ie-shim.js`) |
| `injections.activexMock` | `true` | ActiveX / COM inline shim |
| `injections.compatCss` | `true` | CSS quirk fixes |
| `auth.timeoutMs` | `30000` | Upstream request timeout |
| `auth.legacySsl` | `false` | Allow TLS 1.0/1.1 for old backends |
| `auth.rejectUnauthorized` | `true` | Reject self-signed certs (set `false` if needed) |
| `auth.stripClientAuth` | `false` | Replace browser credentials with `serviceAccount` |
| `auth.defaultCharset` | `null` | Fallback charset when backend omits it (e.g. `gb2312`) |
| `proxyUrl` | `null` | Public proxy URL for absolute-URL rewriting |
| `rewriteOrigins` | `[]` | Extra upstream origins to rewrite (see below) |
| `rules` | `[]` | Per-path injection overrides (see below) |
| `allowedTargetHosts` | auto | Security allowlist (auto-includes target hostname) |

### Extra origin rewriting (`rewriteOrigins`)

Some legacy pages hardcode absolute URLs pointing to the same server but on a different port (e.g. `:6080`). These links bypass the proxy when followed by the browser because they don't match `proxyUrl`'s single upstream origin.

Add those origins to `rewriteOrigins` and they will be rewritten to `proxyUrl` in HTML/JS/CSS responses **and** in `Location` redirect headers:

```js
// config.js
rewriteOrigins: [
  'http://192.168.1.100:6080',   // same server, different port
  'http://legacy.internal:8080', // alternate hostname
],
```

Or via environment variable (comma-separated):

```bash
REWRITE_ORIGINS=http://192.168.1.100:6080,http://legacy.internal:8080 \
pm2 restart my-legacy-app
```

> `proxyUrl` (the main target origin) is always rewritten — no need to repeat it here.

### Per-path injection rules

```js
// config.js → rules
rules: [
  // Disable ActiveX mock for the /reports/ section
  { match: /^\/reports\//, overrides: { activexMock: false } },

  // Disable everything for the /api/ path (JSON, not HTML)
  { match: /^\/api\//, overrides: { ieShim: false, activexMock: false, compatCss: false } },
]
```

## Deployment (PM2)

### Install PM2

PM2 is not listed as a project dependency — install it globally once on the server:

```bash
npm install -g pm2
```

Verify:

```bash
pm2 --version
```

### First-time start

```bash
cd ~/legacy-wrapper

PORT=3001 \
LEGACY_TARGET=http://192.168.1.100:88 \
PROXY_PUBLIC_URL=http://10.0.0.1:3001 \
LEGACY_CHARSET=gb2312 \
pm2 start server.js --name my-legacy-app
```

Environment variables can also be written into an `ecosystem.config.cjs` file so you don't have to repeat them on every restart:

```js
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'my-legacy-app',
    script: './server.js',
    env: {
      PORT:             '3001',
      LEGACY_TARGET:    'http://192.168.1.100:88',
      PROXY_PUBLIC_URL: 'http://10.0.0.1:3001',
      LEGACY_CHARSET:   'gb2312',
    },
  }],
};
```

```bash
pm2 start ecosystem.config.cjs
```

### Autostart on reboot

After the process is running, save the process list and generate a systemd startup hook:

```bash
pm2 save                   # save current process list
pm2 startup                # prints a command to run as root — copy-paste and run it
```

The `pm2 startup` command prints something like:

```
[PM2] To setup the Startup Script, copy/paste the following command:
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
```

Run that printed command once. From that point forward, PM2 (and all saved processes) will restart automatically after a reboot.

### Day-to-day management

| Task | Command |
|------|---------|
| List all processes | `pm2 list` |
| View live logs | `pm2 logs my-legacy-app` |
| View last N log lines | `pm2 logs my-legacy-app --lines 50 --nostream` |
| Restart (after `git pull`) | `pm2 restart my-legacy-app` |
| Reload with zero downtime | `pm2 reload my-legacy-app` |
| Stop | `pm2 stop my-legacy-app` |
| Delete from PM2 registry | `pm2 delete my-legacy-app` |
| Show process detail | `pm2 show my-legacy-app` |
| Monitor CPU / memory | `pm2 monit` |

### Deploy update from Git

```bash
cd ~/legacy-wrapper
git pull
pm2 restart my-legacy-app   # or: pm2 reload my-legacy-app (zero-downtime)
```

### Log rotation (optional)

PM2 log files grow unbounded by default.  Install the log-rotation module once:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

### Nginx reverse proxy (recommended)

```nginx
server {
    listen 443 ssl;
    server_name legacy.example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host  $host;

        proxy_no_cache      1;
        proxy_cache_bypass  1;

        proxy_connect_timeout 600s;
        proxy_send_timeout    600s;
        proxy_read_timeout    600s;

        proxy_buffering      on;
        proxy_buffer_size    16k;
        proxy_buffers        8 16k;
        proxy_busy_buffers_size 32k;
        # Do NOT add proxy_hide_header Cache-Control or override Cache-Control here.
        # The Node.js server already sets Cache-Control: no-store and
        # Clear-Site-Data: "cache" on all injected HTML responses.
    }
}
```

## What the injector does

### 1. VBScript global shims (always-on with `ieShim`)

Classic ASP pages often call VBScript built-ins (`InStr`, `Left`, `Mid`, `UCase`, `Split`, `Replace`, …) from inline JavaScript. These are injected as JavaScript equivalents so the page doesn't throw `ReferenceError`.

### 2. ActiveX / XMLDOM inline shim (`activexMock`)

Injected as an **inline `<script>`** in `<head>` — not as an external file — so it is immune to browser or proxy caching of old versions.

Emulates:

| IE API | Implementation |
|--------|----------------|
| `new ActiveXObject("Microsoft.XMLDOM")` | Full XML document wrapper with `createElement`, `appendChild`, `getElementsByTagName` (IE `.nextNode` getter), `.text` property, `selectSingleNode`, `selectNodes` |
| `new ActiveXObject("Microsoft.XMLHTTP")` | Real synchronous `XMLHttpRequest` with both lowercase (`open`/`send`) and uppercase (`Open`/`Send`) method aliases |
| Other `ActiveXObject(...)` | No-op `Proxy` (logs warning) |
| `window.execScript` | Delegates to `eval` |
| `window.CollectGarbage` | No-op |

`window.ActiveXObject` is locked via `Object.defineProperty({writable:false, configurable:false})` so any subsequently loaded stale `activex-mock.js` file cannot override it.

### 3. Named form window access

IE exposed `<form name="X">` as `window.X`. A `DOMContentLoaded` shim binds every named form onto `window` so legacy code like `OutStockHead.txtmanager.value` works in Chrome.

### 4. Cache busting

- All injected HTML responses carry `Cache-Control: no-store` and `Clear-Site-Data: "cache"` to prevent stale shim versions from being served.
- Static assets under `/inject/` are served with `Cache-Control: no-store`.

## Security notes

- Only hosts listed in `allowedTargetHosts` are ever proxied to.
- Injection scripts are served as static local files — no external CDN.
- `execScript` delegates to `eval`; disable it if your legacy pages don't use it.
- This wrapper is intended for **intranet / internal use only**.
- Credentials in the HTML (form hidden fields) are passed through as-is — use HTTPS end-to-end.
