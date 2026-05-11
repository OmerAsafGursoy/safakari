# safakari-rates Worker

Cloudflare Worker — haftalik konut kredisi faiz oranlarini otomatik toplar, KV'de saklar, site icin JSON endpoint sunar.

## Mimari

```
Pazartesi 09:00 TRT (Cron)
       ↓
   Worker.scheduled
       ↓
   ┌── TCMB EVDS API → baseline (sektor ortalamasi)
   │
   └── enuygunfinans (primary)
          ↓ fail
       hangikredi (fallback)
          ↓ fail
       previous KV degeri korunur (status='scrape_failed')
       ↓
   KV.put('rates:current', {...})

Site (extracted/index.html):
   GET /api/bank-rates → JSON {updated, banks, baseline_tcmb, age_days, status}
   - age_days < 14 → fresh, kullan
   - age_days >= 14 → admin'e sari uyari banner
   - manuel override (admin panel) hep aktif, KV'yi ezmez
```

## Endpoint'ler

| Method | Path | Auth | Aciklama |
|--------|------|------|----------|
| GET | `/api/bank-rates` | yok | Son KV degeri (CDN cache 1h) |
| POST | `/api/bank-rates/refresh` | `X-Admin-Secret` header | Manuel scrape tetik |
| GET | `/health` | yok | Servis canli mi |

## KV Schema (`rates:current`)

```json
{
  "updated": "2026-05-13T06:00:12.345Z",
  "source": ["tcmb", "enuygunfinans"],
  "baseline_tcmb": { "annual": 35.4, "monthly": 2.95, "date": "13-05-2026" },
  "banks": [
    { "id": "ziraat", "name": "Ziraat Bankası", "type": "kamu", "rate": 3.19 },
    ...
  ],
  "status": "ok",
  "last_attempt": "2026-05-13T06:00:12.345Z",
  "last_error": null,
  "age_days": 0
}
```

`status`: `ok` | `scrape_failed` | `empty`

## Deploy (ozet)

Detayli adim adim rehber: `reports/safakari/worker-deploy-rehberi.md`

```bash
# 1. Wrangler kurulu mu
npm install -g wrangler

# 2. Cloudflare login
wrangler login

# 3. KV namespace olustur
wrangler kv:namespace create RATES
# -> "id = abc123..." -> wrangler.toml'da PLACEHOLDER_KV_ID yerine yaz

# 4. Secret'lar
wrangler secret put EVDS_API_KEY        # TCMB EVDS anahtari
wrangler secret put ADMIN_SECRET        # Manuel refresh icin paylasilan sir
wrangler secret put ALLOWED_ORIGINS     # ornek: https://safakari.com,https://safakari.com.tr

# 5. Deploy
wrangler deploy

# 6. Cron'u bir kez elle test et
wrangler dev --test-scheduled
# Browser: http://localhost:8787/__scheduled?cron=0+6+*+*+1
```

## TCMB EVDS API Anahtari

1. https://evds2.tcmb.gov.tr/ → Profil → API Anahtari
2. Ucretsiz, e-posta dogrulamasi var
3. Seri kodu: **TP.KTF101** (Konut Kredisi Akdi Faiz Orani — TL, haftalik, % yillik)
4. Worker bunu aylik %'ye cevirir (`/12`)

## Yerel Gelistirme

```bash
cd projects/safakari/worker
npm install
cp wrangler.toml.example .dev.vars  # veya manuel olustur
# .dev.vars icine:
#   EVDS_API_KEY="..."
#   ADMIN_SECRET="dev-secret"
#   ALLOWED_ORIGINS="http://localhost:5500"

npm run dev          # local server :8787
npm run test:cron    # cron'u tetikle
```

## Frontend Entegrasyonu

`extracted/index.html` icinde `loadBankRates()` fonksiyonu:

1. Sayfa load'da `fetch('/api/bank-rates')`
2. Response geldiyse:
   - localStorage'da MANUEL flag yoksa → KV degeriyle BANK_RATES'i guncelle
   - localStorage'a yaz (cache)
3. Fetch fail → mevcut localStorage / hardcoded fallback (BANK_RATES_DEFAULT)
4. Admin panelde:
   - "Son guncelleme: 2 gun once" badge
   - `age_days >= 14` veya `status='scrape_failed'` → sari uyari
   - "Otomatik Tazele" butonu → POST /api/bank-rates/refresh

(Detay PR #11'de eklenecek, PR #10 merge sonrasi.)

## Maliyet

Cloudflare Workers FREE plan:
- 100K istek/gun (site 100 ziyaretci/gun → 100 fetch, sorun yok)
- 1K KV write/gun (haftada 1 cron → ~5/ay, sorun yok)
- 100K KV read/gun
- Cron Triggers: ucretsiz

Yani bu Worker **ek maliyetsiz** calisir.
