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

  // ── Switcher UI (Mac iter-6 / 2026-05-08) ──
  // Tek aktif buton ("TR ▾") tikla -> dropdown menu acilsin -> 5 dil oradan secilsin.
  // ARIA: button[aria-haspopup="listbox"][aria-expanded] + ul[role="listbox"] + li[role="option"]
  // Klavye: Enter/Space/ArrowDown ac, Escape kapat, ArrowUp/Down/Home/End gez, Enter sec.
  // Stil: index.html icindeki .lang-switcher / .lang-switcher-btn / .lang-switcher-menu kurallari.
  const LANG_LABELS = { tr:'TR', en:'EN', ru:'RU', ar:'AR', de:'DE' };
  const LANG_NAMES = {
    tr: 'Türkçe', en: 'English', ru: 'Русский', ar: 'العربية', de: 'Deutsch'
  };

  function buildSwitcher(){
    // Eski host(lar)i temizle (eski .lang-btn pill'leri dahil)
    document.querySelectorAll('#langSwitcher, .lang-switcher').forEach(el => el.remove());

    // 1. Topbar saginda primary instance
    const topbarR = document.querySelector('.topbar-r');
    if (topbarR){
      const sw = createSwitcherEl('primary');
      // tbWa ve tbPhone'dan once (en sola, dil ilk goze carpsin)
      topbarR.insertBefore(sw, topbarR.firstChild);
    }

    // 2. Drawer footer (mobile) — drawer'in nav blogundan sonra, foot'tan once.
    const drawer = document.getElementById('topbarDrawer');
    if (drawer){
      const drawerFoot = drawer.querySelector('.topbar-drawer-foot');
      const sw2 = createSwitcherEl('drawer');
      if (drawerFoot){
        drawer.insertBefore(sw2, drawerFoot);
      } else {
        drawer.appendChild(sw2);
      }
    }

    // 3. Hicbiri yoksa fallback floating (sayfa olabilir ki sade demo)
    if (!topbarR && !drawer){
      const sw = createSwitcherEl('floating');
      sw.classList.add('floating');
      document.body.appendChild(sw);
    }
  }

  function createSwitcherEl(variant){
    const host = document.createElement('div');
    host.className = 'lang-switcher';
    host.setAttribute('data-variant', variant);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lang-switcher-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', t('lang.switcher_label', 'Dil'));
    btn.innerHTML = `<span class="lang-active-code">${LANG_LABELS[currentLang]}</span><svg class="lang-chev" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

    const menu = document.createElement('ul');
    menu.className = 'lang-switcher-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', t('lang.switcher_label', 'Dil'));
    menu.hidden = true;
    menu.innerHTML = SUPPORTED.map((code, i) => {
      const sel = code === currentLang;
      return `<li role="presentation"><button type="button" role="option" class="lang-switcher-opt" data-lang="${code}" aria-selected="${sel}" tabindex="-1"><span class="lang-opt-name">${LANG_LABELS[code]} <span style="opacity:.6;font-weight:600">· ${LANG_NAMES[code]}</span></span><span class="lang-check" aria-hidden="true">✓</span></button></li>`;
    }).join('');

    host.appendChild(btn);
    host.appendChild(menu);

    // ── Event wiring ──
    function openMenu(){
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      // Aktif option'a focus
      const active = menu.querySelector('.lang-switcher-opt[aria-selected="true"]') || menu.querySelector('.lang-switcher-opt');
      if (active){ active.tabIndex = 0; setTimeout(() => active.focus(), 0); }
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onDocKey, true);
    }
    function closeMenu(returnFocus){
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      menu.querySelectorAll('.lang-switcher-opt').forEach(o => o.tabIndex = -1);
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onDocKey, true);
      if (returnFocus) btn.focus();
    }
    function toggleMenu(){
      if (menu.hidden) openMenu(); else closeMenu(false);
    }
    function onDocClick(e){
      if (!host.contains(e.target)) closeMenu(false);
    }
    function onDocKey(e){
      if (e.key === 'Escape'){ e.preventDefault(); closeMenu(true); return; }
      if (e.key === 'Tab'){ closeMenu(false); return; }
      const opts = Array.from(menu.querySelectorAll('.lang-switcher-opt'));
      const cur = opts.indexOf(document.activeElement);
      if (e.key === 'ArrowDown'){ e.preventDefault(); const n = opts[(cur + 1 + opts.length) % opts.length]; if (n){ opts.forEach(o=>o.tabIndex=-1); n.tabIndex=0; n.focus(); } }
      else if (e.key === 'ArrowUp'){ e.preventDefault(); const n = opts[(cur - 1 + opts.length) % opts.length]; if (n){ opts.forEach(o=>o.tabIndex=-1); n.tabIndex=0; n.focus(); } }
      else if (e.key === 'Home'){ e.preventDefault(); const n = opts[0]; if (n){ opts.forEach(o=>o.tabIndex=-1); n.tabIndex=0; n.focus(); } }
      else if (e.key === 'End'){ e.preventDefault(); const n = opts[opts.length-1]; if (n){ opts.forEach(o=>o.tabIndex=-1); n.tabIndex=0; n.focus(); } }
    }

    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' '){
        e.preventDefault();
        if (menu.hidden) openMenu();
      }
    });

    menu.querySelectorAll('.lang-switcher-opt').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const code = opt.getAttribute('data-lang');
        closeMenu(true);
        if (code && code !== currentLang) setLang(code);
      });
      opt.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' '){
          e.preventDefault();
          opt.click();
        }
      });
    });

    return host;
  }

  function updateSwitcherActive(){
    document.querySelectorAll('.lang-switcher').forEach(host => {
      const codeEl = host.querySelector('.lang-active-code');
      if (codeEl) codeEl.textContent = LANG_LABELS[currentLang] || currentLang.toUpperCase();
      const btn = host.querySelector('.lang-switcher-btn');
      if (btn) btn.setAttribute('aria-label', t('lang.switcher_label', 'Dil'));
      const menu = host.querySelector('.lang-switcher-menu');
      if (menu) menu.setAttribute('aria-label', t('lang.switcher_label', 'Dil'));
      host.querySelectorAll('.lang-switcher-opt').forEach(opt => {
        const c = opt.getAttribute('data-lang');
        opt.setAttribute('aria-selected', c === currentLang ? 'true' : 'false');
      });
    });
  }

  // ── Switcher CSS (Sadece global font + AR override — diger stiller index.html'de) ──
  function injectStyles(){
    if (document.getElementById('i18n-styles')) return;
    const css = `
      /* AR: Arabic-friendly font stack (layout LTR korunur — Omer kararı 2026-05-07) */
      html[lang="ar"] body {
        font-family: 'Tajawal', 'Cairo', 'Segoe UI', system-ui, sans-serif;
      }
      /* AR: dropdown menu kendi LTR kalsin (kart kontaineri ile tutarli) */
      html[lang="ar"] .lang-switcher-menu { direction: ltr; text-align: left; }
      /* Floating fallback (topbar yoksa) */
      .lang-switcher.floating {
        position: fixed; top: 12px; right: 12px; z-index: 9001;
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
