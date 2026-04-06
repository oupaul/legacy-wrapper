/**
 * ie-shim.js
 * Restores IE-era globals that modern browsers removed.
 * Safe to run in Edge/Chrome — all additions are guarded.
 */
(function () {
  'use strict';

  // ── document.all ────────────────────────────────────────────────────────────
  // IE exposed every element via document.all[id].
  // Modern browsers dropped it; some legacy scripts test `if (document.all)`.
  if (!document.all) {
    try {
      Object.defineProperty(document, 'all', {
        get: function () { return document.getElementsByTagName('*'); },
        configurable: true,
      });
    } catch (_) {
      document.all = document.getElementsByTagName('*');
    }
  }

  // ── attachEvent / detachEvent ────────────────────────────────────────────────
  if (!window.attachEvent) {
    window.attachEvent = function (ieEvent, handler) {
      var domEvent = ieEvent.replace(/^on/, '');
      document.addEventListener(domEvent, handler);
    };
    window.detachEvent = function (ieEvent, handler) {
      var domEvent = ieEvent.replace(/^on/, '');
      document.removeEventListener(domEvent, handler);
    };
  }

  // ── Element-level attachEvent ────────────────────────────────────────────────
  if (window.Element && !Element.prototype.attachEvent) {
    Element.prototype.attachEvent = function (ieEvent, handler) {
      this.addEventListener(ieEvent.replace(/^on/, ''), handler);
    };
    Element.prototype.detachEvent = function (ieEvent, handler) {
      this.removeEventListener(ieEvent.replace(/^on/, ''), handler);
    };
  }

  // ── window.event / event.srcElement ─────────────────────────────────────────
  // IE made the current event available as window.event and used srcElement
  // instead of target. Patch via a capturing listener that keeps window.event
  // in sync and aliases srcElement on every event object.
  (function patchWindowEvent() {
    var _event = null;
    Object.defineProperty(window, 'event', {
      get: function () { return _event; },
      set: function (v) { _event = v; },
      configurable: true,
    });
    document.addEventListener('click',      syncEvent, true);
    document.addEventListener('mousedown',  syncEvent, true);
    document.addEventListener('mouseup',    syncEvent, true);
    document.addEventListener('keydown',    syncEvent, true);
    document.addEventListener('keyup',      syncEvent, true);
    document.addEventListener('keypress',   syncEvent, true);
    document.addEventListener('submit',     syncEvent, true);
    document.addEventListener('change',     syncEvent, true);
    document.addEventListener('focus',      syncEvent, true);
    document.addEventListener('blur',       syncEvent, true);

    function syncEvent(e) {
      if (!e.srcElement) {
        try { Object.defineProperty(e, 'srcElement', { get: function () { return e.target; } }); }
        catch (_) { /* read-only in some browsers */ }
      }
      if (!e.returnValue) {
        try {
          Object.defineProperty(e, 'returnValue', {
            get: function () { return !e.defaultPrevented; },
            set: function (v) { if (!v) e.preventDefault(); },
          });
        } catch (_) {}
      }
      _event = e;
    }
  }());

  // ── document.createElement default namespace ─────────────────────────────────
  // Some IE code passes "tag" as uppercase; normalize silently.
  (function patchCreateElement() {
    var orig = document.createElement.bind(document);
    document.createElement = function (tag) {
      return orig(typeof tag === 'string' ? tag.toLowerCase() : tag);
    };
  }());

  // ── String.prototype extensions IE scripts sometimes rely on ─────────────────
  if (!String.prototype.trim) {
    String.prototype.trim = function () { return this.replace(/^\s+|\s+$/g, ''); };
  }

  // ── Array.prototype extensions ───────────────────────────────────────────────
  if (!Array.prototype.indexOf) {
    Array.prototype.indexOf = function (item) {
      for (var i = 0; i < this.length; i++) { if (this[i] === item) return i; }
      return -1;
    };
  }

  // ── Image submit button coordinate fix ──────────────────────────────────────
  // Legacy servers (e.g. classic ASP) check OK.x > 0 before processing login.
  // When the button image is missing/tiny (1×1 fallback GIF), the browser
  // reports click coordinates (0, 0), causing the server to reject the login.
  //
  // Fix: intercept clicks on <input type="image">, calculate real coordinates,
  // ensure they are at least 1, inject as hidden fields, then submit the form.
  (function patchImageSubmitCoords() {
    document.addEventListener('click', function (e) {
      var btn = e.target;
      // Walk up in case the click landed on a child of the button
      while (btn && btn !== document) {
        if (btn.nodeName === 'INPUT' && btn.type === 'image' && btn.form) break;
        btn = btn.parentNode;
      }
      if (!btn || !btn.form) return;

      // If the button has an onclick handler (e.g. transpiled VBScript),
      // let that handler set form.action/method and call form.submit() itself.
      // We must not preventDefault here or we'd swallow the onclick entirely.
      if (btn.getAttribute && btn.getAttribute('onclick')) return;

      var rect = btn.getBoundingClientRect();
      var x    = Math.round(e.clientX - rect.left);
      var y    = Math.round(e.clientY - rect.top);

      // If coordinates are 0 (missing/tiny image), use sensible defaults
      if (x < 1) x = Math.max(1, Math.round(rect.width  / 2)) || 30;
      if (y < 1) y = Math.max(1, Math.round(rect.height / 2)) || 15;

      e.preventDefault(); // stop browser from appending its own 0,0 coords

      var name = btn.name || 'OK';
      ['x', 'y'].forEach(function (axis) {
        var sel = 'input[type="hidden"][name="' + name + '.' + axis + '"]';
        var hidden = btn.form.querySelector(sel);
        if (!hidden) {
          hidden = document.createElement('input');
          hidden.type = 'hidden';
          hidden.name = name + '.' + axis;
          btn.form.appendChild(hidden);
        }
        hidden.value = axis === 'x' ? x : y;
      });

      btn.form.submit();
    }, true);
  }());

  console.info('[ie-shim] IE compatibility shims applied.');
}());
