/**
 * activex-mock.js
 * Stubs out IE-only ActiveX / COM / shell objects so legacy pages don't
 * throw on object creation.  Real functionality is NOT implemented —
 * the goal is silent no-ops that prevent crashes, not full emulation.
 */
(function () {
  'use strict';

  // ── ActiveXObject ────────────────────────────────────────────────────────────
  if (!window.ActiveXObject) {
    window.ActiveXObject = function ActiveXObject(progId) {
      console.warn('[activex-mock] ActiveXObject requested:', progId);

      // XMLHTTP — return a minimal fetch-based shim so data loads may still work
      if (/XMLHTTP|Msxml2\.XMLHTTP|Microsoft\.XMLHTTP/i.test(progId)) {
        return buildXmlHttpShim();
      }

      // XMLDOM
      if (/XMLDOM|DOMDocument/i.test(progId)) {
        return buildXmlDomShim();
      }

      // Scripting.FileSystemObject, Shell.Application, WScript, etc. — no-op
      return buildNoopShim(progId);
    };
  }

  function buildXmlHttpShim() {
    var _method, _url, _async, _headers = {}, _onreadystatechange;
    var shim = {
      readyState: 0,
      status: 0,
      statusText: '',
      responseText: '',
      responseXML: null,
      onreadystatechange: null,

      open: function (method, url, async) {
        _method = method; _url = url; _async = (async !== false);
        shim.readyState = 1;
      },
      setRequestHeader: function (name, value) { _headers[name] = value; },
      getResponseHeader: function () { return null; },
      getAllResponseHeaders: function () { return ''; },
      abort: function () {},

      send: function (body) {
        var opts = { method: _method, headers: _headers };
        if (body && _method !== 'GET') opts.body = body;

        fetch(_url, opts)
          .then(function (r) {
            shim.status = r.status;
            shim.statusText = r.statusText;
            shim.readyState = 4;
            return r.text();
          })
          .then(function (text) {
            shim.responseText = text;
            if (typeof shim.onreadystatechange === 'function') shim.onreadystatechange();
          })
          .catch(function (err) {
            console.warn('[activex-mock] XmlHttp fetch failed:', err.message);
            shim.readyState = 4;
            shim.status = 0;
            if (typeof shim.onreadystatechange === 'function') shim.onreadystatechange();
          });
      },
    };
    return shim;
  }

  function buildXmlDomShim() {
    return {
      async: true,
      parseError: { errorCode: 0 },
      loadXML: function (str) {
        var parser = new DOMParser();
        this._doc = parser.parseFromString(str, 'text/xml');
        this.documentElement = this._doc.documentElement;
      },
      selectNodes: function (xpath) {
        if (!this._doc) return [];
        var result = this._doc.evaluate(xpath, this._doc, null, XPathResult.ANY_TYPE, null);
        var nodes = [], n;
        while ((n = result.iterateNext())) nodes.push(n);
        return nodes;
      },
      selectSingleNode: function (xpath) {
        var nodes = this.selectNodes(xpath);
        return nodes[0] || null;
      },
    };
  }

  function buildNoopShim(progId) {
    return new Proxy({}, {
      get: function (_, prop) {
        return function () {
          console.warn('[activex-mock] Noop call on', progId, '.', prop);
        };
      },
    });
  }

  // ── window.external ──────────────────────────────────────────────────────────
  // IE exposed browser shell helpers here; modern browsers removed most of them.
  if (!window.external || typeof window.external.AddFavorite === 'undefined') {
    try {
      Object.defineProperty(window, 'external', {
        value: Object.assign(window.external || {}, {
          AddFavorite: function () {},
          IsSubscribed: function () { return false; },
          NavigateAndFind: function () {},
          msIsSiteMode: function () { return false; },
          msAddSiteMode: function () {},
          msSiteModeActivate: function () {},
          msSiteModeClearBadge: function () {},
          msSiteModeClearJumpList: function () {},
          msSiteModeCreateJumpList: function () {},
          msSiteModeAddJumpListItem: function () {},
          msSiteModeShowJumpList: function () {},
          AutoCompleteSaveForm: function () {},
          AutoScan: function () {},
        }),
        writable: true,
        configurable: true,
      });
    } catch (_) {
      // window.external is read-only in some environments — skip silently
    }
  }

  // ── CollectGarbage ───────────────────────────────────────────────────────────
  if (!window.CollectGarbage) {
    window.CollectGarbage = function () {};
  }

  // ── execScript ───────────────────────────────────────────────────────────────
  // execScript was IE's eval equivalent; mirror to eval for read-only legacy callers.
  // NOTE: avoid this if you can — it is retained only for strict compatibility.
  if (!window.execScript) {
    window.execScript = function (code) {
      console.warn('[activex-mock] execScript called — delegating to eval.');
      // eslint-disable-next-line no-eval
      eval(code); // intentional; mirrors IE behaviour for legacy callers only
    };
  }

  console.info('[activex-mock] ActiveX / COM stubs applied.');
}());
