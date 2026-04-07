/**
 * activex-mock.js
 * Stubs out IE-only ActiveX / COM / shell objects so legacy pages don't
 * throw on object creation.
 *
 * Key behaviours emulated:
 *  - Microsoft.XMLHTTP  → real XMLHttpRequest (supports synchronous mode)
 *  - Microsoft.XMLDOM   → full IE IXMLDOMDocument wrapper incl. .nextNode getter,
 *                         .text property, .selectSingleNode(), .appendChild(), .xml
 */
(function () {
  'use strict';

  // ── IE XMLDOM node wrapper ────────────────────────────────────────────────────
  // IE's IXMLDOMNode exposes .text (= textContent) and .xml (serialised XML).
  // IE's IXMLDOMNodeList exposes .nextNode as a GETTER (advances internal cursor)
  // and .reset() to restart it.  Chrome's native DOM has neither.

  function makeNode(native) {
    if (!native) return null;
    var w = {
      __isIENode:  true,
      _native:     native,
      nodeName:    native.nodeName,
      nodeType:    native.nodeType,
      nodeValue:   native.nodeValue,

      get text()  { return native.textContent || ''; },
      set text(v) { native.textContent = v; },
      get xml()   {
        try { return new XMLSerializer().serializeToString(native); } catch (_) { return ''; }
      },

      get firstChild()      { return makeNode(native.firstChild); },
      get lastChild()       { return makeNode(native.lastChild); },
      get nextSibling()     { return makeNode(native.nextSibling); },
      get previousSibling() { return makeNode(native.previousSibling); },
      get parentNode()      { return makeNode(native.parentNode); },
      get childNodes()      { return makeNodeList(native.childNodes); },

      getAttribute:  function (n)    { return native.getAttribute(n); },
      setAttribute:  function (n, v) { native.setAttribute(n, v); },
      appendChild:   function (c)    {
        return native.appendChild((c && c._native) ? c._native : c);
      },
      removeChild:   function (c)    {
        return native.removeChild((c && c._native) ? c._native : c);
      },

      getElementsByTagName: function (tag) {
        return makeNodeList(native.getElementsByTagName(tag));
      },

      // IE XPath helpers (used on nodes returned from getElementsByTagName)
      selectSingleNode: function (xpath) {
        try {
          var doc = native.ownerDocument || native;
          var r = doc.evaluate(xpath, native, null,
                               XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          return makeNode(r.singleNodeValue);
        } catch (_) { return null; }
      },
      selectNodes: function (xpath) {
        try {
          var doc = native.ownerDocument || native;
          var r = doc.evaluate(xpath, native, null, XPathResult.ANY_TYPE, null);
          var nodes = [], n;
          while ((n = r.iterateNext())) nodes.push(n);
          return makeStaticNodeList(nodes);
        } catch (_) { return makeStaticNodeList([]); }
      },
    };
    return w;
  }

  // makeNodeList wraps a live DOM NodeList.
  // .nextNode is a GETTER that advances the cursor (IE IXMLDOMNodeList semantics).
  function makeNodeList(nativeList) {
    var cursor = 0;
    var obj = {
      length: nativeList.length,
      item:  function (i) { return makeNode(nativeList.item(i)); },
      reset: function ()  { cursor = 0; },
    };
    Object.defineProperty(obj, 'nextNode', {
      get: function () {
        return cursor < nativeList.length ? makeNode(nativeList.item(cursor++)) : null;
      },
      configurable: true,
    });
    return obj;
  }

  // makeStaticNodeList wraps an Array of native nodes (from XPath results).
  function makeStaticNodeList(arr) {
    var cursor = 0;
    var obj = {
      length: arr.length,
      item:  function (i) { return makeNode(arr[i]); },
      reset: function ()  { cursor = 0; },
    };
    Object.defineProperty(obj, 'nextNode', {
      get: function () {
        return cursor < arr.length ? makeNode(arr[cursor++]) : null;
      },
      configurable: true,
    });
    return obj;
  }

  // ── IE XMLDOM document wrapper ────────────────────────────────────────────────
  // Wraps (or creates) a native XML Document and adds the IE-specific surface:
  //   .loadXML(str), .xml, .createElement(), .appendChild(), .getElementsByTagName(),
  //   .selectNodes(), .selectSingleNode(), .parseError
  function makeXmlDoc(initialDoc) {
    // Create a real empty XML document so createElement / appendChild work.
    // Use null/null (not empty strings) to avoid InvalidCharacterError in strict parsers.
    var doc = initialDoc || document.implementation.createDocument(null, null, null);

    var wrapper = {
      __isIEXMLDOM: true,

      get _nativeDoc() { return doc; },

      parseError: { errorCode: 0, reason: '' },
      async: false,

      get documentElement() {
        return doc.documentElement ? makeNode(doc.documentElement) : null;
      },

      get xml() {
        try { return doc ? new XMLSerializer().serializeToString(doc) : ''; }
        catch (_) { return ''; }
      },

      loadXML: function (str) {
        var parser = new DOMParser();
        doc = parser.parseFromString(
          (str === undefined || str === null) ? '<_empty/>' : String(str),
          'text/xml'
        );
        var ep = doc.querySelector('parsererror');
        wrapper.parseError = {
          errorCode: ep ? 1 : 0,
          reason:    ep ? ep.textContent : '',
        };
      },

      createElement:  function (tag)  { return doc ? makeNode(doc.createElement(tag)) : null; },
      createTextNode: function (text) { return doc ? makeNode(doc.createTextNode(text)) : null; },

      appendChild: function (child) {
        if (!doc) return null;
        return doc.appendChild((child && child._native) ? child._native : child);
      },

      getElementsByTagName: function (tag) {
        return doc ? makeNodeList(doc.getElementsByTagName(tag))
                   : makeStaticNodeList([]);
      },

      selectNodes: function (xpath) {
        if (!doc) return makeStaticNodeList([]);
        try {
          var r = doc.evaluate(xpath, doc, null, XPathResult.ANY_TYPE, null);
          var nodes = [], n;
          while ((n = r.iterateNext())) nodes.push(n);
          return makeStaticNodeList(nodes);
        } catch (_) { return makeStaticNodeList([]); }
      },

      selectSingleNode: function (xpath) {
        if (!doc) return null;
        try {
          var r = doc.evaluate(xpath, doc, null,
                               XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          return makeNode(r.singleNodeValue);
        } catch (_) { return null; }
      },
    };
    return wrapper;
  }

  // ── ActiveXObject ─────────────────────────────────────────────────────────────
  if (!window.ActiveXObject) {
    window.ActiveXObject = function ActiveXObject(progId) {
      console.warn('[activex-mock] ActiveXObject requested:', progId);

      if (/XMLHTTP|Msxml2\.XMLHTTP|Microsoft\.XMLHTTP/i.test(progId)) {
        return buildXmlHttpShim();
      }
      if (/XMLDOM|DOMDocument/i.test(progId)) {
        return makeXmlDoc(null);
      }
      // Scripting.FileSystemObject, Shell.Application, etc. — no-op proxy
      return buildNoopShim(progId);
    };
  }

  // ── XMLHTTP shim backed by real XMLHttpRequest ────────────────────────────────
  // Using real XHR (not fetch) so synchronous mode (async=false) works correctly:
  // legacy code calls Open("POST", url, false) then reads responseText/responseXML
  // immediately after Send() — this only works with true synchronous XHR.
  function buildXmlHttpShim() {
    var xhr = new XMLHttpRequest();

    var shim = {
      get readyState()   { return xhr.readyState; },
      get status()       { return xhr.status; },
      get statusText()   { return xhr.statusText; },
      get responseText() { return xhr.responseText || ''; },
      get responseXML()  {
        // Try the native responseXML first; fall back to parsing responseText.
        var nativeDoc = xhr.responseXML;
        if (!nativeDoc && xhr.responseText) {
          try {
            nativeDoc = new DOMParser().parseFromString(xhr.responseText, 'text/xml');
          } catch (_) {}
        }
        return nativeDoc ? makeXmlDoc(nativeDoc) : null;
      },
      onreadystatechange: null,

      open: function (method, url, async) {
        xhr.open(method, url, async !== false);   // false → synchronous
        xhr.onreadystatechange = function () {
          if (typeof shim.onreadystatechange === 'function') shim.onreadystatechange();
        };
      },
      setRequestHeader: function (n, v) {
        try { xhr.setRequestHeader(n, v); } catch (_) {}
      },
      getResponseHeader:    function (n) { return xhr.getResponseHeader(n); },
      getAllResponseHeaders: function ()  { return xhr.getAllResponseHeaders() || ''; },
      abort:                function ()   { xhr.abort(); },

      send: function (body) {
        var toSend = body;

        // If body is our XMLDOM wrapper, serialise to XML string.
        if (body && typeof body === 'object' && body.__isIEXMLDOM) {
          try { toSend = body.xml; } catch (_) {}
        }
        // If body is one of our wrapped nodes, serialise the underlying node.
        if (body && typeof body === 'object' && body.__isIENode && body._native) {
          try {
            toSend = new XMLSerializer().serializeToString(body._native);
          } catch (_) {}
        }

        xhr.send(toSend !== undefined ? toSend : null);
      },
    };
    return shim;
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
  if (!window.external || typeof window.external.AddFavorite === 'undefined') {
    try {
      Object.defineProperty(window, 'external', {
        value: Object.assign(window.external || {}, {
          AddFavorite:             function () {},
          IsSubscribed:            function () { return false; },
          NavigateAndFind:         function () {},
          msIsSiteMode:            function () { return false; },
          msAddSiteMode:           function () {},
          msSiteModeActivate:      function () {},
          msSiteModeClearBadge:    function () {},
          msSiteModeClearJumpList: function () {},
          msSiteModeCreateJumpList:    function () {},
          msSiteModeAddJumpListItem:   function () {},
          msSiteModeShowJumpList:      function () {},
          AutoCompleteSaveForm:    function () {},
          AutoScan:                function () {},
        }),
        writable: true,
        configurable: true,
      });
    } catch (_) {}
  }

  if (!window.CollectGarbage) { window.CollectGarbage = function () {}; }

  if (!window.execScript) {
    window.execScript = function (code) {
      console.warn('[activex-mock] execScript called — delegating to eval.');
      // eslint-disable-next-line no-eval
      eval(code);
    };
  }

  console.info('[activex-mock] ActiveX / COM stubs applied.');
}());
