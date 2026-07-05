// ==UserScript==
// @name         Amazon Prime Video Subtitle Downloader
// @namespace    https://github.com/
// @version      4.6.0
// @description  Download all Prime Video subtitles as a ZIP, with search, per-language selection, live progress, SDH/CC/Forced detection, TTML+SRT+VTT output. Season mode captures every episode you play into one ZIP.
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

  const VERSION = '4.6.0';
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
  let seasonMode = localStorage.getItem('apvsd_season') === '1';
  // key: stable episode id -> { label, tracks: [normalized] }
  const seasonEpisodes = new Map();
  const apiResponseTexts = [];
  const fetchedEpisodeMetaIds = new Set();
  let lastCapturedKey = null;
  let pendingSeasonCaptureTimer = null;
  let lastHref = location.href;
  let lastPlayerSignature = '';
  let currentPlaybackTitleId = '';
  let pendingPlaybackTitleId = '';
  const SEASON_STORE_KEY = 'apvsd_season_buffer_v2';
  const SEASON_TEXT_DB = 'apvsd_season_text_v1';
  const SEASON_TEXT_STORE = 'tracks';

  // ----------------------------------------------------------------
  // URL interceptor (must be injected into page context to catch site fetches)
  // ----------------------------------------------------------------
  const interceptorFn = function () {
    const isPlaybackResourcesUrl = (url) => typeof url === 'string' && /\/playback\/(?:prs\/)?(?:GetVodPlaybackResources|GetPlaybackResources)|GetVodPlaybackResources/i.test(url);
    const isPrimeMetadataUrl = (url) => typeof url === 'string' && /primevideo\.com\/api\/|\/gp\/video\/api\//i.test(url);
    const emitUrl = (url) => {
      try { window.dispatchEvent(new CustomEvent('apvsd_prs_url', { detail: { url } })); } catch (e) {}
    };
    const emitBody = (url, body) => {
      try { window.dispatchEvent(new CustomEvent('apvsd_prs_response', { detail: { url, body } })); } catch (e) {}
    };
    const emitRequest = (url, body) => {
      try { window.dispatchEvent(new CustomEvent('apvsd_prs_request', { detail: { url, body: typeof body === 'string' ? body : '' } })); } catch (e) {}
    };
    const emitApiBody = (url, body) => {
      try { window.dispatchEvent(new CustomEvent('apvsd_api_response', { detail: { url, body } })); } catch (e) {}
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
        if (isPrimeMetadataUrl(url)) this.__apvsdApiUrl = url;
      } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        if (this.__apvsdUrl) emitRequest(this.__apvsdUrl, arguments[0]);
        if (this.__apvsdUrl) {
          this.addEventListener('loadend', () => {
            try {
              const body = typeof this.responseText === 'string' ? this.responseText : '';
              if (body) emitBody(this.__apvsdUrl, body);
            } catch (e) {}
          });
        }
        if (this.__apvsdApiUrl) {
          this.addEventListener('loadend', () => {
            try {
              const body = typeof this.responseText === 'string' ? this.responseText : '';
              if (body && /episodeList|episodeNumber|seasonSelector|titleID|compactGTI|playbackEnvelope/i.test(body)) emitApiBody(this.__apvsdApiUrl, body);
            } catch (e) {}
          });
        }
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
    window.fetch = function () {
      let url = '';
      let body = '';
      try {
        const u = arguments[0];
        url = typeof u === 'string' ? u : (u && u.url) || '';
        const init = arguments[1] || {};
        body = typeof init.body === 'string' ? init.body : '';
        if (isPlaybackResourcesUrl(url)) emitUrl(url);
      } catch (e) {}
      const promise = origFetch.apply(this, arguments);
      try {
        if (isPlaybackResourcesUrl(url)) emitRequest(url, body);
        if (isPlaybackResourcesUrl(url)) {
          promise.then((res) => {
            try { res.clone().text().then((body) => body && emitBody(url, body)).catch(() => {}); } catch (e) {}
          }).catch(() => {});
        }
        if (isPrimeMetadataUrl(url)) {
          promise.then((res) => {
            try { res.clone().text().then((body) => body && /episodeList|episodeNumber|seasonSelector|titleID|compactGTI|playbackEnvelope/i.test(body) && emitApiBody(url, body)).catch(() => {}); } catch (e) {}
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
      const tid = titleIdFromPlaybackUrl(playbackResourcesUrl);
      pendingPlaybackTitleId = tid || '';
      if (tid) currentPlaybackTitleId = tid;
      LOG('captured PRS endpoint');
    } catch (e) {}
  });

  window.addEventListener('apvsd_prs_request', (ev) => {
    try {
      const url = ev.detail && ev.detail.url;
      if (url) playbackResourcesUrl = new URL(url, location.href).href;
      const tid = titleIdFromPlaybackUrl(playbackResourcesUrl || url) || titleIdFromAnyText(ev.detail && ev.detail.body);
      pendingPlaybackTitleId = tid || '';
      if (tid) currentPlaybackTitleId = tid;
    } catch (e) {}
  });

  function clearCurrentPlaybackState(message) {
    capturedSubtitleUrls = [];
    cachedTracks = [];
    selection.clear();
    lastCapturedKey = null;
    currentPlaybackTitleId = '';
    pendingPlaybackTitleId = '';
    apiResponseTexts.length = 0;
    fetchedEpisodeMetaIds.clear();
    if (document.getElementById('apvsd-list')) {
      document.getElementById('apvsd-list').innerHTML = '';
      updateCount();
    }
    if (message) setStatus(message);
  }

  window.addEventListener('apvsd_prs_response', (ev) => {
    try {
      const url = ev.detail.url;
      if (url) playbackResourcesUrl = new URL(url, location.href).href;
      const data = JSON.parse(ev.detail.body || '{}');
      const list = extractSubtitleList(data);
      if (list.length) {
        const playbackTitleId = titleIdFromPlaybackUrl(playbackResourcesUrl || url) || pendingPlaybackTitleId;
        currentPlaybackTitleId = playbackTitleId || '';
        pendingPlaybackTitleId = '';
        capturedSubtitleUrls = list;
        cachedTracks = normalizeTracks(list);
        selection.clear();
        cachedTracks.forEach(t => selection.add(t.idx));
        if (document.getElementById('apvsd-panel')) {
          renderList();
          setStatus(`Captured ${cachedTracks.length} subtitle tracks from Prime playback.`);
        }
        LOG('captured subtitle tracks', cachedTracks.length);
        if (seasonMode) {
          const playbackMeta = extractEpisodeMetaFromPlaybackData(data) || {};
          if (playbackTitleId) playbackMeta.titleId = playbackTitleId;
          scheduleSeasonCapture(playbackMeta);
        }
      }
    } catch (e) {}
  });

  window.addEventListener('apvsd_api_response', (ev) => {
    try {
      const body = ev.detail && ev.detail.body;
      if (!body || typeof body !== 'string') return;
      apiResponseTexts.push(body);
      if (apiResponseTexts.length > 30) apiResponseTexts.splice(0, apiResponseTexts.length - 30);
    } catch (_) {}
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

  function persistSeasonBuffer() {
    try {
      const compactTrack = (t, i, epKey) => ({
        idx: Number.isFinite(Number(t.idx)) ? Number(t.idx) : i,
        lang: t.lang || 'und',
        displayName: t.displayName || t.lang || 'UND',
        tags: Array.isArray(t.tags) ? t.tags : [],
        url: t.url,
        format: t.format || 'TTMLV2',
        textCacheKey: ensureTrackCacheKey(epKey, t),
      });
      const episodes = [...seasonEpisodes.entries()].map(([key, ep]) => [key, {
        bufferKey: ep.bufferKey || key,
        show: ep.show || '',
        label: ep.label || '',
        season: ep.season ?? null,
        episode: ep.episode ?? null,
        titleId: ep.titleId || '',
        tracks: Array.isArray(ep.tracks) ? ep.tracks.map((t, i) => compactTrack(t, i, key)).filter(t => t.url) : [],
      }]);
      localStorage.setItem(SEASON_STORE_KEY, JSON.stringify({ version: VERSION, savedAt: Date.now(), episodes }));
    } catch (e) { WARN('season buffer persist failed', e); }
  }

  function restoreSeasonBuffer() {
    try {
      const raw = localStorage.getItem(SEASON_STORE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      const episodes = Array.isArray(data?.episodes) ? data.episodes : [];
      for (const row of episodes) {
        const key = row && row[0];
        const ep = row && row[1];
        if (!key || !ep || !Array.isArray(ep.tracks) || !ep.tracks.length) continue;
        seasonEpisodes.set(key, ep);
      }
      if (seasonEpisodes.size) LOG('restored season buffer', seasonEpisodes.size);
    } catch (e) { WARN('season buffer restore failed', e); }
  }

  function storeSeasonEpisode(key, episode) {
    episode.bufferKey = episode.bufferKey || key;
    if (Array.isArray(episode.tracks)) episode.tracks.forEach(t => ensureTrackCacheKey(key, t));
    seasonEpisodes.set(key, episode);
    persistSeasonBuffer();
    updateSeasonUI();
  }

  function trackFingerprint(t) {
    return [t.lang || 'und', (Array.isArray(t.tags) ? t.tags.join('-') : ''), t.format || '', t.url || ''].join('|');
  }

  function ensureTrackCacheKey(epKey, t) {
    if (!t) return '';
    if (!t.textCacheKey) {
      const raw = `${epKey || 'episode'}::${trackFingerprint(t)}`;
      let hash = 0;
      for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
      t.textCacheKey = `apvsd:${epKey || 'episode'}:${Math.abs(hash).toString(36)}:${t.lang || 'und'}`;
    }
    return t.textCacheKey;
  }

  function openSeasonTextDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(SEASON_TEXT_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SEASON_TEXT_STORE)) db.createObjectStore(SEASON_TEXT_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
  }

  async function idbGet(key) {
    if (!key) return '';
    const db = await openSeasonTextDb();
    return new Promise((resolve) => {
      const tx = db.transaction(SEASON_TEXT_STORE, 'readonly');
      const req = tx.objectStore(SEASON_TEXT_STORE).get(key);
      req.onsuccess = () => resolve(req.result || '');
      req.onerror = () => resolve('');
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    });
  }

  async function idbSet(key, value) {
    if (!key || !value) return;
    const db = await openSeasonTextDb();
    return new Promise((resolve) => {
      const tx = db.transaction(SEASON_TEXT_STORE, 'readwrite');
      tx.objectStore(SEASON_TEXT_STORE).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  }

  async function clearSeasonTextCache() {
    try {
      const db = await openSeasonTextDb();
      await new Promise((resolve) => {
        const tx = db.transaction(SEASON_TEXT_STORE, 'readwrite');
        tx.objectStore(SEASON_TEXT_STORE).clear();
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); resolve(); };
      });
    } catch (_) {}
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

  function sanitizePathPart(name) {
    return String(name || '')
      .replace(/[:*?"<>|\\\/]+/g, '_')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function baseShowTitle(title) {
    return sanitizePathPart(String(title || '')
      .replace(/\s*[-–—]?\s*(?:s(?:æ|ae|e)son|season|staffel|saison|stagione|temporada)\s*\d+\s*$/i, '')
      .replace(/\s*[-–—]?\s*S\d+\s*$/i, ''));
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
  // Season mode: buffer subtitles for every episode played
  // ----------------------------------------------------------------
  function titleIdFromPlaybackUrl(url) {
    if (!url || typeof url !== 'string') return '';
    try {
      const u = new URL(url, location.href);
      for (const name of ['titleID', 'titleId', 'titleid', 'asin', 'ASIN', 'gti', 'GTI']) {
        const value = u.searchParams.get(name);
        if (value && /^[A-Z0-9.:-]{8,}$/i.test(value)) return value.trim();
      }
      const decoded = decodeURIComponent(u.href);
      const m = decoded.match(/(?:titleID|titleId|asin|gti|GTI)[=:]([A-Z0-9.:-]{8,})/i);
      return m ? m[1] : '';
    } catch (_) {
      const m = String(url).match(/(?:titleID|titleId|asin|gti|GTI)[=:]([A-Z0-9.:-]{8,})/i);
      return m ? m[1] : '';
    }
  }

  function titleIdFromAnyText(text) {
    const raw = String(text || '');
    if (!raw) return '';
    const decoded = (() => { try { return decodeURIComponent(raw); } catch (_) { return raw; } })();
    const patterns = [
      /"(?:titleID|titleId|asin|gti|GTI)"\s*:\s*"([A-Z0-9.:-]{8,})"/i,
      /(?:titleID|titleId|asin|gti|GTI)[=:]([A-Z0-9.:-]{8,})/i,
      /\/detail\/([A-Z0-9]{10,})/i,
    ];
    for (const re of patterns) {
      const m = decoded.match(re);
      if (m) return m[1];
    }
    return '';
  }

  function titleIdFromPlaybackData(data) {
    let best = '';
    const seen = new WeakSet();
    const consider = (v) => {
      if (!v || typeof v !== 'object' || best) return;
      const id = firstString(
        v.titleId,
        v.titleID,
        v.gti,
        v.GTI,
        v.catalogId,
        getNested(v, 'detail.catalogId'),
        getNested(v, 'catalogMetadata.catalogId'),
        compactIdFromNode(v),
      );
      if (id && /^[A-Z0-9.:-]{8,}$/i.test(id)) best = id;
    };
    const walk = (v, depth = 0) => {
      if (!v || best || depth > 14) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      if (typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      consider(v);
      for (const val of Object.values(v)) walk(val, depth + 1);
    };
    walk(data);
    return best;
  }

  function getEpisodeMeta() {
    const showEl = document.querySelector('.atvwebplayersdk-title-text');
    const subEl = document.querySelector('.atvwebplayersdk-subtitle-text');
    const fallbackShow = showFallbackTitle();
    const domShow = baseShowTitle(showEl ? showEl.textContent.trim() : '');
    const domMatchesPage = !fallbackShow || !domShow || domShow.toLowerCase() === fallbackShow.toLowerCase();
    const show = fallbackShow || domShow;
    const sub = domMatchesPage && subEl ? subEl.textContent.trim() : '';
    let season = null, episode = null, epTitle = sub;
    const parsed = parseSeasonEpisodeText(sub);
    if (parsed) { season = parsed.season; episode = parsed.episode; epTitle = parsed.title || epTitle; }
    return { show, sub, season, episode, epTitle, titleId: '' };
  }

  function parseSeasonEpisodeText(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    const patterns = [
      /\bS(?:eason|æson|aeson)?\s*(\d+)\s*[\.,:;\-–— ]*\s*E(?:pisode|p)?\s*(\d+)\s*[\.\-–—:]?\s*(.*)$/i,
      /\bS(\d{1,2})\s*E(\d{1,3})\b\s*[\.\-–—:]?\s*(.*)$/i,
      /\b(?:Season|Sæson|Saeson|Temporada|Staffel|Saison|Stagione)\s*(\d+)\D{0,40}\b(?:Episode|Afsnit|Episodio|Folge|Épisode|Ep\.?)\s*(\d+)\s*[\.\-–—:]?\s*(.*)$/i,
      /\b(\d+)\s*[xX]\s*(\d+)\b\s*[\.\-–—:]?\s*(.*)$/i,
    ];
    for (const re of patterns) {
      const m = s.match(re);
      if (m) return { season: Number(m[1]), episode: Number(m[2]), title: (m[3] || '').trim() };
    }
    const epOnly = s.match(/\b(?:Episode|Afsnit|Episodio|Folge|Épisode|Ep\.?)\s*(\d+)\s*[\.\-–—:]?\s*(.*)$/i);
    if (epOnly) return { season: null, episode: Number(epOnly[1]), title: (epOnly[2] || '').trim() };
    return null;
  }

  function metaFromRefUrl(url) {
    const raw = String(url || '');
    const decoded = (() => { try { return decodeURIComponent(raw); } catch (_) { return raw; } })();
    // Only Prime's episode-list refs encode season/episode here. Generic refs
    // like atv_tv_hom_c_*_2_2 are carousel row/slot positions, not S/E numbers.
    const m = decoded.match(/\/detail\/([A-Z0-9]{10,})\/ref=atv_dp_amz_c_TS[^?#\s]*?_(\d+)_(\d+)(?:[?#/&]|$)/i)
      || decoded.match(/[?&]ref=atv_dp_amz_c_TS[^&#\s]*?_(\d+)_(\d+)(?:[&#]|$)/i);
    if (!m) return null;
    const hasTid = m.length === 4;
    return {
      show: showFallbackTitle(),
      sub: '',
      season: Number(hasTid ? m[2] : m[1]),
      episode: Number(hasTid ? m[3] : m[2]),
      epTitle: '',
      titleId: hasTid ? m[1] : (currentDetailGti() || ''),
    };
  }

  function episodeMetaFromCachedPageData(titleId) {
    const target = String(titleId || '');
    if (!target) return null;
    const blobs = [];
    const hyd = readHydrationData();
    if (hyd) blobs.push(hyd);
    for (const txt of apiResponseTexts) {
      try { blobs.push(JSON.parse(txt)); } catch (_) {}
    }
    let best = null;
    let bestScore = 0;
    const asNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const score = (m, exact) => (exact ? 100 : 0) + (m.show ? 8 : 0) + (m.season ? 6 : 0) + (m.episode ? 12 : 0) + (m.epTitle ? 3 : 0) + (m.titleId ? 2 : 0);
    const consider = (v) => {
      if (!v || typeof v !== 'object') return;
      const detail = v.detail || v.titleDetail || v.catalogMetadata || v.catalog || v.metadata || v.productDetails || {};
      const id = firstString(v.titleId, v.titleID, v.gti, v.GTI, v.catalogId, detail.catalogId, compactIdFromNode(v));
      const linkId = extractUrlId(firstString(v.url, v.href, v.watchUrl, v.playbackUrl, getNested(v, 'link.url'), getNested(v, 'pageLink.url')));
      const exact = !!target && (id === target || linkId === target);
      if (!exact) return;
      const titleType = String(v.titleType || detail.titleType || v.entityType || v.contentType || '').toLowerCase();
      const parsedText = parseSeasonEpisodeText(firstString(v.subtitle, v.secondaryText, v.description, v.synopsis, v.title, v.name, detail.title));
      const meta = {
        show: baseShowTitle(firstString(v.seriesTitle, v.showTitle, v.parentTitle, v.parentTitleName, detail.seriesTitle, detail.showTitle, detail.parentTitle, showFallbackTitle())),
        sub: '',
        season: asNum(v.seasonNumber ?? v.seasonIndex ?? v.season ?? detail.seasonNumber ?? detail.seasonIndex ?? detail.season) ?? parsedText?.season ?? null,
        episode: asNum(v.episodeNumber ?? v.episodeIndex ?? v.episodeSequence ?? v.sequenceNumber ?? v.episode ?? detail.episodeNumber ?? detail.episodeIndex ?? detail.sequenceNumber) ?? parsedText?.episode ?? null,
        epTitle: firstString(v.episodeTitle, v.title, v.titleName, v.name, v.displayTitle, detail.episodeTitle, detail.title, parsedText?.title),
        titleId: id || linkId,
      };
      if (!/episode/i.test(titleType) && !meta.episode && !meta.season) return;
      if (meta.epTitle && meta.show && meta.epTitle.toLowerCase() === meta.show.toLowerCase()) meta.epTitle = '';
      const s = score(meta, exact);
      if (s > bestScore) { best = meta; bestScore = s; }
    };
    const seen = new WeakSet();
    const walk = (v, depth = 0) => {
      if (!v || depth > 20) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      if (typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      consider(v);
      for (const val of Object.values(v)) walk(val, depth + 1);
    };
    for (const blob of blobs) walk(blob);
    return best;
  }

  async function fetchEpisodeMetaByTitleId(titleId) {
    const target = String(titleId || '');
    if (!target) return null;
    const localePrefix = (location.pathname.match(/^\/[-\w]+\/[-\w]+\//) || [''])[0].replace(/\/$/, '');
    const variants = [
      `/gp/video/api/getDetailPage?titleID=${encodeURIComponent(target)}&isElcano=true&sections=Atf,Btf`,
      `/api/getDetailPage?titleID=${encodeURIComponent(target)}&isElcano=true&sections=Atf,Btf`,
      localePrefix ? `${localePrefix}/gp/video/api/getDetailPage?titleID=${encodeURIComponent(target)}&isElcano=true&sections=Atf,Btf` : '',
    ];
    for (const path of variants.filter(Boolean)) {
      try {
        const res = await fetch(path, { credentials: 'include', headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' } });
        if (!res.ok) continue;
        const txt = await res.text();
        if (txt) {
          apiResponseTexts.push(txt);
          if (apiResponseTexts.length > 30) apiResponseTexts.splice(0, apiResponseTexts.length - 30);
          const found = episodeMetaFromCachedPageData(target);
          if (found) return found;
        }
      } catch (_) {}
    }
    try {
      const res = await fetch(`/detail/${encodeURIComponent(target)}/`, { credentials: 'include' });
      if (res.ok) {
        const hyd = readHydrationDataFromText(await res.text());
        if (hyd) {
          apiResponseTexts.push(JSON.stringify(hyd));
          if (apiResponseTexts.length > 30) apiResponseTexts.splice(0, apiResponseTexts.length - 30);
          return episodeMetaFromCachedPageData(target);
        }
      }
    } catch (_) {}
    return null;
  }

  async function enrichSeasonEpisode(key, titleId) {
    if (!key || !titleId || fetchedEpisodeMetaIds.has(titleId)) return;
    fetchedEpisodeMetaIds.add(titleId);
    const meta = await fetchEpisodeMetaByTitleId(titleId).catch(() => null);
    if (!meta || !seasonEpisodes.has(key)) return;
    const ep = seasonEpisodes.get(key);
    const before = episodeFileBase(ep);
    ep.show = meta.show || ep.show;
    if (meta.season != null) ep.season = meta.season;
    if (meta.episode != null) ep.episode = meta.episode;
    if (meta.epTitle) ep.label = episodeLabel(meta);
    ep.titleId = meta.titleId || ep.titleId;
    storeSeasonEpisode(key, ep);
    const after = episodeFileBase(ep);
    if (after !== before) setStatus(`Updated ${after} · ${ep.tracks.length} tracks · ${seasonEpisodes.size} buffered.`);
  }

  function mergeEpisodeMeta(...parts) {
    const out = { show: '', sub: '', season: null, episode: null, epTitle: '', titleId: '' };
    for (const meta of parts) {
      if (!meta) continue;
      if (!out.show && meta.show) out.show = baseShowTitle(meta.show);
      if (!out.sub && meta.sub) out.sub = meta.sub;
      if (out.season == null && meta.season != null) out.season = Number(meta.season);
      if (out.episode == null && meta.episode != null) out.episode = Number(meta.episode);
      if (!out.epTitle && meta.epTitle) out.epTitle = meta.epTitle;
      if (!out.titleId && meta.titleId) out.titleId = meta.titleId;
    }
    if (!out.show) out.show = showFallbackTitle();
    return out;
  }

  function isUsefulEpisodeMeta(meta) {
    if (!meta) return false;
    return !!(meta.titleId || meta.episode != null || meta.season != null || meta.epTitle || meta.sub);
  }

  function extractEpisodeMetaFromPlaybackData(data) {
    const best = { show: '', sub: '', season: null, episode: null, epTitle: '', titleId: '' };
    const seen = new WeakSet();
    const asNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const score = (m) => (m.show ? 4 : 0) + (m.epTitle ? 3 : 0) + (m.season ? 2 : 0) + (m.episode ? 5 : 0) + (m.titleId ? 2 : 0);
    let bestScore = 0;
    const consider = (v) => {
      if (!v || typeof v !== 'object') return;
      const detail = v.detail || v.titleDetail || v.catalogMetadata || v.catalog || v.metadata || v.productDetails || {};
      const candidate = {
        show: baseShowTitle(firstString(
          v.seriesTitle,
          v.showTitle,
          v.parentTitle,
          v.parentTitleName,
          v.familyTitle,
          detail.seriesTitle,
          detail.showTitle,
          detail.parentTitle,
          detail.familyTitle,
          v.titleName && (v.episodeNumber || v.seasonNumber) ? '' : v.titleName
        )),
        sub: '',
        season: asNum(v.seasonNumber ?? v.seasonIndex ?? v.season ?? detail.seasonNumber ?? detail.seasonIndex ?? detail.season),
        episode: asNum(v.episodeNumber ?? v.episodeIndex ?? v.episodeSequence ?? v.sequenceNumber ?? v.episode ?? detail.episodeNumber ?? detail.episodeIndex ?? detail.sequenceNumber),
        epTitle: firstString(v.episodeTitle, v.title, v.titleName, v.name, v.displayTitle, detail.episodeTitle, detail.title, detail.titleName),
        titleId: firstString(v.titleId, v.titleID, v.gti, v.GTI, v.catalogId, detail.catalogId, compactIdFromNode(v)),
      };
      if (candidate.epTitle && candidate.show && candidate.epTitle.toLowerCase() === candidate.show.toLowerCase()) candidate.epTitle = '';
      const s = score(candidate);
      if (s > bestScore && (candidate.episode || /episode/i.test(String(v.titleType || detail.titleType || '')))) {
        Object.assign(best, candidate);
        bestScore = s;
      }
    };
    const walk = (v, depth = 0) => {
      if (!v || depth > 16) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      if (typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      consider(v);
      for (const val of Object.values(v)) walk(val, depth + 1);
    };
    walk(data);
    return bestScore ? best : null;
  }

  function shortHash(value) {
    const raw = String(value || '');
    let hash = 0;
    for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
    return Math.abs(hash).toString(36);
  }

  function tracksFingerprint(tracks) {
    return (tracks || []).map(t => trackFingerprint(t)).join('||');
  }

  function episodeKey(meta, tracks) {
    if (meta.titleId) return `title::${String(meta.titleId)}`;
    const fp = tracksFingerprint(tracks || meta.tracks || []);
    if (fp) return `tracks::${shortHash(fp)}`;
    if (meta.show && meta.season != null && meta.episode != null) {
      return `${meta.show}::S${String(meta.season).padStart(2, '0')}E${String(meta.episode).padStart(2, '0')}`;
    }
    // Fallback: full title text
    return `${meta.show}::${meta.sub || 'unknown'}`;
  }

  function episodeLabel(meta) {
    if (meta.season != null && meta.episode != null) {
      const se = `S${String(meta.season).padStart(2, '0')}E${String(meta.episode).padStart(2, '0')}`;
      return meta.epTitle ? `${se}.${sanitize(meta.epTitle)}` : se;
    }
    return sanitize(meta.sub || meta.show || 'Episode');
  }

  function episodeFileBase(ep) {
    const show = sanitizePathPart(baseShowTitle(ep.show) || ep.show || 'Season');
    const season = String(ep.season || 1).padStart(2, '0');
    if (ep.episode != null && Number(ep.episode) > 0) {
      return `${show}.S${season}.E${String(ep.episode).padStart(2, '0')}`;
    }
    const fallback = sanitize(ep.label && ep.label !== 'Episode' ? ep.label : shortHash(ep.titleId || ep.bufferKey || tracksFingerprint(ep.tracks))).replace(/^\.+|\.+$/g, '') || 'UnknownEpisode';
    return `${show}.S${season}.${fallback}`;
  }

  function captureCurrentEpisode(metaOverride) {
    if (!cachedTracks.length) return;
    const playbackTitleId = metaOverride?.titleId || currentPlaybackTitleId || titleIdFromPlaybackUrl(playbackResourcesUrl) || '';
    const pageMeta = episodeMetaFromCachedPageData(playbackTitleId);
    const refMeta = metaFromRefUrl(location.href);
    const domMeta = getEpisodeMeta();
    const safeOverride = metaOverride && (!playbackTitleId || !metaOverride.titleId || metaOverride.titleId === playbackTitleId) ? metaOverride : null;
    const fallbackShow = showFallbackTitle();
    const domShow = (domMeta.show || '').toLowerCase();
    const fallbackShowLower = (fallbackShow || '').toLowerCase();
    const pageShow = (pageMeta?.show || safeOverride?.show || '').toLowerCase();
    const domLooksCurrent = !playbackTitleId || !domShow || domShow === fallbackShowLower || domShow === pageShow;
    const meta = mergeEpisodeMeta(
      pageMeta,
      isUsefulEpisodeMeta(safeOverride) ? safeOverride : null,
      refMeta && (!playbackTitleId || refMeta.titleId === playbackTitleId) ? refMeta : null,
      domLooksCurrent ? domMeta : null,
      playbackTitleId ? { titleId: playbackTitleId } : null,
    );
    const key = episodeKey(meta, cachedTracks);
    lastCapturedKey = key;
    const episode = {
      show: meta.show,
      label: episodeLabel(meta),
      season: meta.season,
      episode: meta.episode,
      titleId: meta.titleId,
      bufferKey: key,
      tracks: cachedTracks.map(t => ({ ...t })),
    };
    storeSeasonEpisode(key, episode);
    setStatus(`Stored ${episodeFileBase(episode)} · ${episode.tracks.length} tracks · ${seasonEpisodes.size} buffered.`);
    LOG('season buffer stored', key, 'total', seasonEpisodes.size, meta);
    // Immediately prefetch subtitle text so that a later "Download Season
    // ZIP" still works even after Prime's signed subtitle URLs expire or the
    // user navigates away from the episode.
    prefetchEpisodeTracks(key, episode);
    if (meta.titleId && (meta.season == null || meta.episode == null || !meta.epTitle)) enrichSeasonEpisode(key, meta.titleId);
  }

  async function prefetchEpisodeTracks(key, episode) {
    const tracks = episode.tracks || [];
    await runPool(tracks.filter(t => t.url && !t.text), async (t) => {
      try {
        const cacheKey = ensureTrackCacheKey(key, t);
        const cached = await idbGet(cacheKey).catch(() => '');
        if (cached) { t.text = cached; return true; }
        const text = await fetchSubtitleText(t.url);
        if (text) {
          t.text = text;
          await idbSet(cacheKey, text).catch(() => {});
        }
        return true;
      } catch (e) { WARN('prefetch failed', t.lang, e && e.message); }
      return false;
    });
    persistSeasonBuffer();
    updateSeasonUI();
    const cached = tracks.filter(t => t.text).length;
    LOG('prefetched', cached, '/', tracks.length, 'for', key);
  }

  async function getSeasonTrackText(ep, t) {
    if (t.text) return t.text;
    const cacheKey = ensureTrackCacheKey(episodeKey(ep), t);
    const cached = await idbGet(cacheKey).catch(() => '');
    if (cached) { t.text = cached; return cached; }
    const text = await fetchSubtitleText(t.url);
    if (text) {
      t.text = text;
      await idbSet(cacheKey, text).catch(() => {});
    }
    return text;
  }

  function playerSignature() {
    const title = document.querySelector('.atvwebplayersdk-title-text')?.textContent?.trim() || '';
    const sub = document.querySelector('.atvwebplayersdk-subtitle-text')?.textContent?.trim() || '';
    return `${title}|${sub}`;
  }

  function scheduleSeasonCapture(metaOverride) {
    if (!seasonMode || !cachedTracks.length) return;
    clearTimeout(pendingSeasonCaptureTimer);
    const startSig = playerSignature();
    let tries = 0;
    const tick = () => {
      tries++;
      const sig = playerSignature();
      const domLooksReady = sig && sig !== lastPlayerSignature && sig !== startSig;
      if (domLooksReady || tries >= 10 || (metaOverride && (metaOverride.titleId || metaOverride.episode))) {
        pendingSeasonCaptureTimer = null;
        lastPlayerSignature = sig || lastPlayerSignature;
        captureCurrentEpisode(metaOverride);
        return;
      }
      pendingSeasonCaptureTimer = setTimeout(tick, 350);
    };
    pendingSeasonCaptureTimer = setTimeout(tick, 350);
  }

  function updateSeasonUI() {
    const badge = document.getElementById('apvsd-season-count');
    const btn = document.getElementById('apvsd-season-dl');
    const wrap = document.getElementById('apvsd-season-row');
    if (!badge || !btn || !wrap) return;
    wrap.style.display = seasonMode ? '' : 'none';
    const n = seasonEpisodes.size;
    badge.textContent = n === 1 ? '1 episode' : `${n} episodes`;
    btn.disabled = n === 0;
    btn.textContent = n > 0 ? `Download Season ZIP (${n})` : 'Download Season ZIP';
  }

  async function downloadSeasonZip() {
    if (!seasonEpisodes.size) { setStatus('Season buffer is empty. Play an episode first.'); return; }

    // If the user has an active selection on the current episode, treat those
    // languages/tag combos as a filter applied to every buffered episode.
    let langFilter = null;
    if (cachedTracks.length && selection.size && selection.size < cachedTracks.length) {
      langFilter = new Set([...selection].map(i => cachedTracks[i] && cachedTracks[i].lang).filter(Boolean));
    }

    const orderedEpisodes = [...seasonEpisodes.values()].sort((a, b) => (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0));
    const firstEpisode = orderedEpisodes.find(e => e.show) || orderedEpisodes[0];
    const showName = sanitizePathPart(baseShowTitle(firstEpisode?.show) || showFallbackTitle() || 'Season');
    const seasonNo = firstEpisode?.season ? `.S${String(firstEpisode.season).padStart(2, '0')}` : '';
    const zip = new JSZip();
    const errors = [];
    let totalTracks = 0;
    const jobs = [];
    for (const ep of orderedEpisodes) {
      const tracks = langFilter ? ep.tracks.filter(t => langFilter.has(t.lang)) : ep.tracks;
      for (const t of tracks) jobs.push({ ep, t });
    }
    totalTracks = jobs.length;
    if (!totalTracks) { setStatus('No tracks match the current language filter.'); return; }

    setStatus(`Downloading ${totalTracks} tracks across ${seasonEpisodes.size} episodes…`);
    showProgress(totalTracks);
    const t0 = performance.now();
    let okCount = 0;

    await runPool(jobs, async ({ ep, t }) => {
      let text = '';
      try { text = await getSeasonTrackText(ep, t); }
      catch (e) { errors.push(`${ep.label} ${t.lang}: fetch ${e.message}`); return false; }
      if (!text) { errors.push(`${ep.label} ${t.lang}: empty response`); return false; }
      const tagSuffix = t.tags.length ? '.' + t.tags.join('-').toLowerCase() : '';
      const folder = showName;
      const base = `${episodeFileBase({ ...ep, show: ep.show || showName })}.${t.lang}${tagSuffix}`;
      const rawIsVTT = isWebVTT(text);
      const rawExt = rawIsVTT ? 'vtt' : 'ttml';
      if (outputFormat === 'ttml' || outputFormat === 'both') {
        const rawOut = stripFormatting ? stripSubFormatting(text) : text;
        zip.file(`${folder}/${base}.${rawExt}`, rawOut);
      }
      if (outputFormat === 'srt' || outputFormat === 'both') {
        let srt = toSRT(text, t.lang);
        if (srt && stripFormatting) srt = stripSubFormatting(srt);
        if (srt) zip.file(`${folder}/${base}.srt`, srt);
        else errors.push(`${folder}/${base}: SRT conversion failed`);
      }
      okCount++;
      return true;
    }, (done) => updateProgress(done, totalTracks, 0));

    persistSeasonBuffer();

    if (!okCount) { hideProgress(); setStatus(`All ${totalTracks} downloads failed.`); return; }
    if (errors.length) zip.file('_errors.txt', errors.join('\n'));

    setStatus('Generating season zip…');
    const blob = await zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
      (m) => updateProgress(totalTracks, totalTracks, Math.round(m.percent))
    );
    saveBlob(blob, `${showName}${seasonNo}.subs.zip`);
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(`Season done · ${okCount}/${totalTracks} tracks · ${seasonEpisodes.size} episodes · ${dt}s`);
    hideProgress();
  }

  // ----------------------------------------------------------------
  // Season auto-scan: enumerate episodes from the show/season page and
  // fetch each episode's subtitles without requiring the user to press Play.
  // ----------------------------------------------------------------
  function currentDetailGti() {
    const m = location.pathname.match(/\/detail\/([A-Z0-9]+)/i);
    return m ? m[1] : null;
  }

  function readHydrationDataFromText(text) {
    if (!text) return null;
    const m = String(text).match(/<script[^>]+id=["']dv-web-page-hydration-data["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (_) { return null; }
  }

  function readHydrationData() {
    const el = document.getElementById('dv-web-page-hydration-data');
    if (!el) return null;
    try { return JSON.parse(el.textContent || '{}'); } catch (_) { return null; }
  }

  function currentPageTitleId() {
    const hyd = readHydrationData();
    const atf = hyd?.init?.preparations?.body?.atf?.state;
    const btf = hyd?.init?.preparations?.body?.btf?.state;
    return atf?.pageTitleId || btf?.pageTitleId || currentDetailGti();
  }

  function getNested(obj, path) {
    try { return path.split('.').reduce((acc, key) => acc && acc[key], obj); } catch (_) { return undefined; }
  }

  function firstString(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  }

  function extractUrlId(value) {
    if (!value || typeof value !== 'string') return '';
    const m = value.match(/\/detail\/([A-Z0-9]{10,})/i) || value.match(/titleID=([A-Z0-9]{10,})/i);
    return m ? m[1] : '';
  }

  function compactIdFromNode(v) {
    if (!v || typeof v !== 'object') return '';
    return firstString(
      v.compactGTI,
      v.compactGti,
      v.compactId,
      v.contentId,
      v.asin,
      getNested(v, 'self.compactGTI'),
      getNested(v, 'self.compactGti'),
      extractUrlId(firstString(v.url, v.href, v.watchUrl, v.playbackUrl, getNested(v, 'link.url'), getNested(v, 'self.link'), getNested(v, 'pageLink.url'))),
    );
  }

  function showFallbackTitle() {
    const hyd = readHydrationData();
    const states = [hyd?.init?.preparations?.body?.atf?.state, hyd?.init?.preparations?.body?.btf?.state].filter(Boolean);
    for (const st of states) {
      const id = st.pageTitleId;
      const detail = st.detail?.headerDetail?.[id] || st.detail?.detail?.[id] || st.detail?.btfMoreDetails?.[id];
      const title = baseShowTitle(detail?.parentTitle || detail?.title || '');
      if (title) return title;
    }
    const metaTitle = document.querySelector('meta[name="title"], meta[property="og:title"]')?.content || document.title || '';
    const cleanMeta = metaTitle.replace(/^Prime Video:\s*/i, '').replace(/^Se\s+/i, '').replace(/\s+[–-]\s+Prime Video$/i, '');
    return baseShowTitle(document.querySelector('h1, [data-automation-id="title"]')?.textContent || cleanMeta || '');
  }

  async function primeAutoScroll() {
    // Prime lazy-mounts the episode list on scroll. Nudge the page a few times
    // and wait between passes so their virtualized list can fill in.
    const y0 = window.scrollY;
    for (let i = 0; i < 6; i++) {
      window.scrollTo({ top: (i + 1) * (window.innerHeight * 0.8), behavior: 'auto' });
      await new Promise(r => setTimeout(r, 300));
    }
    // Try to click any "See all episodes" / episode-list toggle if present.
    const opener = document.querySelector('[data-testid*="episodes"] button, [data-automation-id*="episodes"] button');
    if (opener) { try { opener.click(); } catch (_) {} await new Promise(r => setTimeout(r, 400)); }
    window.scrollTo({ top: y0, behavior: 'auto' });
  }

  async function fetchSeasonWidget(seriesGti) {
    // Prime's current React app exposes the real episode list through
    // getDetailPage when titleID is the page's full amzn1.dv.gti.* id. Older
    // pages can still answer getDetailWidgets, so query both and mine them.
    const titleId = currentPageTitleId() || seriesGti;
    const localePrefix = (location.pathname.match(/^\/-\/[a-z]{2}(?:-[A-Z]{2})?\//) || [''])[0].replace(/\/$/, '');
    const episodeWidgets = encodeURIComponent(JSON.stringify([{ widgetType: 'EpisodeList' }, { widgetType: 'SeasonSelector' }]));
    const variants = [
      `/gp/video/api/getDetailPage?titleID=${encodeURIComponent(titleId)}&isElcano=true&sections=Btf`,
      `/api/getDetailPage?titleID=${encodeURIComponent(titleId)}&isElcano=true&sections=Btf`,
      localePrefix ? `${localePrefix}/gp/video/api/getDetailPage?titleID=${encodeURIComponent(titleId)}&isElcano=true&sections=Btf` : '',
      `/gp/video/api/getDetailWidgets?titleID=${encodeURIComponent(titleId)}&isElcano=true&widgets=${episodeWidgets}`,
      `/api/getDetailWidgets?titleID=${encodeURIComponent(titleId)}&isElcano=true&widgets=${episodeWidgets}`,
    ];
    const results = [];
    for (const path of variants.filter(Boolean)) {
      try {
        const res = await fetch(path, { credentials: 'include', headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' } });
        if (!res.ok) continue;
        const txt = await res.text();
        apiResponseTexts.push(txt);
        if (apiResponseTexts.length > 30) apiResponseTexts.splice(0, apiResponseTexts.length - 30);
        try { results.push(JSON.parse(txt)); } catch (_) {}
      } catch (_) {}
    }
    return results;
  }

  function collectEpisodeObjects(data, sink, showFallback) {
    const consider = (v) => {
      if (!v || typeof v !== 'object') return;
      const detail = v.detail || v.titleDetail || v.metadata || v.productDetails || {};
      const self = v.self || {};
      const epNum = v.episodeNumber ?? v.episodeIndex ?? v.episodeSequence ?? v.sequenceNumber ?? detail.episodeNumber ?? detail.episodeIndex ?? detail.sequenceNumber;
      const snNum = v.seasonNumber ?? v.seasonIndex ?? detail.seasonNumber ?? detail.seasonIndex ?? detail.season;
      const titleType = String(v.titleType || detail.titleType || self.titleType || '').toLowerCase();
      if (epNum == null && titleType !== 'episode') return;
      const en = Number(epNum || detail.episodeNumber || v.number);
      if (!Number.isFinite(en) || en <= 0) return;
      const compact = compactIdFromNode(v);
      const rawId = firstString(v.titleId, v.titleID, v.gti, v.GTI, v.catalogId, detail.catalogId, self.gti, compact);
      const key = compact || rawId;
      if (!key || sink.has(key)) return;
      const link = firstString(v.watchUrl, v.playbackUrl, v.href, v.url, getNested(v, 'link.url'), getNested(v, 'self.link'), getNested(v, 'pageLink.url'));
      const url = link && /\/detail\//i.test(link) ? link : (compact ? `/detail/${compact}/` : '');
      if (!url) return;
      const title = firstString(v.title, v.episodeTitle, v.name, v.displayTitle, detail.title, detail.episodeTitle);
      const show = baseShowTitle(firstString(v.seriesTitle, v.showTitle, v.parentTitle, detail.parentTitle, showFallback));
      sink.set(key, {
        titleId: key,
        show,
        season: Number(snNum) > 0 ? Number(snNum) : null,
        episode: en,
        title: title && title !== show ? title : '',
        url,
      });
    };

    const seen = new WeakSet();
    const walk = (v, depth = 0) => {
      if (!v || depth > 24) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      if (typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      consider(v);
      for (const val of Object.values(v)) walk(val, depth + 1);
    };
    walk(data);
  }

  async function scrapeSeasonEpisodes() {
    // 1. Nudge the page so lazy widgets mount their DOM/JSON.
    try { await primeAutoScroll(); } catch (_) {}

    const found = new Map();
    const showFallback = showFallbackTitle();

    const consider = (v) => {
      if (!v || typeof v !== 'object') return;
      const tid = compactIdFromNode(v) || v.titleId || v.titleID || v.gti || v.GTI || v.compactGTI || v.contentId || v.asin;
      const titleType = String(v.titleType || v.entityType || v.contentType || '').toLowerCase();
      const explicitEpisodeNum = v.episodeNumber ?? v.episodeIndex ?? v.episodeSequence ?? v.episode;
      if (/season|series|show/.test(titleType) && explicitEpisodeNum == null) return;
      const epNum = explicitEpisodeNum ?? (/episode/.test(titleType) ? v.sequenceNumber : undefined) ?? v.number;
      const snNum = v.seasonNumber ?? v.seasonIndex ?? v.season;
      if (!tid || epNum == null) return;
      const en = Number(epNum);
      if (!Number.isFinite(en) || en <= 0) return;
      const sn = Number(snNum);
      const title = (v.title || v.episodeTitle || v.name || v.displayTitle || v.heading || '').toString().trim();
      const show = baseShowTitle(v.seriesTitle || v.showTitle || v.parentTitle || showFallback || '');
      let url = v.watchUrl || v.playbackUrl || v.href || v.url
        || (v.playbackAction && (v.playbackAction.url || v.playbackAction.link))
        || (v.link && v.link.url) || '';
      if (!url || !/\/(?:gp\/video\/)?detail\//i.test(url)) url = `/detail/${tid}/`;
      if (!found.has(String(tid))) {
        found.set(String(tid), {
          titleId: String(tid),
          show,
          season: Number.isFinite(sn) && sn > 0 ? sn : null,
          episode: en,
          title,
          url,
        });
      }
    };

    const seen = new WeakSet();
    const walk = (v, depth = 0) => {
      if (!v || depth > 20) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      if (typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      consider(v);
      for (const val of Object.values(v)) walk(val, depth + 1);
    };

    // 2. Mine every inline JSON blob on the page.
    const scripts = document.querySelectorAll('script[type="text/template"], script[type="application/json"], script[type="application/ld+json"], script:not([src])');
    for (const s of scripts) {
      const txt = s.textContent || s.innerHTML;
      if (!txt || txt.length < 40) continue;
      // Cheap prefilter: only parse blobs that look like they might carry episodes.
      if (!/episode/i.test(txt) && !/titleI[dD]/.test(txt)) continue;
      try { walk(JSON.parse(txt)); continue; } catch (_) {}
      // Fallback: pull any embedded JSON objects that look episode-shaped.
      const objRe = /\{[^{}]{0,4000}"(?:episodeNumber|episodeSequence|sequenceNumber)"\s*:\s*\d+[^{}]{0,4000}\}/g;
      let mm;
      while ((mm = objRe.exec(txt))) {
        try { walk(JSON.parse(mm[0])); } catch (_) {}
      }
    }

    // 3. Crawl DOM anchor tags for episode links (post-lazy-load).
    document.querySelectorAll('[data-testid*="episode"] a, [data-automation-id*="ep-list"] a, [data-automation-id*="episode"] a, a[href*="/detail/"], a[href*="/gp/video/detail/"]').forEach(a => {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/(?:gp\/video\/)?detail\/([A-Z0-9]+)/i);
      if (!m) return;
      const tid = m[1];
      if (found.has(tid)) return;
      // Look for episode number/title in the anchor or its ancestors.
      const scope = a.closest('li, article, [data-testid], [data-automation-id]') || a;
      const scopeText = (scope.textContent || '').trim();
      const em = scopeText.match(/(?:S(?:eason)?\s*(\d+))?\D*(?:E(?:pisode|p)?\.?\s*|Folge\s*|Épisode\s*|Episodio\s*)(\d+)\s*[\.\-–:]?\s*([^\n]{0,80})/i);
      if (!em) return;
      found.set(tid, {
        titleId: tid,
        show: showFallback,
        season: em[1] ? Number(em[1]) : null,
        episode: Number(em[2]),
        title: (em[3] || '').trim().replace(/\s{2,}.*$/, ''),
        url: href,
      });
    });

    const hyd = readHydrationData();
    if (hyd) collectEpisodeObjects(hyd, found, showFallback);
    for (const txt of apiResponseTexts) {
      try { collectEpisodeObjects(JSON.parse(txt), found, showFallback); } catch (_) {}
    }

    return [...found.values()].sort((a, b) => (a.season || 0) - (b.season || 0) || a.episode - b.episode);
  }

  // Prime encodes season/episode straight into the anchor's ref parameter, e.g.
  //   /detail/<GTI>/ref=atv_dp_amz_c_TS<hash>_<season>_<episode>
  // Scanning the raw document HTML (and any fetched page HTML) with this regex
  // is the most reliable way to enumerate every episode of the current season.
  function extractRefEpisodesFromHtml(html, sink, showFallback) {
    if (!html) return;
    const re = /(?:\/[-\w]+\/[-\w]+)?\/detail\/([A-Z0-9]{20,})\/ref=atv_dp_amz_c_TS[a-z0-9]+_(\d+)_(\d+)[^"'\s]*/gi;
    let m;
    while ((m = re.exec(html))) {
      const [full, tid, sn, ep] = m;
      const key = String(tid);
      if (sink.has(key)) continue;
      // Try to find a title near the anchor — <img alt="..."> or aria-label.
      const window = html.slice(Math.max(0, m.index - 400), m.index + full.length + 400);
      const isExplicitEpisodeCard = /data-card-entity-type="Episode"|titleType["']?\s*[:=]\s*["']episode|episodeNumber|episodeTitle|\b(?:episode|afsnit|folge|épisode|episodio)\b|\bS\s*\d+\s*E\s*\d+/i.test(window);
      const entityType = window.match(/data-card-entity-type="([^"]+)"/i)?.[1] || '';
      if (!isExplicitEpisodeCard && entityType && !/episode/i.test(entityType)) continue;
      let title = '';
      const altM = window.match(/\balt="([^"]{2,120})"/);
      const ariaM = window.match(/aria-label="([^"]{2,120})"/);
      title = (ariaM && ariaM[1]) || (altM && altM[1]) || '';
      // Strip generic show-name-only alts (they duplicate the show).
      if (title && showFallback && title.trim().toLowerCase() === showFallback.trim().toLowerCase()) title = '';
      const cleanTitle = title.trim();
      sink.set(key, {
        titleId: key,
        show: showFallback,
        season: Number(sn),
        episode: Number(ep),
        title: cleanTitle && cleanTitle !== showFallback ? cleanTitle : '',
        url: full.startsWith('/detail/') ? full : full.replace(/^\/[-\w]+\/[-\w]+/, ''),
      });
    }
  }

  async function scrapeSeasonEpisodesWithApi() {
    const list = await scrapeSeasonEpisodes();
    const found = new Map(list.map(e => [e.titleId, e]));
    const showFallback = showFallbackTitle();

    // Primary reliable path: regex-sweep the rendered document HTML for
    // /detail/<GTI>/ref=atv_dp_amz_c_TS..._S_E anchors.
    try {
      extractRefEpisodesFromHtml(document.documentElement.outerHTML, found, showFallback);
    } catch (_) {}

    const hyd = readHydrationData();
    if (hyd) collectEpisodeObjects(hyd, found, showFallback);
    for (const txt of apiResponseTexts) {
      try { collectEpisodeObjects(JSON.parse(txt), found, showFallback); } catch (_) {}
    }

    if (found.size >= 2) {
      LOG('scrape found', found.size, 'episodes via ref-parameter sweep');
      return [...found.values()].sort((a, b) => (a.season || 0) - (b.season || 0) || a.episode - b.episode);
    }

    // Fallback: hit Prime's detail widget API.
    const gti = currentDetailGti();
    if (!gti) return [...found.values()];
    LOG('scrape found', found.size, 'episodes; querying getDetailWidgets fallback for', gti);
    const blobs = await fetchSeasonWidget(gti);
    for (const b of blobs) {
      try {
        // Widget responses come back as JSON; stringify and re-sweep for anchor refs too.
        extractRefEpisodesFromHtml(JSON.stringify(b), found, showFallback);
        collectEpisodeObjects(b, found, showFallback);
      } catch (_) {}
    }
    const seen = new WeakSet();
    const walk = (v, depth = 0) => {
      if (!v || depth > 20) return;
      if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
      if (typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      const tid = compactIdFromNode(v) || v.titleId || v.titleID || v.gti || v.GTI || v.compactGTI || v.contentId;
      const titleType = String(v.titleType || v.entityType || v.contentType || '').toLowerCase();
      const explicitEpisodeNum = v.episodeNumber ?? v.episodeSequence ?? v.episode;
      if (/season|series|show/.test(titleType) && explicitEpisodeNum == null) {
        for (const val of Object.values(v)) walk(val, depth + 1);
        return;
      }
      const epNum = explicitEpisodeNum ?? (/episode/.test(titleType) ? v.sequenceNumber : undefined) ?? v.number;
      const snNum = v.seasonNumber ?? v.seasonIndex;
      if (tid && epNum != null && Number.isFinite(Number(epNum)) && Number(epNum) > 0) {
        const key = String(tid);
        if (!found.has(key)) {
          found.set(key, {
            titleId: key,
            show: (v.seriesTitle || v.showTitle || showFallback || '').toString().trim(),
            season: Number(snNum) > 0 ? Number(snNum) : null,
            episode: Number(epNum),
            title: (v.title || v.episodeTitle || v.name || v.displayTitle || '').toString().trim(),
            url: v.watchUrl || v.href || v.url || `/detail/${key}/`,
          });
        }
      }
      for (const val of Object.values(v)) walk(val, depth + 1);
    };
    for (const b of blobs) walk(b);
    return [...found.values()].sort((a, b) => (a.season || 0) - (b.season || 0) || a.episode - b.episode);
  }

  async function fetchEpisodeEnvelope(pageUrl) {
    const abs = pageUrl.startsWith('http') ? pageUrl : new URL(pageUrl, location.origin).href;
    const res = await fetch(abs, { credentials: 'include' });
    if (!res.ok) throw new Error(`page HTTP ${res.status}`);
    const html = await res.text();
    const direct = findPlaybackEnvelopeInText(html);
    if (direct) return direct;
    const scriptRe = /<script[^>]*type="text\/template"[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = scriptRe.exec(html))) {
      try {
        const data = JSON.parse(m[1]);
        const found = findPlaybackEnvelopeDeep(data);
        if (found) return found;
      } catch (_) {}
      const t = findPlaybackEnvelopeInText(m[1]);
      if (t) return t;
    }
    return null;
  }

  async function fetchSubsForEnvelope(envelope) {
    const urls = [...new Set([playbackResourcesUrl, defaultPRSUrl()].filter(Boolean))];
    let lastErr = 'no PRS endpoint';
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            globalParameters: { deviceCapabilityFamily: 'WebPlayer', playbackEnvelope: envelope },
            timedTextUrlsRequest: { supportedTimedTextFormats: ['TTMLv2', 'DFXP', 'WEBVTT', 'VTT'] },
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (data && data.globalError) { lastErr = data.globalError.message || data.globalError.code || 'globalError'; continue; }
        const list = extractSubtitleList(data);
        if (list.length) return list;
        lastErr = 'no subtitles in PRS response';
      } catch (e) { lastErr = e.message || String(e); }
    }
    throw new Error(lastErr);
  }

  async function autoScanSeason() {
    setStatus('Scanning page for episodes…');
    const eps = await scrapeSeasonEpisodesWithApi();
    if (!eps.length) {
      setStatus('No episodes found on this page. Open the show or season page, then try again.');
      return;
    }
    setStatus(`Scanning ${eps.length} episodes…`);
    showProgress(eps.length);
    const CONC = 3;
    let idx = 0, done = 0, ok = 0;
    const errs = [];
    const workers = Array(Math.min(CONC, eps.length)).fill(0).map(async () => {
      while (idx < eps.length) {
        const ep = eps[idx++];
        try {
          const envelope = await fetchEpisodeEnvelope(ep.url);
          if (!envelope) throw new Error('no playback envelope on episode page');
          const list = await fetchSubsForEnvelope(envelope);
          const tracks = normalizeTracks(list);
          const metaLike = { show: ep.show || '', sub: '', season: ep.season || 1, episode: ep.episode, epTitle: ep.title, titleId: ep.titleId || '' };
          const key = episodeKey(metaLike);
          storeSeasonEpisode(key, {
            show: ep.show || '',
            label: episodeLabel(metaLike),
            season: metaLike.season,
            episode: metaLike.episode,
            titleId: ep.titleId || '',
            tracks,
          });
          ok++;
        } catch (e) {
          errs.push(`S${ep.season || '?'}E${ep.episode} ${ep.title || ep.titleId}: ${e.message}`);
        }
        done++;
        updateProgress(done, eps.length, 0);
      }
    });
    await Promise.all(workers);
    hideProgress();
    if (ok) {
      setStatus(`Scanned ${ok}/${eps.length} episodes. Click Download Season ZIP.`);
    } else {
      setStatus(`Scan found ${eps.length} episodes but 0 had reachable subtitles. First error: ${errs[0] || 'unknown'}`);
    }
    LOG('scan complete', { requested: eps.length, ok, errors: errs });
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
            <label style="display:flex;align-items:center;gap:6px;color:#cfe6ff;cursor:pointer;font-size:11px;">
              <input id="apvsd-season" type="checkbox" /> Start season capture — auto-add every episode you open (buffer keeps until you download or clear)
            </label>
          </div>
          <div class="row" id="apvsd-season-row" style="display:none;flex-wrap:wrap;gap:6px;">
            <span id="apvsd-season-count" style="color:#7cd4ff;font-size:11px;flex:1;">0 episodes</span>
            <button id="apvsd-season-scan" title="Auto-scan every episode from the show/season page">Scan season</button>
            <button id="apvsd-season-clear" title="Clear buffered episodes">Clear season</button>
            <button id="apvsd-season-dl" class="primary" disabled>Download Season ZIP</button>
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

    const season = document.getElementById('apvsd-season');
    season.checked = seasonMode;
    season.onchange = () => {
      seasonMode = season.checked;
      localStorage.setItem('apvsd_season', seasonMode ? '1' : '0');
      updateSeasonUI();
      if (seasonMode && cachedTracks.length) captureCurrentEpisode();
    };
    document.getElementById('apvsd-season-clear').onclick = () => {
      seasonEpisodes.clear();
      lastCapturedKey = null;
      localStorage.removeItem(SEASON_STORE_KEY);
      updateSeasonUI();
      setStatus('Season buffer cleared.');
    };
    document.getElementById('apvsd-season-scan').onclick = () => autoScanSeason();
    document.getElementById('apvsd-season-dl').onclick = () => downloadSeasonZip();
    updateSeasonUI();
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
      if (seasonMode) scheduleSeasonCapture();
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
        if (typeof onDone === 'function') { try { onDone(done); } catch (e) {} }
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
    restoreSeasonBuffer();
    mountUI();
    lastPlayerSignature = playerSignature();
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
  const onPlaybackNavigation = (reason) => {
    const message = seasonMode
      ? `Episode change detected — Season mode on (${seasonEpisodes.size} buffered). Waiting for next episode subtitles…`
      : 'Episode change detected — press Play, then Refresh.';
    clearCurrentPlaybackState(message);
    lastPlayerSignature = playerSignature();
    LOG('playback navigation detected', reason);
  };

  const installHistoryWatcher = () => {
    try {
      const emit = () => window.dispatchEvent(new CustomEvent('apvsd_location_change'));
      const wrap = (name) => {
        const orig = history[name];
        history[name] = function () {
          const ret = orig.apply(this, arguments);
          try { emit(); } catch (_) {}
          return ret;
        };
      };
      wrap('pushState');
      wrap('replaceState');
      window.addEventListener('popstate', emit);
    } catch (_) {}
  };
  installHistoryWatcher();
  window.addEventListener('apvsd_location_change', () => {
    setTimeout(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        onPlaybackNavigation('history');
      }
    }, 50);
  });

  setInterval(() => {
    // Only treat a real URL change as navigation — do NOT clear tracks on
    // player DOM title updates, which fire on movie pages after PRS arrives
    // and would wipe the just-captured subtitles before the user can grab them.
    if (location.href !== lastHref) {
      lastHref = location.href;
      onPlaybackNavigation('poll-url');
      return;
    }
    // Prime updates the visible title/subtitle text before the new PRS subtitle
    // manifest arrives. Treat that as display-only; capturing here would store
    // stale subtitle URLs under the next episode's title. Season capture is
    // driven by real PRS responses (or explicit Refresh) instead.
    const sig = playerSignature();
    if (sig && sig !== lastPlayerSignature) {
      lastPlayerSignature = sig;
    }
  }, 1500);
})();
