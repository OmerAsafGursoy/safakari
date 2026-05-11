/**
 * safakari-rates Worker
 *
 * Cron (haftalik Pazartesi 09:00 TRT) -> TCMB EVDS baseline + bank scrape -> KV.
 * GET /api/bank-rates -> JSON {updated, source, baseline_tcmb, banks, status, age_days}.
 * POST /api/bank-rates/refresh (X-Admin-Secret) -> manuel tetik.
 *
 * Scrape kaynak: enuygunfinans (primary), hangikredi (fallback).
 * Scrape fail -> son KV degerini koru, status='scrape_failed' set.
 * Frontend her zaman manuel override yapabilir (bu Worker hicbir zaman manuel veriyi ezmez,
 * frontend localStorage onceligi vardir).
 */

const KV_KEY = 'rates:current';
const SCRAPE_TIMEOUT_MS = 12000;

const BANKS = [
  { id: 'ziraat',    name: 'Ziraat Bankası',     type: 'kamu' },
  { id: 'halkbank',  name: 'Halkbank',           type: 'kamu' },
  { id: 'vakif',     name: 'VakıfBank',          type: 'kamu' },
  { id: 'isbank',    name: 'Türkiye İş Bankası', type: 'ozel' },
  { id: 'garanti',   name: 'Garanti BBVA',       type: 'ozel' },
  { id: 'akbank',    name: 'Akbank',             type: 'ozel' },
  { id: 'yapikredi', name: 'Yapı Kredi',         type: 'ozel' },
  { id: 'qnb',       name: 'QNB Finansbank',     type: 'ozel' },
  { id: 'albaraka',  name: 'Albaraka Türk',      type: 'katilim' },
  { id: 'kuveyt',    name: 'Kuveyt Türk',        type: 'katilim' }
];

const BANK_MATCH = {
  ziraat:    /ziraat/i,
  halkbank:  /halk\s*bank/i,
  vakif:     /vak[ıi]f/i,
  isbank:    /(t[üu]rkiye\s+)?[İi][şs]\s*bank/i,
  garanti:   /garanti/i,
  akbank:    /akbank/i,
  yapikredi: /yap[ıi]\s*kredi/i,
  qnb:       /qnb/i,
  albaraka:  /albaraka/i,
  kuveyt:    /kuveyt/i
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/api/bank-rates' && request.method === 'GET') {
      const data = await env.RATES.get(KV_KEY, { type: 'json' });
      const body = data ? withAge(data) : { status: 'empty', banks: [], updated: null, age_days: null };
      return json(body, 200, cors, 3600);
    }

    if (url.pathname === '/api/bank-rates/refresh' && request.method === 'POST') {
      const auth = request.headers.get('X-Admin-Secret');
      if (!env.ADMIN_SECRET || auth !== env.ADMIN_SECRET) {
        return json({ error: 'unauthorized' }, 401, cors);
      }
      const result = await refreshRates(env);
      return json(result, 200, cors);
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'safakari-rates', version: 1 }, 200, cors);
    }

    return json({ error: 'not_found' }, 404, cors);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshRates(env).then(r => {
      console.log('[cron] refresh done:', JSON.stringify(r));
    }));
  }
};

function corsHeaders(origin, env) {
  const list = (env.ALLOWED_ORIGINS || 'https://safakari.com,https://safakari.com.tr')
    .split(',').map(s => s.trim()).filter(Boolean);
  const dev = ['http://127.0.0.1:5500', 'http://localhost:5500', 'http://127.0.0.1:8787', 'http://localhost:8787'];
  const allowed = [...list, ...dev];
  const allow = allowed.includes(origin) ? origin : list[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(body, status, extraHeaders, maxAge) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders
  };
  if (maxAge) headers['Cache-Control'] = `public, max-age=${maxAge}`;
  return new Response(JSON.stringify(body), { status, headers });
}

function withAge(data) {
  if (!data || !data.updated) return { ...data, age_days: null };
  const ms = Date.now() - new Date(data.updated).getTime();
  const age_days = Math.floor(ms / (24 * 60 * 60 * 1000));
  return { ...data, age_days };
}

async function refreshRates(env) {
  const previous = await env.RATES.get(KV_KEY, { type: 'json' });
  const now = new Date().toISOString();
  const result = {
    updated: now,
    source: [],
    baseline_tcmb: previous?.baseline_tcmb ?? null,
    banks: [],
    status: 'ok',
    last_attempt: now,
    last_error: null
  };

  // 1) TCMB EVDS baseline (sektor ortalama, haftalik) - bagimsiz, fail olsa bile devam
  try {
    const baseline = await fetchTcmbBaseline(env);
    if (baseline != null) {
      result.baseline_tcmb = baseline;
      result.source.push('tcmb');
    }
  } catch (e) {
    console.warn('TCMB fetch failed:', e.message);
    result.last_error = `tcmb: ${e.message}`;
  }

  // 2) Banka-bazinda scrape (primary -> fallback)
  let scraped = null;
  let scrapeSource = null;
  try {
    scraped = await scrapeFromEnuygunfinans();
    if (scraped && scraped.length >= 5) scrapeSource = 'enuygunfinans';
    else scraped = null;
  } catch (e) {
    console.warn('enuygunfinans scrape failed:', e.message);
    result.last_error = (result.last_error ? result.last_error + '; ' : '') + `enuygun: ${e.message}`;
  }

  if (!scraped) {
    try {
      scraped = await scrapeFromHangikredi();
      if (scraped && scraped.length >= 5) scrapeSource = 'hangikredi';
      else scraped = null;
    } catch (e) {
      console.warn('hangikredi scrape failed:', e.message);
      result.last_error = (result.last_error ? result.last_error + '; ' : '') + `hangikredi: ${e.message}`;
    }
  }

  if (scraped && scrapeSource) {
    result.source.push(scrapeSource);
    const prevBanks = previous?.banks ?? [];
    result.banks = BANKS.map(b => {
      const found = scraped.find(s => BANK_MATCH[b.id].test(s.name));
      const prevRate = prevBanks.find(p => p.id === b.id)?.rate ?? null;
      return { ...b, rate: found ? found.rate : prevRate };
    });
  } else {
    // Scrape fail - eski oranlari koru, status'u stale isaretle, updated'i guncelleme
    result.status = 'scrape_failed';
    result.banks = previous?.banks ?? BANKS.map(b => ({ ...b, rate: null }));
    if (previous?.updated) result.updated = previous.updated;
  }

  await env.RATES.put(KV_KEY, JSON.stringify(result));
  return {
    status: result.status,
    sources: result.source,
    banks_with_rate: result.banks.filter(b => b.rate != null).length,
    baseline_tcmb_monthly: result.baseline_tcmb?.monthly ?? null,
    error: result.last_error
  };
}

async function fetchTcmbBaseline(env) {
  if (!env.EVDS_API_KEY) return null;
  // TP.KTF101: Konut Kredisi Akdi Faiz Orani (TL, haftalik)
  const today = new Date();
  const start = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000);
  const fmt = d => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  const url = `https://evds2.tcmb.gov.tr/service/evds/series=TP.KTF101&startDate=${fmt(start)}&endDate=${fmt(today)}&type=json&aggregationTypes=last&frequency=2`;

  const resp = await fetchWithTimeout(url, {
    headers: { 'key': env.EVDS_API_KEY, 'Accept': 'application/json' }
  });
  if (!resp.ok) throw new Error(`tcmb http ${resp.status}`);
  const data = await resp.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const raw = items[i]?.TP_KTF101;
    if (raw == null || raw === '') continue;
    const annual = parseFloat(String(raw).replace(',', '.'));
    if (Number.isNaN(annual) || annual <= 0) continue;
    return {
      annual: +annual.toFixed(2),
      monthly: +(annual / 12).toFixed(2),
      date: items[i].Tarih ?? null
    };
  }
  return null;
}

async function scrapeFromEnuygunfinans() {
  return scrapeGeneric('https://www.enuygunfinans.com/konut-kredisi');
}

async function scrapeFromHangikredi() {
  return scrapeGeneric('https://www.hangikredi.com/konut-kredisi');
}

async function scrapeGeneric(url) {
  const resp = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SafakariRatesBot/1.0; +https://safakari.com)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'tr-TR,tr;q=0.9'
    }
  });
  if (!resp.ok) throw new Error(`http ${resp.status}`);
  const html = await resp.text();
  return parseRatesFromHtml(html);
}

function parseRatesFromHtml(html) {
  const results = [];
  // Bank-name benzeri token'i, ardindan 200 char icinde "% N,NN" veya "%N.NN" arar
  const rx = /([A-Za-zÇĞİÖŞÜçğıöşü.&\s]{4,40}?(?:Bank(?:ası|a)?|Türk|BBVA|Finansbank|Yapı\s*Kredi|Halkbank|VakıfBank))[^%<\n]{0,250}%\s*([0-9]+(?:[.,][0-9]{1,3})?)/g;
  let m;
  let safety = 0;
  while ((m = rx.exec(html)) !== null && safety++ < 500) {
    const name = m[1].trim().replace(/\s+/g, ' ');
    const rate = parseFloat(m[2].replace(',', '.'));
    if (rate > 0.5 && rate < 15) {
      results.push({ name, rate });
    }
  }
  // Banka basina ilk match'i tut
  const seen = new Set();
  const dedup = [];
  for (const r of results) {
    for (const id of Object.keys(BANK_MATCH)) {
      if (BANK_MATCH[id].test(r.name) && !seen.has(id)) {
        seen.add(id);
        dedup.push(r);
        break;
      }
    }
  }
  return dedup;
}

async function fetchWithTimeout(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SCRAPE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
