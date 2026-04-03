/**
 * rules.js — Advanced URL-pattern injection rule engine
 *
 * Supports two rule formats:
 *
 * ── Simple (backward-compatible) ────────────────────────────────────────────
 *   { match: /^\/reports\//, overrides: { activexMock: false } }
 *   { match: '/admin/',      overrides: { ieShim: false } }
 *
 * ── Rich (multi-condition) ──────────────────────────────────────────────────
 *   {
 *     conditions: [
 *       { type: 'path',   match: /^\/print\// },
 *       { type: 'query',  key: 'mode', match: 'print' },
 *       { type: 'method', match: ['GET', 'HEAD'] },
 *     ],
 *     operator: 'AND',   // 'AND' (default) | 'OR'
 *     overrides: { compatCss: false },
 *     label: 'print pages',
 *   }
 *
 * Condition types:
 *   path        — req.pathname  vs string prefix OR RegExp
 *   query       — req.query[key] vs string/RegExp (omit key to test full querystring)
 *   method      — req.method    vs string or string[]
 *   header      — req.headers[key] vs string/RegExp
 *   extension   — file extension of the path (.html, .asp, …)
 *   always      — matches every request (useful as a catch-all)
 *   never       — never matches (disable a rule without deleting it)
 *
 * Rules are evaluated in order; ALL matching rules are merged (last wins).
 * This differs from the original first-match-wins behaviour — set
 * config.rules.mode = 'first' to restore the old behaviour.
 */

import config from '../config.js';

// ── Condition testers ─────────────────────────────────────────────────────────

function testValue(value, matcher) {
  if (matcher instanceof RegExp)  return matcher.test(value ?? '');
  if (typeof matcher === 'string') return (value ?? '') === matcher;
  if (Array.isArray(matcher))      return matcher.includes(value ?? '');
  return false;
}

const conditionTesters = {
  path(cond, ctx) {
    const { match } = cond;
    if (match instanceof RegExp)   return match.test(ctx.pathname);
    if (typeof match === 'string') return ctx.pathname.startsWith(match);
    return false;
  },

  query(cond, ctx) {
    if (cond.key) {
      return testValue(ctx.query.get(cond.key), cond.match);
    }
    // No key → test the raw querystring
    return testValue(ctx.rawQuery, cond.match);
  },

  method(cond, ctx) {
    return testValue(ctx.method, cond.match);
  },

  header(cond, ctx) {
    const value = ctx.headers[cond.key?.toLowerCase()];
    return testValue(value, cond.match);
  },

  extension(cond, ctx) {
    const dot = ctx.pathname.lastIndexOf('.');
    const ext = dot >= 0 ? ctx.pathname.slice(dot) : '';
    return testValue(ext, cond.match);
  },

  always() { return true; },
  never()  { return false; },
};

// ── Rule normaliser ───────────────────────────────────────────────────────────

function normaliseRule(raw) {
  // Simple format: { match, overrides }
  if (raw.match !== undefined && raw.conditions === undefined) {
    return {
      conditions: [{ type: 'path', match: raw.match }],
      operator:   'AND',
      overrides:  raw.overrides ?? {},
      label:      raw.label,
    };
  }

  // Rich format
  const conditions = Array.isArray(raw.conditions)
    ? raw.conditions
    : [raw.conditions];

  return {
    conditions,
    operator:  (raw.operator ?? 'AND').toUpperCase(),
    overrides: raw.overrides ?? {},
    label:     raw.label,
  };
}

// ── Request context builder ───────────────────────────────────────────────────

function buildContext(req) {
  // req may be a real Express request OR a plain object from diagnose.js
  const url      = req.url ?? '/';
  const parsed   = new URL(url, 'http://x');   // base only used for parsing
  return {
    pathname: req.path ?? parsed.pathname,
    rawQuery: parsed.search,
    query:    parsed.searchParams,
    method:   (req.method ?? 'GET').toUpperCase(),
    headers:  req.headers ?? {},
  };
}

// ── Rule evaluation ───────────────────────────────────────────────────────────

function ruleMatches(rule, ctx) {
  const { conditions, operator } = rule;

  if (operator === 'OR') {
    return conditions.some(cond => {
      const tester = conditionTesters[cond.type ?? 'path'];
      return tester ? tester(cond, ctx) : false;
    });
  }

  // AND (default)
  return conditions.every(cond => {
    const tester = conditionTesters[cond.type ?? 'path'];
    return tester ? tester(cond, ctx) : false;
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve the effective injection flags for a request.
 *
 * @param {object} req — Express request OR { path, method, headers, url }
 * @returns {{ ieShim: boolean, activexMock: boolean, compatCss: boolean }}
 */
export function resolveFlags(req) {
  const base       = { ...config.injections };
  const ctx        = buildContext(req);
  const rules      = (config.rules ?? []).map(normaliseRule);
  const firstMatch = config.rulesMode === 'first';

  for (const rule of rules) {
    if (ruleMatches(rule, ctx)) {
      if (rule.label) {
        console.debug(`[rules] matched: "${rule.label}" for ${ctx.method} ${ctx.pathname}`);
      }
      Object.assign(base, rule.overrides);
      if (firstMatch) break;
    }
  }

  return base;
}

/**
 * List all rules with their match status for a given request context.
 * Used by the diagnose tool.
 */
export function explainRules(req) {
  const ctx   = buildContext(req);
  const rules = (config.rules ?? []).map(normaliseRule);
  return rules.map((rule, i) => ({
    index:   i,
    label:   rule.label ?? `rule[${i}]`,
    matched: ruleMatches(rule, ctx),
    overrides: rule.overrides,
  }));
}
