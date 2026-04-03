# legacy-wrapper

Reverse proxy that injects IE-compatibility shims into an unmodified legacy web system.

## Quick start

```bash
npm install
LEGACY_TARGET=http://your-legacy-host.local node server.js
```

Browse to `http://localhost:3000` — the wrapper forwards every request to the legacy system and injects shims into every HTML response.

## Project layout

```
legacy-wrapper/
├── server.js               # Express entry point + proxy
├── config.js               # All tuneable options
├── middleware/
│   └── inject.js           # HTML injection logic (cheerio)
└── injector/               # Static assets served at /inject/*
    ├── ie-shim.js          # document.all, attachEvent, window.event, ...
    ├── activex-mock.js     # ActiveXObject, window.external stubs
    └── compat.css          # IE layout quirk fixes
```

## Configuration (`config.js`)

| Key | Default | Description |
|-----|---------|-------------|
| `target` | `http://legacy-system.local` | Upstream URL |
| `port` | `3000` | Listening port |
| `injections.ieShim` | `true` | IE DOM/event shims |
| `injections.activexMock` | `true` | ActiveX / COM stubs |
| `injections.compatCss` | `true` | CSS quirk fixes |
| `rules` | `[]` | Per-path overrides (see below) |
| `allowedTargetHosts` | `[...]` | Security allowlist |

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

Rules are matched in order; the first match wins.

## Adding a new shim

1. Create `injector/my-shim.js`
2. Add a flag to `config.js → injections`: `myShim: true`
3. Add the tag builder in `middleware/inject.js → buildTags`

## Security notes

- Only hosts listed in `allowedTargetHosts` are ever proxied to.
- Injection scripts are served as static local files — no external CDN.
- `execScript` in `activex-mock.js` delegates to `eval`; disable it if your legacy pages don't use it.
- This wrapper is intended for **intranet use only**.
