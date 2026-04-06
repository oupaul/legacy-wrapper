/**
 * ie-shim.js
 * Restores IE-era globals that modern browsers removed.
 * Safe to run in Edge/Chrome — all additions are guarded.
 */
(function () {
  'use strict';

  // ── Navigator MSIE spoofing ──────────────────────────────────────────────────
  // Classic ASP toolbars gate all init behind:
  //   if (navigator.userAgent.indexOf("MSIE") != -1 && navigator.userAgent.indexOf("Windows") != -1 ...)
  // Chrome/Edge fail this check → ToolBar_Supported stays false → menu vars never init.
  //
  // We spoof the UA so the check passes and the legacy script sets its own flag.
  // We also add "Windows" for non-Windows clients (Mac/Linux) so both conditions pass.
  (function () {
    var ua = navigator.userAgent;
    if (ua.indexOf('MSIE') === -1) {
      var fakeUa = ua + '; compatible; MSIE 11.0';
      if (ua.indexOf('Windows') === -1) fakeUa += '; Windows NT 10.0';
      try {
        Object.defineProperty(navigator, 'userAgent', {
          get: function () { return fakeUa; },
          configurable: true,
        });
      } catch (_) { /* some browsers don't allow overriding navigator.userAgent */ }
    }
  }());

  // ── document.all ────────────────────────────────────────────────────────────
  // Chrome/Edge already ship document.all as a special falsy HTMLAllCollection
  // that supports named access: document.all['divId'] returns the element.
  // IMPORTANT: do NOT override it — our simple shim breaks named access.
  // Only install a shim if document.all is completely absent (shouldn't happen).
  if (document.all === undefined) {
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
    var _evTypes = [
      'click','mousedown','mouseup','mouseover','mouseout','mousemove',
      'keydown','keyup','keypress','submit','change','focus','blur',
    ];
    for (var _i = 0; _i < _evTypes.length; _i++) {
      document.addEventListener(_evTypes[_i], syncEvent, true);
    }

    function syncEvent(e) {
      // srcElement → target (Chrome has this natively, but guard just in case)
      if (e.srcElement === undefined) {
        try { Object.defineProperty(e, 'srcElement', { get: function () { return e.target; }, configurable: true }); }
        catch (_) {}
      }
      // returnValue: false = preventDefault.
      // Only define when not already a native accessor to avoid recursion.
      if (typeof e.returnValue === 'undefined') {
        try {
          Object.defineProperty(e, 'returnValue', {
            get: function () { return !e.defaultPrevented; },
            set: function (v) { if (!v) e.preventDefault(); },
            configurable: true,
          });
        } catch (_) {}
      }
      // cancelBubble: Chrome exposes this natively (setter calls stopPropagation).
      // Do NOT redefine it — a custom getter that reads e.cancelBubble causes
      // infinite recursion and crashes the page.
      _event = e;
    }
  }());

  // ── document.all.tags / document.all.item ────────────────────────────────────
  // IE's HTMLAllCollection had .tags(tagName) and multi-index .item(id, n).
  // Chrome's HTMLAllCollection lacks .tags() entirely.
  // _toolbar.js calls document.all.tags("SELECT") inside showElement/hideElement.
  // Without this polyfill, doMenu() throws and submenus never open.
  (function patchDocumentAllTags() {
    try {
      if (typeof HTMLAllCollection !== 'undefined') {
        if (!HTMLAllCollection.prototype.tags) {
          HTMLAllCollection.prototype.tags = function (tagName) {
            return document.getElementsByTagName(tagName);
          };
        }
        // .item(id, subIndex): IE returns the nth element matching that id/name.
        var _origItem = HTMLAllCollection.prototype.item;
        if (_origItem) {
          HTMLAllCollection.prototype.item = function (nameOrIdx, subIdx) {
            if (subIdx === undefined || subIdx === null) {
              return _origItem.call(this, nameOrIdx);
            }
            var matches = document.querySelectorAll(
              '[id="' + nameOrIdx + '"],[name="' + nameOrIdx + '"]'
            );
            return matches[subIdx] || null;
          };
        }
      }
    } catch (_) {}
  }());

  // ── IE element-ID global variable fix ────────────────────────────────────────
  // IE automatically exposes element IDs as window globals.
  // When a script declares  var StartMenu;  (undefined), Chrome's named-access
  // for the element with id="StartMenu" is shadowed by the var declaration.
  //
  // Classic ASP toolbar pattern:
  //   var StartMenu;                       ← declares undefined window.StartMenu
  //   document.write("<SPAN ID='StartMenu'...");  ← element exists in DOM
  //   var ToolbarMenu = StartMenu;         ← StartMenu still undefined!
  //   → doMenu(): ToolbarMenu == null → return false → submenus never open
  //
  // Fix: on DOMContentLoaded, assign any window var that is null/undefined AND
  // has a matching element ID.  Also explicitly re-fix ToolbarMenu.
  document.addEventListener('DOMContentLoaded', function fixElementIdGlobals() {
    try {
      var allEls = document.querySelectorAll('[id]');
      for (var i = 0; i < allEls.length; i++) {
        var eid = allEls[i].id;
        if (eid && /^\w+$/.test(eid) && window[eid] == null) {
          try { window[eid] = allEls[i]; } catch (_) {}
        }
      }
      // ToolbarMenu was set to StartMenu *before* the element existed.
      // Re-assign now that StartMenu is fixed above.
      if (typeof window.ToolbarMenu !== 'undefined' && window.ToolbarMenu == null) {
        var sm = document.getElementById('StartMenu');
        if (sm) window.ToolbarMenu = sm;
      }
    } catch (_) {}
  });

  // ── CSSStyleDeclaration: numeric pixel assignments ────────────────────────────
  // IE accepted  element.style.left = 100  (bare number → implied px).
  // Chrome silently ignores non-string assignments to layout properties.
  // Also add IE-specific posLeft/posTop/posWidth/posHeight/pixelLeft/... accessors.
  (function patchCssStyleDeclaration() {
    try {
      var _proto = CSSStyleDeclaration.prototype;
      var _pixelProps = [
        'left','top','right','bottom','width','height',
        'marginTop','marginLeft','marginRight','marginBottom',
        'paddingTop','paddingLeft','paddingRight','paddingBottom',
      ];
      _pixelProps.forEach(function (prop) {
        var desc = Object.getOwnPropertyDescriptor(_proto, prop);
        if (!desc || !desc.set) return;
        Object.defineProperty(_proto, prop, {
          get: desc.get,
          set: function (v) { desc.set.call(this, typeof v === 'number' ? v + 'px' : v); },
          configurable: true,
        });
      });
      // pos* and pixel* accessors (IE: get/set layout values as plain numbers)
      ['Left','Top','Right','Bottom','Width','Height'].forEach(function (cap) {
        var lc = cap.toLowerCase();
        ['pos' + cap, 'pixel' + cap].forEach(function (alias) {
          Object.defineProperty(_proto, alias, {
            get:  function () { return parseFloat(this[lc]) || 0; },
            set:  function (v) { this[lc] = v + 'px'; },
            configurable: true,
          });
        });
      });
    } catch (_) {}
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

  // ── Form-in-table foster fix ─────────────────────────────────────────────────
  // Classic ASP/IE pages placed <form> tags directly inside <tbody>/<tr>.
  // IE accepted this; modern HTML5 parsers "foster" those forms outside the
  // table, making them empty while leaving the original <input> elements
  // orphaned (no form association). Clicking a submit button does nothing.
  //
  // Fix: on DOMContentLoaded, pair each empty form with the TR that contains
  // orphaned inputs (matched by document order) and assign the HTML5 form=
  // attribute so the browser correctly associates them.
  document.addEventListener('DOMContentLoaded', function fixOrphanedFormInputs() {
    try {
      // Fostered forms: empty (no associated elements) and have an id
      var emptyForms = Array.from(document.forms).filter(function (f) {
        return f.elements.length === 0 && f.id;
      });
      if (!emptyForms.length) return;

      // TRs that contain inputs/selects not associated with any form
      var orphanedTrs = [];
      document.querySelectorAll('tr').forEach(function (tr) {
        var orphans = Array.from(tr.querySelectorAll('input, select, textarea'))
          .filter(function (el) { return !el.form; });
        if (orphans.length) orphanedTrs.push({ tr: tr, orphans: orphans });
      });

      // Match Nth empty form → Nth orphaned TR (document order)
      emptyForms.forEach(function (form, i) {
        var entry = orphanedTrs[i];
        if (!entry) return;
        entry.orphans.forEach(function (el) {
          el.setAttribute('form', form.id);
        });
        console.info('[ie-shim] linked ' + entry.orphans.length +
                     ' inputs to form#' + form.id);
      });
    } catch (_) {}
  });

  // ── IE navigation / dialog globals ──────────────────────────────────────────
  // window.navigate(url) is IE-only; classic ASP often uses it for redirects.
  if (!window.navigate) {
    window.navigate = function (url) { window.location.href = url; };
  }
  // window.showModalDialog — used by some legacy dialogs; open as popup fallback.
  if (!window.showModalDialog) {
    window.showModalDialog = function (url, arg, features) {
      return window.open(url, '_blank', 'width=600,height=400');
    };
  }
  // document.frames — IE alias for window.frames
  if (!document.frames) {
    try { document.frames = window.frames; } catch (_) {}
  }
  // CollectGarbage — IE GC hint; safe no-op
  if (!window.CollectGarbage) {
    window.CollectGarbage = function () {};
  }
  // window.clipboardData — IE clipboard; return stub so code doesn't throw
  if (!window.clipboardData) {
    window.clipboardData = {
      getData:    function () { return ''; },
      setData:    function () { return false; },
      clearData:  function () {},
    };
  }
  // ScriptEngineMajorVersion / ScriptEngineMinorVersion — IE/JScript version checks
  if (!window.ScriptEngineMajorVersion) {
    window.ScriptEngineMajorVersion = function () { return 5; };
    window.ScriptEngineMinorVersion = function () { return 8; };
    window.ScriptEngineBuildVersion = function () { return 0; };
    window.ScriptEngine             = function () { return 'JScript'; };
  }

  console.info('[ie-shim] IE compatibility shims applied.');
}());
