/**
 * Script injected as the very first thing into every iBooks widget page (see vfs.js).
 *
 *  - gives the widget the `window.widget` host object the iBooks runtime provides. The real AppleWidget.js ends in
 *    `var widget = new AppleWidgetController()` and its notify*() methods navigate to `apb:///...`, which would
 *    kill the frame (or, in the Android shell, fire an external intent): the accessor below swallows that assignment
 *    and the same methods are neutralised on the prototype as well as through the Navigation API.
 *  - mutes audio while the widget is shown inline next to the playing audiobook: media elements are forced muted,
 *    AudioContexts are suspended and cannot reach their destination. `{abs:'mute', value:false}` lifts it.
 *  - forwards Back/Escape to the reader, reports the stage size.
 *
 * Written as plain ES5 inside a string so it is injected verbatim (no bundler transforms).
 */
export const WIDGET_SHIM_SOURCE = String.raw`
(function () {
  if (window.__absShim) return;
  window.__absShim = true;
  var MUTED = /[?&]abs=muted/.test(location.search);
  var noop = function () {};
  var host = { __abs: true, identifier: 'abs-widget' };
  ['notifyContentLoaded', 'notifyContentIsReady', 'notifyContentExited', 'notifyContentPropertyChanged',
   'notifyContentAutoplayInterrupted', 'notifyNavigationButtonsChanged', 'registerObject', 'unregisterObject',
   'browserInvoke', 'openURL', 'setPreferenceForKey', 'prepareForTransition', 'performTransition', 'close'
  ].forEach(function (n) { host[n] = noop; });
  host.preferenceForKey = function () { return undefined; };
  try {
    Object.defineProperty(window, 'widget', { configurable: true, get: function () { return host; }, set: function () {} });
  } catch (e) {}

  function isHostUrl(u) { return /^(apb|ibooks|javascript|itms-books):/i.test(String(u || '')); }
  try {
    if (window.navigation && window.navigation.addEventListener) {
      window.navigation.addEventListener('navigate', function (e) {
        if (e.destination && isHostUrl(e.destination.url) && e.cancelable) e.preventDefault();
      });
    }
  } catch (e) {}
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (a && isHostUrl(a.getAttribute('href'))) e.preventDefault();
  }, true);
  document.addEventListener('DOMContentLoaded', function () {
    try {
      var proto = window.AppleWidgetController && window.AppleWidgetController.prototype;
      if (proto) Object.keys(proto).forEach(function (k) { if (/^notify/.test(k)) proto[k] = noop; });
    } catch (e) {}
  });

  // ---- media / WebAudio muting ----
  var mediaProto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
  var mutedDesc = mediaProto && Object.getOwnPropertyDescriptor(mediaProto, 'muted');
  function muteEl(el) { try { if (mutedDesc) mutedDesc.set.call(el, true); } catch (e) {} }
  var contexts = [];
  var origConnect = window.AudioNode && window.AudioNode.prototype.connect;
  if (mediaProto && mutedDesc) {
    var origPlay = mediaProto.play;
    mediaProto.play = function () { if (MUTED) muteEl(this); return origPlay.apply(this, arguments); };
    Object.defineProperty(mediaProto, 'muted', {
      configurable: true,
      get: function () { return MUTED ? true : mutedDesc.get.call(this); },
      set: function (v) { mutedDesc.set.call(this, MUTED ? true : v); }
    });
    var sweep = function () {
      if (!MUTED) return;
      var list = document.querySelectorAll('audio,video');
      for (var i = 0; i < list.length; i++) muteEl(list[i]);
    };
    document.addEventListener('play', function (e) { if (MUTED) muteEl(e.target); }, true);
    document.addEventListener('loadstart', function (e) { if (MUTED) muteEl(e.target); }, true);
    try { new MutationObserver(sweep).observe(document, { childList: true, subtree: true }); } catch (e) {}
    setInterval(sweep, 500);
  }
  ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
    var Orig = window[name];
    if (!Orig) return;
    var Wrapped = function (opts) {
      var ctx = opts === undefined ? new Orig() : new Orig(opts);
      contexts.push(ctx);
      if (MUTED) { try { ctx.suspend(); } catch (e) {} }
      return ctx;
    };
    Wrapped.prototype = Orig.prototype;
    window[name] = Wrapped;
  });
  if (window.AudioContext && window.AudioContext.prototype) {
    var origResume = window.AudioContext.prototype.resume;
    window.AudioContext.prototype.resume = function () { return MUTED ? Promise.resolve() : origResume.apply(this, arguments); };
  }
  if (origConnect) {
    window.AudioNode.prototype.connect = function (dest) {
      if (MUTED && window.AudioDestinationNode && dest instanceof window.AudioDestinationNode) return dest;
      return origConnect.apply(this, arguments);
    };
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !d.abs) return;
    if (d.abs === 'mute') {
      MUTED = !!d.value;
      if (MUTED) {
        var l = document.querySelectorAll('audio,video');
        for (var i = 0; i < l.length; i++) muteEl(l[i]);
        contexts.forEach(function (c) { try { c.suspend(); } catch (x) {} });
      } else {
        // Reset the forced mute and let autoplay-blocked media / contexts start
        var m = document.querySelectorAll('audio,video');
        for (var j = 0; j < m.length; j++) { try { mutedDesc.set.call(m[j], false); if (m[j].autoplay && m[j].paused) m[j].play(); } catch (x) {} }
        contexts.forEach(function (c) { try { c.resume(); } catch (x) {} });
      }
    } else if (d.abs === 'enter') {
      try { if (typeof host.didEnterWidgetMode === 'function') host.didEnterWidgetMode(); } catch (x) {}
    } else if (d.abs === 'exit') {
      try { if (typeof host.pauseAudioVisual === 'function') host.pauseAudioVisual(); } catch (x) {}
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.key === 'GoBack' || e.keyCode === 4) {
      e.preventDefault();
      try { parent.postMessage({ abs: 'back' }, '*'); } catch (x) {}
    }
  }, true);
  window.alert = noop;
  window.confirm = function () { return false; };
  window.addEventListener('load', function () {
    try {
      var de = document.documentElement, b = document.body;
      parent.postMessage({ abs: 'loaded', w: Math.max(de.scrollWidth, b ? b.scrollWidth : 0), h: Math.max(de.scrollHeight, b ? b.scrollHeight : 0) }, '*');
    } catch (x) {}
  });
})();
`
