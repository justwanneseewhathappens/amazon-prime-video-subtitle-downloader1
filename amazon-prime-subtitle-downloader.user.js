// ==UserScript==
// @name         Amazon Prime Video Subtitle Downloader
// @namespace    https://github.com/
// @version      3.5.0
// @description  Download all Prime Video subtitles as a ZIP, with search, per-language selection, live progress, SDH/CC/Forced detection, TTML+SRT+VTT output.
// @author       Based on NunoFilipe93 v1.0.0
// @match        https://*.amazon.com/*
// @match        https://*.amazon.co.uk/*
// @match        https://*.amazon.de/*
// @match        https://*.amazon.fr/*
// @match        https://*.amazon.it/*
// @match        https://*.amazon.es/*
// @match        https://*.amazon.co.jp/*
// @match        https://*.amazon.ca/*
// @match        https://*.amazon.com.au/*
// @match        https://*.amazon.com.br/*
// @match        https://*.amazon.com.mx/*
// @match        https://*.amazon.in/*
// @match        https://*.primevideo.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @grant        none
// @run-at       document-start
// @icon         https://www.primevideo.com/favicon.ico
// ==/UserScript==

/* eslint-disable */
(function () {
  'use strict';

  const VERSION = '3.5.0';
  const LOG = (...a) => console.log('%c[APVSD]', 'color:#00e0ff', ...a);
  const WARN = (...a) => console.warn('[APVSD]', ...a);
  const ERR = (...a) => console.error('[APVSD]', ...a);

  // ----------------------------------------------------------------
  // State
  // ----------------------------------------------------------------
  let playbackResourcesUrl = null;    // captured GetVodPlaybackResources endpoint
  let capturedSubtitleUrls = [];       // subtitles intercepted from Prime's own playback response
  let cachedTracks = [];              // last discovered tracks
  let selection = new Set();          // indices of selected tracks
  let filterText = '';
  let concurrency = 8;
  let outputFormat = localStorage.getItem('apvsd_format') || 'both'; // 'srt' | 'ttml' | 'both'
  let stripFormatting = localStorage.getItem('apvsd_strip') === '1';

  // ----------------------------------------------------------------
  // URL interceptor (must be injected into page context to catch site fetches)
  // ----------------------------------------------------------------
  const interceptorFn = function () {
    const isPlaybackResourcesUrl = (url) => typeof url === 'string' && /\/playback\/(?:prs\/)?(?:GetVodPlaybackResources|GetPlaybackResources)|GetVodPlaybackResources/i.test(url);
    const emitUrl = (url) => {
      try { window.dispatchEvent(new CustomEvent('apvsd_prs_url', { detail: { url } })); } catch (e) {}
    };
    const emitBody = (url, body) => {
      try { window.dispatchEvent(new CustomEvent('apvsd_prs_response', { detail: { url, body } })); } catch (e) {}
    };
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const origFetch = window.fetch;
    XMLHttpRequest.prototype.open = function () {
      try {
        const url = arguments[1];
        if (isPlaybackResourcesUrl(url)) {
          this.__apvsdUrl = url;
          emitUrl(url);
        }
      } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        if (this.__apvsdUrl) {
          this.addEventListener('loadend', () => {
            try {
              const body = typeof this.responseText === 'string' ? this.responseText : '';
              if (body) emitBody(this.__apvsdUrl, body);
            } catch (e) {}
          });
        }
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
    window.fetch = function () {
      let url = '';
      try {
        const u = arguments[0];
        url = typeof u === 'string' ? u : (u && u.url) || '';
        if (isPlaybackResourcesUrl(url)) emitUrl(url);
      } catch (e) {}
      const promise = origFetch.apply(this, arguments);
      try {
        if (isPlaybackResourcesUrl(url)) {
          promise.then((res) => {
            try { res.clone().text().then((body) => body && emitBody(url, body)).catch(() => {}); } catch (e) {}
          }).catch(() => {});
        }
      } catch (e) {}
      return promise;
    };
  };
  try {
    const s = document.createElement('script');
    s.textContent = '(' + interceptorFn.toString() + ')();';
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch (e) { ERR('interceptor inject failed', e); }

  window.addEventListener('apvsd_prs_url', (ev) => {
    try {
      const url = ev.detail.url;
      playbackResourcesUrl = new URL(url, location.href).href;
      LOG('captured PRS endpoint');
    } catch (e) {}
  });

  window.addEventListener('apvsd_prs_response', (ev) => {
    try {
      const url = ev.detail.url;
      if (url) playbackResourcesUrl = new URL(url, location.href).href;
      const data = JSON.parse(ev.detail.body || '{}');
      const list = extractSubtitleList(data);
      if (list.length) {
        capturedSubtitleUrls = list;
        cachedTracks = normalizeTracks(list);
        selection.clear();
        cachedTracks.forEach(t => selection.add(t.idx));
        if (document.getElementById('apvsd-panel')) {
          renderList();
          setStatus(`Captured ${cachedTracks.length} subtitle tracks from Prime playback.`);
        }
        LOG('captured subtitle tracks', cachedTracks.length);
      }
    } catch (e) {}
  });

  function dedupeSubtitles(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      if (!item || !item.url) continue;
      const key = [item.url, item.languageCode || item.language || '', item.displayName || item.name || item.label || '', item.subtitleType || item.type || ''].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  function normalizeSubtitleObject(item) {
    if (!item || typeof item !== 'object') return null;
    const url = item.url || item.URL || item.uri || item.href || item.downloadUrl || item.cdnUrl || item.cdnURL || item.ttmlUrl || item.dfxpUrl || item.vttUrl;
    if (!url || typeof url !== 'string') return null;
    const probe = `${url} ${JSON.stringify(item).slice(0, 1200)}`.toLowerCase();
    if (!/subtitle|caption|timedtext|ttml|dfxp|webvtt|\.vtt|\.xml|\.tt/.test(probe)) return null;
    return { ...item, url };
  }

  function extractSubtitleList(data) {
    const found = [];
    const seenObjects = new WeakSet();
    const walk = (node, path = '', depth = 0) => {
      if (!node || depth > 12) return;
      if (Array.isArray(node)) {
        const subtitles = node.map(normalizeSubtitleObject).filter(Boolean);
        if (subtitles.length) found.push(...subtitles);
        for (const child of node) walk(child, path, depth + 1);
        return;
      }
      if (typeof node !== 'object' || seenObjects.has(node)) return;
      seenObjects.add(node);
      const direct = node.subtitleUrls || node.subtitles || node.timedTextUrls || node.timedTextTracks || node.captionTracks || node.captions;
      if (direct) walk(direct, path + '.timedText', depth + 1);
      if (node.result) walk(node.result, path + '.result', depth + 1);
      for (const [key, value] of Object.entries(node)) {
        if (/subtitle|caption|timedText|closedCaption|ttml|dfxp/i.test(key)) walk(value, path + '.' + key, depth + 1);
      }
      if (depth < 4) {
        for (const value of Object.values(node)) walk(value, path, depth + 1);
      }
    };
    walk(data);
    return dedupeSubtitles(found);
  }

  function findPlaybackEnvelopeInText(text) {
    if (!text) return null;
    const m = String(text).match(/"playbackEnvelope"\s*:\s*"((?:\\.|[^"\\])+)"/);
    if (!m) return null;
    try { return JSON.parse('"' + m[1] + '"'); } catch (_) { return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
  }

  function findPlaybackEnvelopeDeep(value, depth = 0, seen = new WeakSet()) {
    if (!value || depth > 12) return null;
    if (typeof value === 'string') return findPlaybackEnvelopeInText(value);
    if (typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    if (typeof value.playbackEnvelope === 'string') return value.playbackEnvelope;
    for (const child of Object.values(value)) {
      const found = findPlaybackEnvelopeDeep(child, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  // ----------------------------------------------------------------
  // Playback envelope extraction from the detail/watch page templates
  // ----------------------------------------------------------------
  function extractPlaybackEnvelope() {
    const scripts = document.querySelectorAll('script[type="text/template"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent || script.innerHTML);
        const found = findPlaybackEnvelopeDeep(data);
        if (found) return found;
      } catch (_) {}
      const fromText = findPlaybackEnvelopeInText(script.textContent || script.innerHTML);
      if (fromText) return fromText;
    }
    for (const script of document.scripts) {
      const fromText = findPlaybackEnvelopeInText(script.textContent || script.innerHTML);
      if (fromText) return fromText;
    }
    for (const store of [window.localStorage, window.sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          const value = store.getItem(key);
          const found = findPlaybackEnvelopeInText(value);
          if (found) return found;
          try {
            const parsed = JSON.parse(value);
            const deep = findPlaybackEnvelopeDeep(parsed);
            if (deep) return deep;
          } catch (_) {}
        }
      } catch (_) {}
    }
    return null;
  }

  function defaultPRSUrl() {
    // Best-guess fallback based on host region.
    const host = location.hostname;
    if (/\.co\.jp$/.test(host)) return 'https://atv-ps-fe.primevideo.com/playback/prs/GetVodPlaybackResources?deviceID=browser&deviceTypeID=AOAGZA014O5RE&gascEnabled=true&marketplaceID=A1VC38T7YXB528&uxLocale=ja_JP&firmware=1';
    if (/\.de$|\.fr$|\.it$|\.es$|\.co\.uk$/.test(host)) return 'https://atv-ps-eu.primevideo.com/playback/prs/GetVodPlaybackResources?deviceID=browser&deviceTypeID=AOAGZA014O5RE&gascEnabled=true&marketplaceID=A3K6Y4MI8GDYMT&uxLocale=en_GB&firmware=1';
    return 'https://atv-ps.primevideo.com/playback/prs/GetVodPlaybackResources?deviceID=browser&deviceTypeID=AOAGZA014O5RE&gascEnabled=true&marketplaceID=ATVPDKIKX0DER&uxLocale=en_US&firmware=1';
  }

  async function fetchSubtitleUrls() {
    if (capturedSubtitleUrls.length) return capturedSubtitleUrls;
    const envelope = extractPlaybackEnvelope();
    if (!envelope) throw new Error('Playback envelope not found. Press Play, wait until the video/subtitle menu loads, then click Refresh again.');
    const urls = [...new Set([playbackResourcesUrl, defaultPRSUrl()].filter(Boolean))];
    const errors = [];
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            globalParameters: {
              deviceCapabilityFamily: 'WebPlayer',
              playbackEnvelope: envelope,
            },
            timedTextUrlsRequest: {
              supportedTimedTextFormats: ['TTMLv2', 'DFXP', 'WEBVTT', 'VTT'],
            },
          }),
        });
        const text = await res.text();
        let data = {};
        try { data = JSON.parse(text); } catch (_) { throw new Error(`non-JSON response HTTP ${res.status}`); }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (data.globalError) throw new Error(data.globalError.message || data.globalError.code || 'globalError');
        const list = extractSubtitleList(data);
        if (list.length) {
          capturedSubtitleUrls = list;
          return list;
        }
        errors.push('No timedText URLs in response');
      } catch (e) {
        errors.push(e.message || String(e));
      }
    }
    throw new Error(`No subtitles found. Press Play once and open Prime's subtitles menu, then Refresh. ${errors[0] ? 'Last error: ' + errors[0] : ''}`);
  }

  // ----------------------------------------------------------------
  // Track normalisation + type detection
  // ----------------------------------------------------------------
  function detectType(t) {
    const str = JSON.stringify(t).toLowerCase();
    const tags = [];
    if (t.isSDH || t.hearingImpaired || /sdh|hearing[-_ ]?impaired/.test(str)) tags.push('SDH');
    if (t.subtitleType === 'CC' || /closed[-_ ]?caption|(^|\W)cc(\W|$)/.test(str)) tags.push('CC');
    if (t.isForced || t.forced || /forced/.test(str)) tags.push('FORCED');
    if (/audio[-_ ]?description|descriptive/.test(str)) tags.push('DESC');
    return tags;
  }

  function normalizeTracks(raw) {
    return raw.map((t, i) => {
      const lang = (t.languageCode || t.language || t.locale || t.lang || 'und').toLowerCase();
      const displayName = t.displayName || t.name || t.label || t.languageName || t.localizedLanguageName || t.subtype || lang.toUpperCase();
      const tags = detectType(t);
      return {
        idx: i,
        lang,
        displayName,
        tags,
        url: t.url,
        format: (t.type || t.format || (t.url && t.url.match(/\.vtt/i) ? 'WEBVTT' : 'TTMLv2')).toUpperCase(),
        raw: t,
      };
    });
  }

  // ----------------------------------------------------------------
  // TTML -> SRT (from NunoFilipe93's converter, MIT)
  // ----------------------------------------------------------------
  // Decode HTML entities WITHOUT killing our formatting tags (<i>, <b>, <u>, <font>) or {\anX}.
  function decodeEntitiesPreserveTags(str) {
    if (!str) return str;
    const PLACE_OPEN = '\u0001', PLACE_CLOSE = '\u0002';
    const protectedStr = str.replace(/<(\/?(?:i|b|u|font)(?:\s[^>]*)?)>/gi, (_, inner) => PLACE_OPEN + inner + PLACE_CLOSE);
    const ta = document.createElement('textarea');
    ta.innerHTML = protectedStr;
    return ta.value.split(PLACE_OPEN).join('<').split(PLACE_CLOSE).join('>');
  }

  // Normalise a TTML color token to #RRGGBB. Accepts #rgb, #rrggbb, #rrggbbaa, rgb()/rgba(), named colors pass through.
  function normalizeColor(c) {
    if (!c) return null;
    c = String(c).trim();
    if (/^#([0-9a-f]{3})$/i.test(c)) {
      return '#' + c.slice(1).split('').map(ch => ch + ch).join('').toLowerCase();
    }
    if (/^#([0-9a-f]{6})$/i.test(c)) return c.toLowerCase();
    if (/^#([0-9a-f]{8})$/i.test(c)) return '#' + c.slice(1, 7).toLowerCase();
    const rgb = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgb) {
      const h = n => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0');
      return '#' + h(rgb[1]) + h(rgb[2]) + h(rgb[3]);
    }
    return c; // named color
  }

  // Pull merged style bits (italic, bold, ruby, underline, color) for a style id, following any style chain.
  function resolveStyle(id, styles, seen) {
    if (!id || !styles[id]) return null;
    if (seen && seen.has(id)) return styles[id];
    (seen = seen || new Set()).add(id);
    const s = styles[id];
    if (s.parent) {
      const p = resolveStyle(s.parent, styles, seen);
      if (p) {
        return {
          italic: s.italic || p.italic,
          bold: s.bold || p.bold,
          ruby: s.ruby || p.ruby,
          underline: s.underline || p.underline,
          color: s.color || p.color,
        };
      }
    }
    return s;
  }

  function parseTTMLLine(line, parentStyleId, styles) {
    const topStyleId = line.getAttribute('style') || parentStyleId;
    let italic = line.getAttribute('tts:fontStyle') === 'italic';
    let bold = line.getAttribute('tts:fontWeight') === 'bold';
    const deco = line.getAttribute('tts:textDecoration') || '';
    let underline = /underline/i.test(deco);
    let ruby = line.getAttribute('tts:ruby') === 'text';
    let color = normalizeColor(line.getAttribute('tts:color'));
    const resolved = resolveStyle(topStyleId, styles);
    if (resolved) {
      italic = italic || resolved.italic;
      bold = bold || resolved.bold;
      ruby = ruby || resolved.ruby;
      underline = underline || resolved.underline;
      color = color || resolved.color;
    }
    let prefix = '', suffix = '';
    if (color)     { prefix += '<font color="' + color + '">'; suffix = '</font>' + suffix; }
    if (italic)    { prefix += '<i>'; suffix = '</i>' + suffix; }
    if (bold)      { prefix += '<b>'; suffix = '</b>' + suffix; }
    if (underline) { prefix += '<u>'; suffix = '</u>' + suffix; }
    if (ruby)      { prefix += '(';   suffix = ')'    + suffix; }
    let inner = '';
    for (const node of line.childNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.split(':').pop().toUpperCase();
        if (tag === 'BR') inner += '\n';
        else if (tag === 'SPAN') inner += parseTTMLLine(node, topStyleId, styles);
        else inner += node.textContent || '';
      } else if (node.nodeType === Node.TEXT_NODE) {
        inner += node.textContent;
      }
    }
    return prefix + inner + suffix;
  }

  // Map (horizontal align, vertical band) -> ASS/SSA numpad code used by {\anN} SRT extension.
  // vertical: 'top' | 'middle' | 'bottom' ; horizontal: 'left' | 'center' | 'right'
  function anCode(horiz, vert) {
    const row = vert === 'top' ? 7 : vert === 'middle' ? 4 : 1;
    const col = horiz === 'left' ? 0 : horiz === 'right' ? 2 : 1;
    return row + col; // 1..9
  }

  // Convert a TTML clock value (00:00:12.345, 12.5s, 250ms, 90000t...) into SRT HH:MM:SS,mmm.
  // Falls back to a best-effort replace of '.' with ','.
  function ttmlTimeToSRT(t, tickRate) {
    if (!t) return '00:00:00,000';
    t = String(t).trim();
    let seconds = null;
    let m;
    if ((m = t.match(/^(\d+):(\d+):(\d+)(?:[.,](\d+))?$/))) {
      seconds = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? parseFloat('0.' + m[4]) : 0);
    } else if ((m = t.match(/^([\d.]+)(h|m|s|ms|f|t)$/i))) {
      const n = parseFloat(m[1]);
      const u = m[2].toLowerCase();
      if (u === 'h') seconds = n * 3600;
      else if (u === 'm') seconds = n * 60;
      else if (u === 's') seconds = n;
      else if (u === 'ms') seconds = n / 1000;
      else if (u === 't' && tickRate) seconds = n / tickRate;
    }
    if (seconds == null) return t.replace('.', ',');
    if (seconds < 0) seconds = 0;
    const hh = Math.floor(seconds / 3600);
    const mm = Math.floor((seconds % 3600) / 60);
    const ss = Math.floor(seconds % 60);
    const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
    const pad = (n, w) => String(n).padStart(w, '0');
    return pad(hh, 2) + ':' + pad(mm, 2) + ':' + pad(ss, 2) + ',' + pad(ms, 3);
  }

  function convertTTMLToSRT(xmlString, languageCode) {
    try {
      const xmlDoc = new DOMParser().parseFromString(xmlString, 'text/xml');
      const root = xmlDoc.documentElement;
      const tickRate = root && parseInt(root.getAttribute('ttp:tickRate') || root.getAttribute('tickRate') || '0', 10) || 0;

      const styles = {};
      for (const style of xmlDoc.querySelectorAll('head styling style')) {
        const id = style.getAttribute('xml:id'); if (!id) continue;
        styles[id] = {
          italic: style.getAttribute('tts:fontStyle') === 'italic',
          bold: style.getAttribute('tts:fontWeight') === 'bold',
          ruby: style.getAttribute('tts:ruby') === 'text',
          underline: /underline/i.test(style.getAttribute('tts:textDecoration') || ''),
          color: normalizeColor(style.getAttribute('tts:color')),
          parent: style.getAttribute('style') || null,
          textAlign: (style.getAttribute('tts:textAlign') || '').toLowerCase() || null,
          displayAlign: (style.getAttribute('tts:displayAlign') || '').toLowerCase() || null,
        };
      }

      // Region-level positioning: derive vertical band from origin/extent + displayAlign, horizontal from textAlign.
      const regions = {};
      for (const region of xmlDoc.querySelectorAll('head layout region')) {
        const id = region.getAttribute('xml:id'); if (!id) continue;
        const originAttr = region.getAttribute('tts:origin') || '';
        const extentAttr = region.getAttribute('tts:extent') || '';
        const styleId = region.getAttribute('style');
        const styleRef = styleId ? resolveStyle(styleId, styles) : null;
        const displayAlign = (region.getAttribute('tts:displayAlign') || (styleRef && styleRef.displayAlign) || 'after').toLowerCase();
        const textAlign = (region.getAttribute('tts:textAlign') || (styleRef && styleRef.textAlign) || 'center').toLowerCase();

        // Compute vertical center of the region in %; default anchor to bottom.
        let vert = 'bottom';
        const o = originAttr.match(/(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%/);
        const e = extentAttr.match(/(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%/);
        if (o) {
          const yTop = parseFloat(o[2]);
          const yHeight = e ? parseFloat(e[2]) : 0;
          let yAnchor = yTop;
          if (displayAlign === 'center') yAnchor = yTop + yHeight / 2;
          else if (displayAlign === 'after') yAnchor = yTop + yHeight;
          if (yAnchor < 33) vert = 'top';
          else if (yAnchor < 66) vert = 'middle';
          else vert = 'bottom';
        } else {
          if (displayAlign === 'before') vert = 'top';
          else if (displayAlign === 'center') vert = 'middle';
        }

        let horiz = 'center';
        if (textAlign === 'left' || textAlign === 'start') horiz = 'left';
        else if (textAlign === 'right' || textAlign === 'end') horiz = 'right';

        regions[id] = { an: anCode(horiz, vert) };
      }

      const body = xmlDoc.querySelector('body');
      if (!body) return null;
      const topStyle = body.getAttribute('style');
      const lines = [];
      let n = 0;
      for (const p of xmlDoc.querySelectorAll('body p')) {
        let line = parseTTMLLine(p, topStyle, styles);
        if (!line) continue;
        line = decodeEntitiesPreserveTags(line).replace(/\n{2,}/g, '\n');

        // Prefer paragraph-level textAlign override, else region default.
        const pTextAlign = (p.getAttribute('tts:textAlign') || '').toLowerCase();
        const regionId = p.getAttribute('region');
        let an = regions[regionId] ? regions[regionId].an : null;
        if (pTextAlign) {
          // Recompute horizontal but keep whatever vertical the region implied (default bottom).
          const vertRow = an ? Math.floor((an - 1) / 3) : 0; // 0 bottom, 1 middle, 2 top
          const vert = vertRow === 2 ? 'top' : vertRow === 1 ? 'middle' : 'bottom';
          const horiz = (pTextAlign === 'left' || pTextAlign === 'start') ? 'left'
            : (pTextAlign === 'right' || pTextAlign === 'end') ? 'right' : 'center';
          an = anCode(horiz, vert);
        }
        // Only emit override when it isn't the SRT default (an2 = bottom-center).
        if (an && an !== 2) line = '{\\an' + an + '}' + line;

        if (languageCode && languageCode.startsWith('ar')) {
          line = line.replace(/^(?!\u202B|\u200F)/gm, '\u202B');
        }
        n++;
        lines.push(String(n));
        lines.push(ttmlTimeToSRT(p.getAttribute('begin'), tickRate) + ' --> ' + ttmlTimeToSRT(p.getAttribute('end'), tickRate));
        lines.push(line);
        lines.push('');
      }
      return lines.join('\n');
    } catch (e) { ERR('ttml->srt failed', e); return null; }
  }


  // WebVTT -> SRT, preserving inline tags (<i>, <b>, <u>) and positioning ({\an8} from line:0%).
  function convertWebVTTToSRT(vtt, languageCode) {
    try {
      const text = vtt.replace(/\r\n?/g, '\n').replace(/^WEBVTT[^\n]*\n(?:[^\n]*\n)*?\n/, '');
      const blocks = text.split(/\n\n+/);
      const out = [];
      let n = 0;
      for (const raw of blocks) {
        const b = raw.trim();
        if (!b) continue;
        const bl = b.split('\n');
        // Skip cue identifier line if present.
        let ti = bl.findIndex(l => l.includes('-->'));
        if (ti < 0) continue;
        const timing = bl[ti];
        const bodyLines = bl.slice(ti + 1);
        const m = timing.match(/(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{1,2}:\d{2}[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{1,2}:\d{2}[.,]\d{3})(.*)/);
        if (!m) continue;
        const norm = (t) => {
          if (/^\d{1,2}:\d{2}[.,]\d{3}$/.test(t)) t = '00:' + t;
          return t.replace('.', ',');
        };
        const settings = m[3] || '';
        let body = bodyLines.join('\n');
        // Strip WebVTT-only voice/class spans but keep italic/bold/underline.
        body = body.replace(/<v[^>]*>/gi, '').replace(/<\/v>/gi, '');
        body = body.replace(/<c[^>]*>/gi, '').replace(/<\/c>/gi, '');
        body = body.replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, ''); // karaoke timestamps
        // Top positioning heuristic.
        if (/line:\s*(?:[0-9]|1[0-9])%/.test(settings) || /line:\s*0\b/.test(settings)) {
          body = '{\\an8}' + body;
        }
        if (languageCode && languageCode.startsWith('ar')) {
          body = body.replace(/^(?!\u202B|\u200F)/gm, '\u202B');
        }
        n++;
        out.push(String(n));
        out.push(norm(m[1]) + ' --> ' + norm(m[2]));
        out.push(body);
        out.push('');
      }
      return out.join('\n');
    } catch (e) { ERR('vtt->srt failed', e); return null; }
  }

  function isWebVTT(text) { return /^\s*WEBVTT\b/.test(text || ''); }

  // Strip inline styling tags/markers commonly found in subtitle text.
  // Handles SRT/VTT-style HTML tags (<i>, <b>, <u>, <font ...>, <c...>),
  // ASS/SSA overrides ({\an8}, {\pos(...)} etc.), and TTML styled <span>s.
  function stripSubFormatting(text) {
    if (!text) return text;
    let out = text;
    // ASS/SSA override blocks: {\an8}, {\pos(...)}, {\i1}, etc.
    out = out.replace(/\{\\[^}]*\}/g, '');
    // HTML-ish tags: <i>, </i>, <b>, <u>, <font ...>, </font>, <c.classname>, <ruby>, <rt>, <v ...>
    out = out.replace(/<\/?(?:i|b|u|s|em|strong|font|c|ruby|rt|rp|v|lang)\b[^>]*>/gi, '');
    // TTML <span ...> ... </span> (unwrap, keep inner text). Also <br/> -> newline.
    out = out.replace(/<br\s*\/?\s*>/gi, '\n');
    out = out.replace(/<\/?span\b[^>]*>/gi, '');
    // Strip tts:* / xml:* styling attributes if any remain on other tags (defensive).
    out = out.replace(/\s+(?:tts|xml|ttp|tts2):[\w-]+="[^"]*"/gi, '');
    return out;
  }

  function toSRT(text, languageCode) {
    if (isWebVTT(text)) return convertWebVTTToSRT(text, languageCode);
    return convertTTMLToSRT(text, languageCode);
  }


  // ----------------------------------------------------------------
  // Filenames + title
  // ----------------------------------------------------------------
  function sanitize(name) {
    return String(name).replace(/[:*?"<>|\\\/]+/g, '_').replace(/\s+/g, '.').replace(/\.{2,}/g, '.');
  }

  function getTitle() {
    const t = document.querySelector('.atvwebplayersdk-title-text');
    const s = document.querySelector('.atvwebplayersdk-subtitle-text');
    let name = 'Amazon_Prime_Video';
    if (t) {
      name = t.textContent.trim();
      if (s) {
        const sub = s.textContent.trim();
        const m = sub.match(/(?:Season|Temporada|Staffel|Saison|Stagione)\s+(\d+)\D+(\d+)\s*(.*)$/i);
        if (m) name = `${name}.S${m[1].padStart(2, '0')}E${m[2].padStart(2, '0')}.${m[3].trim()}`;
      }
    } else {
      const dt = document.querySelector('h1, [data-automation-id="title"]');
      if (dt) name = dt.textContent.trim();
    }
    return sanitize(name);
  }

  // ----------------------------------------------------------------
  // UI
  // ----------------------------------------------------------------
  const CSS = `
  #apvsd-panel { position:fixed; top:12px; right:12px; width:360px; max-height:80vh; z-index:2147483647;
    background:#0b1220; color:#e6f2ff; font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;
    border:1px solid #1e3a5f; border-radius:10px; box-shadow:0 8px 30px rgba(0,0,0,.6); display:flex; flex-direction:column; }
  #apvsd-panel.dragging { user-select:none; box-shadow:0 12px 40px rgba(0,0,0,.8); }
  #apvsd-panel.collapsed .apvsd-body { display:none; }
  #apvsd-head { display:flex; align-items:center; gap:6px; padding:8px 10px; background:linear-gradient(135deg,#0f2540,#0b1220); border-bottom:1px solid #1e3a5f; border-radius:10px 10px 0 0; cursor:move; touch-action:none; }
  #apvsd-head .t { font-weight:600; color:#7cd4ff; flex:1; }
  #apvsd-head button { background:#173352; color:#cfeaff; border:0; border-radius:4px; padding:3px 8px; cursor:pointer; font-size:11px; }
  #apvsd-head button:hover { background:#1f4676; }
  .apvsd-body { display:flex; flex-direction:column; overflow:hidden; }
  #apvsd-toolbar { padding:8px 10px; display:flex; flex-direction:column; gap:6px; border-bottom:1px solid #1e3a5f; }
  #apvsd-toolbar input[type=text] { width:100%; padding:5px 8px; background:#0e1a2e; color:#e6f2ff; border:1px solid #1e3a5f; border-radius:4px; box-sizing:border-box; }
  #apvsd-toolbar .row { display:flex; gap:6px; align-items:center; }
  #apvsd-toolbar select, #apvsd-toolbar button { background:#173352; color:#cfeaff; border:1px solid #1e3a5f; border-radius:4px; padding:4px 8px; cursor:pointer; font-size:11px; }
  #apvsd-toolbar button.primary { background:linear-gradient(135deg,#0ea5e9,#0369a1); color:#fff; border:0; flex:1; font-weight:600; }
  #apvsd-toolbar button.primary:disabled { opacity:.5; cursor:not-allowed; }
  #apvsd-count { color:#8fb8dc; font-size:11px; }
  #apvsd-list { overflow:auto; max-height:44vh; }
  .apvsd-item { display:flex; align-items:center; gap:6px; padding:6px 10px; border-bottom:1px solid #142842; }
  .apvsd-item:hover { background:#0f1f36; }
  .apvsd-item input[type=checkbox] { accent-color:#0ea5e9; }
  .apvsd-item .lang { font-weight:600; color:#7cd4ff; min-width:44px; }
  .apvsd-item .name { flex:1; color:#cfe6ff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .apvsd-item .fmt { color:#6b8ba8; font-size:10px; }
  .apvsd-item button.dl { background:#173352; color:#cfeaff; border:0; border-radius:3px; padding:2px 6px; cursor:pointer; font-size:11px; }
  .apvsd-item button.dl:hover { background:#1f4676; }
  .apvsd-badge { display:inline-block; padding:1px 5px; border-radius:3px; font-size:9px; font-weight:700; margin-left:4px; }
  .b-sdh { background:#7c2d12; color:#fed7aa; }
  .b-cc { background:#134e4a; color:#a7f3d0; }
  .b-forced { background:#581c87; color:#e9d5ff; }
  .b-desc { background:#334155; color:#cbd5e1; }
  #apvsd-progress { padding:8px 10px; border-top:1px solid #1e3a5f; display:none; }
  #apvsd-progress.on { display:block; }
  #apvsd-progress .lbl { display:flex; justify-content:space-between; font-size:11px; color:#8fb8dc; margin-bottom:4px; }
  #apvsd-bar { height:6px; background:#0e1a2e; border-radius:3px; overflow:hidden; }
  #apvsd-bar > div { height:100%; width:0%; background:linear-gradient(90deg,#0ea5e9,#22d3ee); transition:width .15s; }
  #apvsd-status { padding:6px 10px; font-size:11px; color:#8fb8dc; border-top:1px solid #1e3a5f; }
  `;

  function mountUI() {
    if (document.getElementById('apvsd-panel')) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'apvsd-panel';
    panel.innerHTML = `
      <div id="apvsd-head">
        <div class="t">Prime Video Subs v${VERSION}</div>
        <button id="apvsd-center" title="Center on screen">◎</button>
        <button id="apvsd-toggle" title="Collapse">–</button>
      </div>
      <div class="apvsd-body">
        <div id="apvsd-toolbar">
          <input id="apvsd-filter" type="text" placeholder="Search language, name, format…" />
          <div class="row">
            <button id="apvsd-refresh">Refresh</button>
            <select id="apvsd-format" title="Output format">
              <option value="both">SRT + TTML</option>
              <option value="srt">SRT only</option>
              <option value="ttml">TTML only</option>
            </select>
            <span id="apvsd-count">0 selected</span>
          </div>
          <div class="row">
            <button id="apvsd-selall">Select all (filtered)</button>
            <button id="apvsd-clear">Clear</button>
          </div>
          <div class="row">
            <label style="display:flex;align-items:center;gap:6px;color:#cfe6ff;cursor:pointer;font-size:11px;">
              <input id="apvsd-strip" type="checkbox" /> Strip formatting tags (&lt;i&gt;, &lt;b&gt;, &lt;font&gt;, {\an8}…)
            </label>
          </div>
          <div class="row">
            <button id="apvsd-dlall" class="primary" disabled>Download ZIP</button>
          </div>
        </div>
        <div id="apvsd-list"></div>
        <div id="apvsd-progress">
          <div class="lbl"><span id="apvsd-progress-text">0 / 0</span><span id="apvsd-progress-pct">0%</span></div>
          <div id="apvsd-bar"><div></div></div>
        </div>
        <div id="apvsd-status">Waiting — press Play once to arm the extractor.</div>
      </div>
    `;
    document.body.appendChild(panel);

    // --- Draggable panel (persisted in localStorage) ---------------------------
    const clampToViewport = () => {
      const r = panel.getBoundingClientRect();
      const maxL = Math.max(0, window.innerWidth - r.width);
      const maxT = Math.max(0, window.innerHeight - r.height);
      const l = Math.min(Math.max(0, panel.offsetLeft), maxL);
      const t = Math.min(Math.max(0, panel.offsetTop), maxT);
      panel.style.left = l + 'px'; panel.style.top = t + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    };
    const savePos = () => {
      try { localStorage.setItem('apvsd_pos', JSON.stringify({ left: panel.offsetLeft, top: panel.offsetTop })); } catch {}
    };
    const centerPanel = () => {
      const r = panel.getBoundingClientRect();
      panel.style.left = Math.max(0, (window.innerWidth - r.width) / 2) + 'px';
      panel.style.top = Math.max(0, (window.innerHeight - r.height) / 2) + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      savePos();
    };
    try {
      const saved = JSON.parse(localStorage.getItem('apvsd_pos') || 'null');
      if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
        panel.style.left = saved.left + 'px'; panel.style.top = saved.top + 'px';
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
        requestAnimationFrame(clampToViewport);
      }
    } catch {}
    window.addEventListener('resize', clampToViewport);

    const head = document.getElementById('apvsd-head');
    let drag = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return; // don't drag when hitting header buttons
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
      panel.classList.add('dragging');
      head.setPointerCapture(e.pointerId);
      // switch to left/top so movement works regardless of initial right/bottom anchoring
      panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      e.preventDefault();
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const r = panel.getBoundingClientRect();
      const l = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - r.width);
      const t = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - r.height);
      panel.style.left = l + 'px'; panel.style.top = t + 'px';
    });
    const endDrag = (e) => {
      if (!drag) return;
      try { head.releasePointerCapture(drag.id); } catch {}
      drag = null; panel.classList.remove('dragging'); savePos();
    };
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);

    document.getElementById('apvsd-center').onclick = centerPanel;
    document.getElementById('apvsd-toggle').onclick = () => panel.classList.toggle('collapsed');
    document.getElementById('apvsd-refresh').onclick = () => refresh();
    document.getElementById('apvsd-filter').oninput = (e) => { filterText = e.target.value.toLowerCase(); renderList(); };
    document.getElementById('apvsd-selall').onclick = () => { filteredIndices().forEach(i => selection.add(i)); renderList(); };
    document.getElementById('apvsd-clear').onclick = () => { selection.clear(); renderList(); };
    document.getElementById('apvsd-dlall').onclick = () => downloadZip();
    const fmt = document.getElementById('apvsd-format');
    fmt.value = outputFormat;
    fmt.onchange = () => { outputFormat = fmt.value; localStorage.setItem('apvsd_format', outputFormat); };
    const strip = document.getElementById('apvsd-strip');
    strip.checked = stripFormatting;
    strip.onchange = () => { stripFormatting = strip.checked; localStorage.setItem('apvsd_strip', stripFormatting ? '1' : '0'); };
  }

  function setStatus(msg) {
    const el = document.getElementById('apvsd-status');
    if (el) el.textContent = msg;
  }

  function filteredIndices() {
    if (!filterText) return cachedTracks.map(t => t.idx);
    return cachedTracks.filter(t => {
      const s = `${t.lang} ${t.displayName} ${t.tags.join(' ')} ${t.format}`.toLowerCase();
      return s.includes(filterText);
    }).map(t => t.idx);
  }

  function renderList() {
    const list = document.getElementById('apvsd-list');
    if (!list) return;
    const idxs = filteredIndices();
    list.innerHTML = '';
    for (const i of idxs) {
      const t = cachedTracks[i];
      const row = document.createElement('div');
      row.className = 'apvsd-item';
      const badges = t.tags.map(x => `<span class="apvsd-badge b-${x.toLowerCase()}">${x}</span>`).join('');
      row.innerHTML = `
        <input type="checkbox" ${selection.has(i) ? 'checked' : ''} />
        <span class="lang">${t.lang}</span>
        <span class="name" title="${t.displayName}">${t.displayName}${badges}</span>
        <span class="fmt">${t.format}</span>
        <button class="dl" title="Download this track">↓</button>
      `;
      row.querySelector('input').onchange = (e) => { if (e.target.checked) selection.add(i); else selection.delete(i); updateCount(); };
      row.querySelector('button.dl').onclick = () => downloadSingle(i);
      list.appendChild(row);
    }
    updateCount();
  }

  function updateCount() {
    const c = document.getElementById('apvsd-count');
    const b = document.getElementById('apvsd-dlall');
    if (c) c.textContent = `${selection.size} selected / ${cachedTracks.length} total`;
    if (b) b.disabled = selection.size === 0 && cachedTracks.length === 0;
    if (b) b.textContent = selection.size > 0 ? `Download ZIP (${selection.size})` : `Download ZIP (all ${cachedTracks.length})`;
  }

  // ----------------------------------------------------------------
  // Refresh + download
  // ----------------------------------------------------------------
  async function refresh() {
    try {
      setStatus('Fetching subtitle manifest from Prime API…');
      const raw = await fetchSubtitleUrls();
      cachedTracks = normalizeTracks(raw);
      selection.clear();
      cachedTracks.forEach(t => selection.add(t.idx)); // default: all selected
      renderList();
      setStatus(`Loaded ${cachedTracks.length} tracks.`);
    } catch (e) {
      ERR(e);
      setStatus('Error: ' + e.message);
    }
  }

  function showProgress(total) {
    const p = document.getElementById('apvsd-progress');
    p.classList.add('on');
    updateProgress(0, total, 0);
  }
  function updateProgress(done, total, zipPct) {
    document.getElementById('apvsd-progress-text').textContent = `${done} / ${total}`;
    const pct = total ? Math.round((done / total) * 100) : 0;
    document.getElementById('apvsd-progress-pct').textContent = zipPct ? `${pct}% · zip ${zipPct}%` : `${pct}%`;
    document.querySelector('#apvsd-bar > div').style.width = pct + '%';
  }
  function hideProgress() {
    setTimeout(() => document.getElementById('apvsd-progress').classList.remove('on'), 1200);
  }

  async function runPool(items, worker, onDone) {
    let idx = 0, done = 0;
    const results = new Array(items.length);
    const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
      while (true) {
        const my = idx++;
        if (my >= items.length) break;
        try { results[my] = await worker(items[my]); }
        catch (e) { results[my] = { error: e.message, item: items[my] }; }
        done++;
        onDone(done);
      }
    });
    await Promise.all(workers);
    return results;
  }

  // Amazon's subtitle CDN (e.g. dfz2vhpi7dg50.cloudfront.net) responds with
  // Access-Control-Allow-Origin:* only when the request is NOT credentialed.
  // Sending credentials triggers preflight -> opaque failure -> empty zip.
  async function fetchSubtitleText(url) {
    const attempts = [
      { credentials: 'omit',    mode: 'cors' },
      { credentials: 'include', mode: 'cors' },
    ];
    let lastErr;
    for (const opts of attempts) {
      try {
        const res = await fetch(url, opts);
        if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        const text = await res.text();
        if (text && text.length) return text;
        lastErr = new Error('empty body');
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('fetch failed');
  }

  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function downloadSingle(i) {
    const t = cachedTracks[i]; if (!t) return;
    const title = getTitle();
    const tagSuffix = t.tags.length ? '.' + t.tags.join('-').toLowerCase() : '';
    const base = `${title}.${t.lang}${tagSuffix}`;
    try {
      setStatus(`Downloading ${base}…`);
      const text = await fetchSubtitleText(t.url);
      const rawIsVTT = isWebVTT(text);
      const rawExt = rawIsVTT ? 'vtt' : 'ttml';
      const rawMime = rawIsVTT ? 'text/vtt' : 'application/ttml+xml';
      if (outputFormat === 'ttml' || outputFormat === 'both') {
        const rawOut = stripFormatting ? stripSubFormatting(text) : text;
        saveBlob(new Blob([rawOut], { type: rawMime }), `${base}.${rawExt}`);
      }
      if (outputFormat === 'srt' || outputFormat === 'both') {
        let srt = toSRT(text, t.lang);
        if (srt && stripFormatting) srt = stripSubFormatting(srt);
        if (srt) saveBlob(new Blob([srt], { type: 'text/plain' }), `${base}.srt`);
        else setStatus(`SRT conversion failed for ${base} (raw saved).`);
      }
      setStatus(`Saved ${base}.`);
    } catch (e) {
      ERR('single download failed', e);
      setStatus(`Failed: ${e.message}`);
    }
  }

  async function downloadZip(explicitIndices) {
    if (!cachedTracks.length) { await refresh(); if (!cachedTracks.length) return; }
    const idxs = explicitIndices && explicitIndices.length ? explicitIndices
      : (selection.size ? [...selection] : cachedTracks.map(t => t.idx));
    const tracks = idxs.map(i => cachedTracks[i]).filter(Boolean);
    if (!tracks.length) { setStatus('Nothing selected.'); return; }

    const title = getTitle();
    const zip = new JSZip();
    const usedNames = new Set();
    const errors = [];
    let okCount = 0;

    setStatus(`Downloading ${tracks.length} tracks…`);
    showProgress(tracks.length);
    const t0 = performance.now();

    await runPool(tracks, async (t) => {
      let text;
      try {
        text = await fetchSubtitleText(t.url);
      } catch (e) {
        errors.push(`${t.lang} ${t.displayName}: fetch ${e.message} :: ${t.url}`);
        return false;
      }
      const tagSuffix = t.tags.length ? '.' + t.tags.join('-').toLowerCase() : '';
      const base = `${title}.${t.lang}${tagSuffix}`;
      let name = base;
      let n = 1;
      while (usedNames.has(name)) name = `${base}.${++n}`;
      usedNames.add(name);
      const rawIsVTT = isWebVTT(text);
      const rawExt = rawIsVTT ? 'vtt' : 'ttml';
      if (outputFormat === 'ttml' || outputFormat === 'both') {
        const rawOut = stripFormatting ? stripSubFormatting(text) : text;
        zip.file(`${name}.${rawExt}`, rawOut);
      }
      if (outputFormat === 'srt' || outputFormat === 'both') {
        let srt = toSRT(text, t.lang);
        if (srt && stripFormatting) srt = stripSubFormatting(srt);
        if (srt) zip.file(`${name}.srt`, srt);
        else errors.push(`${name}: SRT conversion failed`);
      }
      okCount++;
      return true;
    }, (done) => updateProgress(done, tracks.length, 0));

    if (!okCount) {
      hideProgress();
      setStatus(`All ${tracks.length} downloads failed. First error: ${errors[0] || 'unknown'}`);
      ERR('all subtitle fetches failed', errors);
      return;
    }
    if (errors.length) zip.file('_errors.txt', errors.join('\n'));

    setStatus('Generating zip…');
    const blob = await zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
      (m) => updateProgress(tracks.length, tracks.length, Math.round(m.percent))
    );

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title}.subs.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);

    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(`Done · ${tracks.length} tracks in ${dt}s`);
    hideProgress();
  }

  // ----------------------------------------------------------------
  // Boot
  // ----------------------------------------------------------------
  function boot() {
    mountUI();
    // Auto-refresh once the envelope is discoverable and PRS URL seen
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (extractPlaybackEnvelope()) {
        clearInterval(iv);
        refresh();
      } else if (tries > 60) {
        clearInterval(iv);
      }
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Re-mount on SPA navigation
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      cachedTracks = []; selection.clear();
      if (document.getElementById('apvsd-list')) document.getElementById('apvsd-list').innerHTML = '';
      setStatus('Navigation detected — press Play, then Refresh.');
    }
  }, 1500);
})();
