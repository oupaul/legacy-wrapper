import express from 'express';
import { URL } from 'node:url';
import config from './config.js';
import { createAuthProxy } from './middleware/auth.js';

const app = express();

// ── Security: reject non-allowlisted upstream hosts ───────────────────────────
const targetUrl = new URL(config.target);
if (!config.allowedTargetHosts.includes(targetUrl.hostname)) {
  console.error(`[security] Target host "${targetUrl.hostname}" is not in allowedTargetHosts. Aborting.`);
  process.exit(1);
}

// ── Serve injection assets ────────────────────────────────────────────────────
// No-store so browsers always fetch the latest shim files (avoids stale-cache bugs).
app.use('/inject', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
}, express.static('./injector'));

// ── Auth-aware reverse proxy (handles NTLM, Kerberos, Basic + HTML injection) ─
app.use('/', createAuthProxy());

app.listen(config.port, () => {
  console.log(`Legacy wrapper → ${config.target}  (listening on :${config.port})`);
  console.log('Injections:', config.injections);
  console.log('Auth config:', {
    timeoutMs:        config.auth?.timeoutMs,
    stripClientAuth:  config.auth?.stripClientAuth,
    rejectUnauthorized: config.auth?.rejectUnauthorized,
  });
});
