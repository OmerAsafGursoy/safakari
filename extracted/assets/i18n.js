/* ───────────────────────────────────────────────
 * Şafakarı İnşaat — i18n motoru (vanilla JS)
 * 5 dil: TR (default) + EN + RU + AR + DE
 * - URL ?lang=xx + localStorage hatirlatma
 * - data-i18n="key" / data-i18n-attr="attr:key,attr:key" pattern
 * - Meta tag (title, og, twitter), <html lang>, <html dir> guncellemesi
 * - Switcher UI (sag ust kose)
 * - Public API: window.I18N
 *   .t(key, fallback?)            : metin cevirisi (dot-path)
 *   .tProject(id, field)          : projects.p<id>.<field>
 *   .setLang(code)                : dil degistir, fetch + apply + persist
 *   .current                      : aktif dil kodu
 *   .applyDOM()                   : DOM'da data-i18n'leri tekrar uygula
 *   .onChange(cb)                 : dil degisiminde callback
 *   .ready                        : Promise (ilk locale hazir)
 *   .formatCurrency(num)          : aktif locale ile para format
 * ─────────────────────────────────────────────── */
(function(global){
  'use strict';

  const SUPPORTED = ['tr', 'en', 'ru', 'ar', 'de'];
  const DEFAULT_LANG = 'tr';
  const STORAGE_KEY = 'safakari_lang';
  const LOCALE_PATH = 'locales/';

  const cache = {};        // dictionary cache by lang code
  const listeners = [];    // onChange callbacks

  let currentLang = DEFAULT_LANG;
  let currentDict = null;
  let readyResolve;
  const readyPromise = new Promise(r => { readyResolve = r; });

  // ── Lang detection ──
  function detectLang(){
    // 1. URL ?lang=xx
    try {
      const url = new URL(window.location.href);
      const q = url.searchParams.get('lang');
      if (q && SUPPORTED.includes(q.toLowerCase())) return q.toLowerCase();
    } catch(_){}
    // 2. localStorage
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && SUPPORTED.includes(stored)) return stored;
    } catch(_){}
    // 3. navigator.language (TR/EN/RU/AR/DE icinden ilki)
    try {
      const navLangs = (navigator.languages && navigator.languages.length)
        ? navigator.languages
        : [navigator.language || ''];
      for (const l of navLangs){
        const code = (l || '').slice(0, 2).toLowerCase();
        if (SUPPORTED.includes(code)) return code;
      }
    } catch(_){}
    return DEFAULT_LANG;
  }

  // ── Persist ──
  function persist(lang){
    try { localStorage.setItem(STORAGE_KEY, lang); } catch(_){}
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('lang', lang);
      // Tarayici gecmisini bozmadan replace
      window.history.replaceState({}, '', url.toString());
    } catch(_){}
  }

  // ── Fetch dictionary ──
  async function loadDict(lang){
    if (cache[lang]) return cache[lang];
    try {
      const res = await fetch(LOCALE_PATH + lang + '.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const dict = await res.json();
      cache[lang] = dict;
      return dict;
    } catch(err){
      console.error('[i18n] Failed to load locale', lang, err);
      // Fallback: default lang (TR)
      if (lang !== DEFAULT_LANG){
        return loadDict(DEFAULT_LANG);
      }
      throw err;
    }
  }

  // ── t(key, fallback?) — dot-path resolver ──
  function t(key, fallback){
    if (!key) return fallback != null ? fallback : '';
    const path = key.split('.');
    let cur = currentDict;
    for (const seg of path){
      if (cur == null || typeof cur !== 'object'){ cur = null; break; }
      cur = cur[seg];
    }
    if (cur != null) return cur;
    // Fallback: TR dict
    if (currentLang !== DEFAULT_LANG && cache[DEFAULT_LANG]){
      let trCur = cache[DEFAULT_LANG];
      for (const seg of path){
        if (trCur == null || typeof trCur !== 'object'){ trCur = null; break; }
        trCur = trCur[seg];
      }
      if (trCur != null) return trCur;
    }
    return fallback != null ? fallback : key;
  }

  // ── tProject(id, field) — D.projects key bridging ──
  // id: 1..12 -> "projects.p1.<field>"; field: name|location|timeline|desc|tags|feats|types
  function tProject(id, field){
    const v = t('projects.p' + id + '.' + field, null);
    return v;
  }

  // ── Apply DOM: data-i18n + data-i18n-attr ──
  function applyDOM(root){
    const scope = root || document;
    // 1. text content: data-i18n="key"
    scope.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      const val = t(key, el.textContent);
      // data-i18n-html flag varsa innerHTML, yoksa textContent
      if (el.hasAttribute('data-i18n-html')){
        el.innerHTML = val;
      } else {
        el.textContent = val;
      }
    });
    // 2. attribute set: data-i18n-attr="placeholder:key,aria-label:key2"
    scope.querySelectorAll('[data-i18n-attr]').forEach(el => {
      const spec = el.getAttribute('data-i18n-attr');
      if (!spec) return;
      spec.split(',').forEach(pair => {
        const [attrName, key] = pair.split(':').map(s => s.trim());
        if (!attrName || !key) return;
        const val = t(key, null);
        if (val != null) el.setAttribute(attrName, val);
      });
    });
  }

  // ── Meta tags + html attributes ──
  function applyMeta(){
    if (!currentDict) return;
    const meta = currentDict._meta || {};
    const m = currentDict.meta || {};
    // <html lang> + <html dir>
    document.documentElement.setAttribute('lang', meta.code || currentLang);
    document.documentElement.setAttribute('dir', meta.dir || 'ltr');
    // <title>
    if (m.title) document.title = m.title;
    // <meta name="description">
    setMeta('name', 'description', m.description);
    // OG
    setMeta('property', 'og:title', m.og_title);
    setMeta('property', 'og:description', m.og_description);
    setMeta('property', 'og:locale', meta.ogLocale);
    // Twitter
    setMeta('name', 'twitter:title', m.twitter_title);
    setMeta('name', 'twitter:description', m.twitter_description);
  }

  function setMeta(attr, val, content){
    if (content == null) return;
    let el = document.head.querySelector('meta[' + attr + '="' + val + '"]');
    if (!el){
      el = document.createElement('meta');
      el.setAttribute(attr, val);
      document.head.appendChild(el);
    }
    el.setAttribute('content', content);
  }

  // ── Switcher UI ──
  // Strateji: Mevcutsa topbar.topbar-r icine prepend et (en saga oturur, butonlardan once
  // gorunsun ki kullanici dili once secsin). Topbar yoksa body'ye fixed sag-ust olarak ekle.
  function buildSwitcher(){
    let host = document.getElementById('langSwitcher');
    if (host) host.remove(); // Yeniden olustur (lang degisikliginde update icin daha basit)
    host = document.createElement('div');
    host.id = 'langSwitcher';
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', 'Language');
    const labels = { tr:'TR', en:'EN', ru:'RU', ar:'AR', de:'DE' };
    host.innerHTML = SUPPORTED.map(code => {
      const active = code === currentLang ? ' active' : '';
      return `<button type="button" class="lang-btn${active}" data-lang="${code}" aria-pressed="${code === currentLang}" aria-label="${labels[code]}">${labels[code]}</button>`;
    }).join('');
    host.querySelectorAll('.lang-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.getAttribute('data-lang');
        if (code && code !== currentLang) setLang(code);
      });
    });
    // Topbar'a yerlestir (sag butonlardan once)
    const topbarR = document.querySelector('.topbar-r');
    if (topbarR){
      host.classList.add('inline');
      topbarR.insertBefore(host, topbarR.firstChild);
    } else {
      host.classList.add('floating');
      document.body.appendChild(host);
    }
  }

  function updateSwitcherActive(){
    const host = document.getElementById('langSwitcher');
    if (!host) return;
    host.querySelectorAll('.lang-btn').forEach(btn => {
      const code = btn.getAttribute('data-lang');
      const on = code === currentLang;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // ── Switcher CSS (inline injection) ──
  function injectStyles(){
    if (document.getElementById('i18n-styles')) return;
    const css = `
      #langSwitcher {
        display: inline-flex;
        gap: 2px;
        padding: 3px;
        background: rgba(247, 245, 242, .85);
        border: 1px solid rgba(232,228,223,.7);
        border-radius: 999px;
        align-items: center;
        flex-shrink: 0;
      }
      #langSwitcher.floating {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 9001;
        background: rgba(255,255,255,.92);
        backdrop-filter: blur(10px);
        box-shadow: 0 4px 14px rgba(0,0,0,.08);
        padding: 4px;
      }
      #langSwitcher.inline {
        margin-right: 4px;
      }
      #langSwitcher .lang-btn {
        appearance: none;
        border: none;
        background: transparent;
        font-family: inherit;
        font-size: .66rem;
        font-weight: 700;
        letter-spacing: .3px;
        color: #8e8e9e;
        padding: 5px 8px;
        border-radius: 999px;
        cursor: pointer;
        transition: all .25s ease;
        line-height: 1;
        min-width: 28px;
      }
      #langSwitcher .lang-btn:hover {
        color: #1e3a5f;
        background: #eaf1f8;
      }
      #langSwitcher .lang-btn.active {
        background: linear-gradient(135deg, #1e3a5f, #2a5078);
        color: #fff;
        box-shadow: 0 2px 6px rgba(30,58,95,.25);
      }
      /* Mobile */
      @media(max-width: 700px) {
        #langSwitcher.floating {
          top: 6px;
          right: 6px;
          padding: 3px;
        }
        #langSwitcher .lang-btn {
          padding: 4px 6px;
          font-size: .6rem;
          min-width: 24px;
        }
      }
      /* AR: Arabic-friendly font stack (layout LTR korunur — Omer kararı 2026-05-07) */
      html[lang="ar"] body {
        font-family: 'Tajawal', 'Cairo', 'Segoe UI', system-ui, sans-serif;
      }
      /* Switcher ile ust nav'i ezmemek icin topbar saginda mini boslukla itelenmis sekilde nav'i biraz alt cek */
      @media(min-width: 701px) {
        #langSwitcher { top: 10px; }
      }
    `;
    const s = document.createElement('style');
    s.id = 'i18n-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── setLang(code) ──
  async function setLang(code){
    if (!SUPPORTED.includes(code)) code = DEFAULT_LANG;
    try {
      const dict = await loadDict(code);
      currentLang = code;
      currentDict = dict;
      persist(code);
      applyMeta();
      applyDOM();
      updateSwitcherActive();
      // Notify subscribers (sayfa re-render icin)
      listeners.forEach(cb => { try { cb(code, dict); } catch(_){} });
    } catch(err){
      console.error('[i18n] setLang failed', err);
    }
  }

  function onChange(cb){
    if (typeof cb === 'function') listeners.push(cb);
  }

  // ── formatCurrency: aktif dilin currency_locale + currency_code ile ──
  function formatCurrency(num){
    const loc = (currentDict && currentDict.loan && currentDict.loan.currency_locale) || 'tr-TR';
    const code = (currentDict && currentDict.loan && currentDict.loan.currency_code) || 'TRY';
    try {
      return new Intl.NumberFormat(loc, { style:'currency', currency:code, maximumFractionDigits:0 }).format(num);
    } catch(_){
      return num + ' ' + code;
    }
  }

  // ── BOOT ──
  async function boot(){
    injectStyles();
    const lang = detectLang();
    try {
      // Default lang'i de prefetch et — fallback icin
      if (lang !== DEFAULT_LANG){
        loadDict(DEFAULT_LANG).catch(()=>{});
      }
      const dict = await loadDict(lang);
      currentLang = lang;
      currentDict = dict;
      persist(lang);
      applyMeta();
      // DOM henuz hazir olmayabilir
      const apply = () => {
        applyDOM();
        buildSwitcher();
        updateSwitcherActive();
        readyResolve(global.I18N);
      };
      if (document.readyState === 'loading'){
        document.addEventListener('DOMContentLoaded', apply, { once: true });
      } else {
        apply();
      }
    } catch(err){
      console.error('[i18n] boot failed', err);
      readyResolve(null);
    }
  }

  // ── Public API ──
  global.I18N = {
    SUPPORTED,
    DEFAULT_LANG,
    get current(){ return currentLang; },
    get dict(){ return currentDict; },
    t,
    tProject,
    setLang,
    applyDOM,
    onChange,
    ready: readyPromise,
    formatCurrency
  };

  boot();
})(window);
