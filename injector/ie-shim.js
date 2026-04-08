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
      // Expose elements by id as window globals (IE named-access behaviour).
      var allEls = document.querySelectorAll('[id]');
      for (var i = 0; i < allEls.length; i++) {
        var eid = allEls[i].id;
        if (eid && /^\w+$/.test(eid) && window[eid] == null) {
          try { window[eid] = allEls[i]; } catch (_) {}
        }
      }
      // Also expose named inputs/selects that have no id (IE also tracked these as
      // window globals, e.g. <input name="depJen"> → window.depJen).
      var namedEls = document.querySelectorAll('input[name],select[name],textarea[name]');
      for (var j = 0; j < namedEls.length; j++) {
        var nm = namedEls[j].name;
        if (nm && /^\w+$/.test(nm) && !namedEls[j].id && window[nm] == null) {
          try { window[nm] = namedEls[j]; } catch (_) {}
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
  // HTML5 browsers foster <form> elements out of <table>/<tr>, orphaning their
  // inputs.  The server-side injector (inject.js Step 3c) pre-marks every input
  // with data-form-id before the browser parses the page.  We use that
  // attribute here to restore the correct form associations without any
  // fragile positional guesswork.
  document.addEventListener('DOMContentLoaded', function fixOrphanedFormInputs() {
    try {
      var linked = 0;
      document.querySelectorAll(
        'input[data-form-id], select[data-form-id], textarea[data-form-id]'
      ).forEach(function (el) {
        if (!el.form) {
          el.setAttribute('form', el.getAttribute('data-form-id'));
          linked++;
        }
      });
      if (linked) console.info('[ie-shim] re-linked ' + linked + ' fostered inputs via data-form-id');
    } catch (_) {}
  });

  // ── IE navigation / dialog globals ──────────────────────────────────────────
  // window.navigate(url) is IE-only; classic ASP often uses it for redirects.
  if (!window.navigate) {
    window.navigate = function (url) { window.location.href = url; };
  }
  // window.showModalDialog — IE synchronous modal dialog.
  // Chrome dropped this API.  We open a popup and wire up a postMessage bridge
  // so that when the dialog page sets window.returnValue and calls window.close(),
  // the value is delivered back to the opener via a 'message' event.
  //
  // NOTE: Because JS is single-threaded we cannot block the caller synchronously,
  // so showModalDialog returns undefined immediately.  For the multi-result case
  // (where the caller tries to parse the return value) the form fields won't
  // auto-fill; users should instead type enough to get a single match.
  // The single-result path (most common) works fully via the XMLHTTP shim.
  if (typeof window.showModalDialog !== 'function') {
    var _smd = function showModalDialog(url, arg, features) {
      // Parse IE dialogWidth / dialogHeight feature string → Chrome features
      var w = 600, h = 400;
      if (typeof features === 'string') {
        var wm = /dialogwidth\s*[:=]\s*(\d+)/i.exec(features);
        var hm = /dialogheight\s*[:=]\s*(\d+)/i.exec(features);
        if (wm) w = parseInt(wm[1], 10);
        if (hm) h = parseInt(hm[1], 10);
      }
      var left = Math.max(0, Math.round((screen.width  - w) / 2));
      var top  = Math.max(0, Math.round((screen.height - h) / 2));
      window.open(url, '_ieModalDialog',
        'width=' + w + ',height=' + h +
        ',left=' + left + ',top=' + top +
        ',toolbar=no,location=no,directories=no,status=no' +
        ',menubar=no,scrollbars=yes,resizable=yes');
      // Can't return synchronously — async result handled via the message event.
      return undefined;
    };
    // Lock with Object.defineProperty so ASP.NET AJAX (ScriptResource.axd) and
    // other scripts that reset window.showModalDialog = null/undefined cannot
    // clobber this polyfill after it has been installed.
    try {
      Object.defineProperty(window, 'showModalDialog', {
        value: _smd, writable: false, configurable: false, enumerable: true,
      });
    } catch (_) {
      window.showModalDialog = _smd;
    }

    // When the dialog calls window.returnValue = x; window.close(), our injected
    // close-override (see inject.js) postMessages the returnValue here.
    // Handlers can set window.__onModalDialogReturn = function(xmlStr) { … };
    window.addEventListener('message', function (e) {
      if (!e.data || e.data.__type !== '__ieModalReturn') return;
      var retVal = e.data.value;
      console.info('[ie-shim] showModalDialog return value received');
      if (typeof window.__onModalDialogReturn === 'function') {
        window.__onModalDialogReturn(retVal);
        window.__onModalDialogReturn = null;
      }
    });
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
