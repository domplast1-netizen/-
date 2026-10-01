'use strict';

// Domplast Kaspi Railway: full, standalone server.js
// Version: catalog-separated-2026-09-30-v5 (SKU fix: verify offers limit 50)
// Express + axios + https-proxy-agent (optional proxy)
// Read-only diagnostic endpoints; does not alter Kaspi or Google Sheets.

const express = require('express');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const VERSION = 'catalog-batchverify-2026-10-01-v6';
const BUILD = 'fast-batch-sku-price-v1';
const VERIFY_OFFERS_LIMIT = 50;
const BATCH_VERIFY_MAX = 24;
const BATCH_VERIFY_DEFAULT_CONCURRENCY = 3;
const BATCH_VERIFY_MAX_CONCURRENCY = 5;
const BATCH_VERIFY_DELAY_MS = Math.max(0, Math.min(3000, Number(process.env.VERIFY_BATCH_DELAY_MS) || 450));
const PORT = Number(process.env.PORT || 8080);
const API_KEY = String(process.env.API_KEY || '').trim();
const UPSTREAM_PROXY_URL = String(process.env.UPSTREAM_PROXY_URL || '').trim();
const REQUEST_TIMEOUT_MS = Math.max(3000, Math.min(60000, Number(process.env.REQUEST_TIMEOUT_MS) || 25000));
const DEFAULT_CITY = '351010000';
const DEFAULT_MERCHANT = '30427112';

if (!API_KEY) {
  console.error('FATAL: configure Railway variable API_KEY before starting');
  process.exit(1);
}

function requireKey(req, res, next) {
  const supplied = req.get('X-API-Key') || '';
  if (!supplied || supplied !== API_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

function boundedInt(value, fallback, low, high) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) ? Math.max(low, Math.min(high, n)) : fallback;
}

function validId(value, min = 1, max = 20) {
  return new RegExp('^\\d{' + min + ',' + max + '}$').test(String(value));
}

function kaspiClientConfig(headers, extra = {}) {
  const config = {
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
    validateStatus: () => true,
    headers,
    ...extra
  };
  if (UPSTREAM_PROXY_URL) {
    const agent = new HttpsProxyAgent(UPSTREAM_PROXY_URL);
    config.httpAgent = agent;
    config.httpsAgent = agent;
    config.proxy = false;
  }
  return config;
}

function statusForUpstream(status) {
  return status === 429 ? 429 : 502;
}

function publicError(error) {
  return {
    code: error.code || null,
    message: String(error.message || error).slice(0, 240)
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchOffers(productId, cityId, limit = 50) {
  const url = `https://kaspi.kz/yml/offer-view/offers/${encodeURIComponent(productId)}`;
  const payload = {
    cityId: String(cityId), id: String(productId), merchantUID: '',
    limit, page: 0, sortOption: null, highRating: null,
    searchText: null, isExcellentMerchant: false, installationId: '-1'
  };
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    'Content-Type': 'application/json;charset=UTF-8',
    Origin: 'https://kaspi.kz',
    Referer: `https://kaspi.kz/shop/p/-${encodeURIComponent(productId)}/?c=${encodeURIComponent(cityId)}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
  };
  const started = Date.now();
  const response = await axios.post(url, payload, kaspiClientConfig(headers, { maxRedirects: 5 }));
  return { status: response.status, data: response.data, elapsedMs: Date.now() - started };
}

async function fetchCatalogPage(merchantId, cityId, page) {
  const params = {
    q: `:availableInZones:${cityId}:allMerchants:${merchantId}`,
    page, sort: 'relevance', ui: 'd', i: -1, c: cityId
  };
  const headers = {
    Accept: 'application/json',
    Referer: 'https://kaspi.kz/shop/search/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
  };
  const started = Date.now();
  const response = await axios.get(
    'https://kaspi.kz/yml/product-view/pl/results',
    kaspiClientConfig(headers, { params, maxContentLength: 2 * 1024 * 1024 })
  );
  return { status: response.status, data: response.data, elapsedMs: Date.now() - started };
}

function simplifyProduct(item) {
  return {
    productId: item?.id == null ? null : String(item.id),
    name: item?.title || null,
    shopLink: item?.shopLink || null,
    listingPrice: item?.unitSalePrice ?? item?.unitPrice ?? null,
    bestMerchant: item?.bestMerchant == null ? null : String(item.bestMerchant),
    // SKU is not supplied by storefront listing. Confirm through /offers.
    merchantSku: null
  };
}

function paginationHints(body) {
  const hints = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'data') continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      hints[key] = value;
    } else if (Array.isArray(value)) {
      hints[key] = { arrayLength: value.length };
    } else if (value && typeof value === 'object') {
      const shallow = {};
      for (const [k, v] of Object.entries(value)) {
        if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) shallow[k] = v;
      }
      hints[key] = shallow;
    }
  }
  return hints;
}

function checkMerchantCity(req, res) {
  const merchantId = String(req.query.merchantId || DEFAULT_MERCHANT).trim();
  const cityId = String(req.query.cityId || DEFAULT_CITY).trim();
  if (!validId(merchantId) || !validId(cityId, 6, 15)) {
    res.status(400).json({ ok: false, error: 'invalid_merchant_or_city' });
    return null;
  }
  return { merchantId, cityId };
}

// Unauthenticated version marker: helps distinguish stale deployments from a missing route.
app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    service: 'domplast-kaspi-railway-test',
    version: VERSION,
    build: BUILD,
    verifyOffersLimit: VERIFY_OFFERS_LIMIT,
    batchVerifyMax: BATCH_VERIFY_MAX,
    batchVerifyDefaultConcurrency: BATCH_VERIFY_DEFAULT_CONCURRENCY,
    batchVerifyDelayMs: BATCH_VERIFY_DELAY_MS,
    routes: ['/health', '/offers', '/catalog', '/catalog-test', '/catalog-page-probe', '/catalog-scan-page', '/catalog-verify-own', '/catalog-list-page', '/catalog-verify-batch'],
    proxyConfigured: Boolean(UPSTREAM_PROXY_URL),
    railway: {
      environment: process.env.RAILWAY_ENVIRONMENT_NAME || null,
      region: process.env.RAILWAY_REPLICA_REGION || null,
      commit: process.env.RAILWAY_GIT_COMMIT_SHA || null
    },
    time: new Date().toISOString()
  });
});

// Simple manual test screen, with key sent only in X-API-Key header.
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Domplast Railway</title>
<style>body{max-width:780px;margin:32px auto;padding:0 16px;font:16px Arial}
input,button{padding:9px;margin:5px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:14px}
</style></head><body><h2>Domplast Railway — ${VERSION}</h2>
<p>Тестовые запросы доступны по /catalog-test. Статус — /health.</p>
<label>Product ID: <input id="pid" value="150548473"></label><br>
<label>Railway API_KEY: <input id="key" type="password" autocomplete="off"></label><br>
<button id="go">Тест /offers</button><pre id="out"></pre>
<script>document.getElementById('go').onclick=async()=>{
const pid=document.getElementById('pid').value.trim();
const key=document.getElementById('key').value.trim();
const out=document.getElementById('out');out.textContent='Запрос...';
try{const r=await fetch('/offers?productId='+encodeURIComponent(pid),{headers:{'X-API-Key':key}});
out.textContent='HTTP '+r.status+'\\n'+JSON.stringify(await r.json(),null,2)}catch(e){out.textContent=String(e)}
};</script></body></html>`);
});

// Existing GAS monitor endpoint. Response shape intentionally retained.
app.get('/offers', requireKey, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const productId = String(req.query.productId || '').trim();
  const cityId = String(req.query.cityId || DEFAULT_CITY).trim();
  const limit = boundedInt(req.query.limit, 50, 1, 100);
  if (!validId(productId, 6, 15)) return res.status(400).json({ ok: false, error: 'invalid_product_id' });
  if (!validId(cityId, 6, 15)) return res.status(400).json({ ok: false, error: 'invalid_city_id' });
  try {
    const upstream = await fetchOffers(productId, cityId, limit);
    if (upstream.status !== 200 || !upstream.data || typeof upstream.data !== 'object') {
      return res.status(statusForUpstream(upstream.status)).json({
        ok: false,
        error: upstream.status === 403 ? 'kaspi_forbidden' : 'kaspi_http_error',
        upstreamStatus: upstream.status,
        elapsedMs: upstream.elapsedMs,
        proxyConfigured: Boolean(UPSTREAM_PROXY_URL),
        body: typeof upstream.data === 'string' ? upstream.data.slice(0, 500) : null
      });
    }
    return res.json({
      ok: true, upstreamStatus: 200, elapsedMs: upstream.elapsedMs,
      proxyConfigured: Boolean(UPSTREAM_PROXY_URL), productId, cityId, data: upstream.data
    });
  } catch (error) {
    console.error('/offers request:', error.code || error.message);
    return res.status(502).json({
      ok: false, error: 'kaspi_request_failed',
      upstreamStatus: Number(error.response?.status || 0) || null,
      ...publicError(error)
    });
  }
});

// Existing GAS first-page catalog endpoint. Does NOT prove full catalog coverage.
app.get('/catalog', requireKey, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ids = checkMerchantCity(req, res);
  if (!ids) return;
  try {
    const upstream = await fetchCatalogPage(ids.merchantId, ids.cityId, 0);
    if (upstream.status !== 200 || !Array.isArray(upstream.data?.data)) {
      return res.status(statusForUpstream(upstream.status)).json({
        ok: false, error: 'catalog_response_unavailable', upstreamStatus: upstream.status,
        bodyPreview: typeof upstream.data === 'string' ? upstream.data.slice(0, 500) : null
      });
    }
    const products = upstream.data.data.map(simplifyProduct);
    return res.json({
      ok: true, experimental: true, ...ids, page: 0,
      elapsedMs: upstream.elapsedMs, count: products.length,
      warning: 'Only page 0 of city storefront search. Completeness and SKU are NOT verified. listingPrice may be another merchant price.',
      products, raw: upstream.data
    });
  } catch (error) {
    console.error('/catalog request:', error.code || error.message);
    return res.status(502).json({ ok: false, error: 'catalog_request_failed', ...publicError(error) });
  }
});

app.get('/catalog-test', (req, res) => {
  res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Domplast — каталог</title><style>body{font:16px Arial;max-width:780px;margin:32px auto}
input,button{padding:9px;margin:5px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body>
<h2>Тест страниц каталога</h2><p>Диагностика только читает данные. Не меняет прайс.</p>
<label>Merchant ID <input id="merchant" value="30427112"></label><br>
<label>City ID <input id="city" value="351010000"></label><br>
<label>Страница <input id="page" type="number" min="0" max="20" value="0"></label><br>
<label>Проверить /offers у первых N <input id="verify" type="number" min="0" max="5" value="3"></label><br>
<label>API_KEY <input id="key" type="password" autocomplete="off"></label><br>
<button id="go">Запросить страницу</button><pre id="out"></pre>
<script>document.getElementById('go').onclick=async function(){
const el=id=>document.getElementById(id);const out=el('out');this.disabled=true;out.textContent='Запрос...';
try{const q=new URLSearchParams({merchantId:el('merchant').value.trim(),cityId:el('city').value.trim(),
page:el('page').value.trim(),verify:el('verify').value.trim()});
const r=await fetch('/catalog-page-probe?'+q,{headers:{'X-API-Key':el('key').value.trim()}});
out.textContent='HTTP '+r.status+'\\n'+JSON.stringify(await r.json(),null,2)
}catch(e){out.textContent=String(e)}finally{this.disabled=false}
};</script></body></html>`);
});

// Three-page diagnostic client is already written in Apps Script; keep shape stable.
app.get('/catalog-page-probe', requireKey, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ids = checkMerchantCity(req, res);
  if (!ids) return;
  const page = boundedInt(req.query.page, 0, 0, 20);
  const verify = boundedInt(req.query.verify, 3, 0, 5);
  try {
    const upstream = await fetchCatalogPage(ids.merchantId, ids.cityId, page);
    if (upstream.status !== 200 || !Array.isArray(upstream.data?.data)) {
      return res.status(statusForUpstream(upstream.status)).json({
        ok: false, error: 'catalog_response_unavailable', upstreamStatus: upstream.status,
        bodyPreview: typeof upstream.data === 'string' ? upstream.data.slice(0, 300) : null
      });
    }
    const products = upstream.data.data.map(simplifyProduct);
    const verified = [];
    for (const product of products.slice(0, verify)) {
      if (!validId(product.productId, 6, 15)) continue;
      try {
        const of = await fetchOffers(product.productId, ids.cityId, 50);
        if (of.status !== 200 || !Array.isArray(of.data?.offers)) {
          verified.push({
            productId: product.productId, offersHttp: of.status,
            offersCount: null, merchantFound: null,
            ourMerchantSku: null, ourPrice: null,
            error: 'Offers unavailable or unexpected body'
          });
          continue;
        }
        const offers = of.data.offers;
        const own = offers.filter(o => String(o.merchantId || '') === ids.merchantId);
        verified.push({
          productId: product.productId,
          offersHttp: of.status, offersCount: offers.length,
          merchantFound: own.length > 0,
          ourMerchantSku: own[0]?.merchantSku == null ? null : String(own[0].merchantSku),
          ourPrice: typeof own[0]?.price === 'number' ? own[0].price : null,
          firstOfferMerchant: offers[0]?.merchantId == null ? null : String(offers[0].merchantId)
        });
      } catch (error) {
        verified.push({ productId: product.productId, error: String(error.code || error.message || error).slice(0, 150) });
      }
    }
    return res.json({
      ok: true, experimental: true, ...ids, page,
      elapsedMs: upstream.elapsedMs, count: products.length,
      pagination: paginationHints(upstream.data),
      products, verified,
      warning: 'Experimental storefront search, NOT a verified complete merchant catalog. Do not mark missing SKUs delisted. listingPrice is NOT our confirmed price.'
    });
  } catch (error) {
    console.error('/catalog-page-probe request:', error.code || error.message);
    return res.status(502).json({ ok: false, error: 'catalog_probe_failed', ...publicError(error) });
  }
});


// FULL-SCAN TEST: one storefront page per request; verifies ALL found cards against our
// actual offer. Responses are observations, not a guarantee of complete seller inventory.
function extractOwnOffer(offers, merchantId) {
  const own = offers.find(o => String(o?.merchantId || '') === merchantId);
  return own ? {
    merchantFound: true,
    merchantSku: own.merchantSku == null ? null : String(own.merchantSku),
    ourPrice: Number.isFinite(Number(own.price)) ? Number(own.price) : null
  } : { merchantFound: false, merchantSku: null, ourPrice: null };
}
async function verifyOurOffer(productId, merchantId, cityId) {
  const result = await fetchOffers(productId, cityId, VERIFY_OFFERS_LIMIT);
  if (result.status !== 200 || !Array.isArray(result.data?.offers)) {
    return { state: 'ERROR', error: 'offers_http_' + result.status, upstreamStatus: result.status,
      bodyPreview: typeof result.data === 'string' ? result.data.slice(0, 320) :
        (result.data && typeof result.data === 'object' ? JSON.stringify(result.data).slice(0, 320) : null) };
  }
  const offers = result.data.offers;
  const own = extractOwnOffer(offers, merchantId);
  return { state: own.merchantFound ? 'CONFIRMED' : 'NOT_CONFIRMED',
    ...own, offersCount: offers.length,
    // Absence from this offer window is NOT proof of delisting.
    possiblyTruncated: offers.length >= VERIFY_OFFERS_LIMIT };
}
function safeProduct(p) {
  return { productId: p.productId, name: p.name, shopLink: p.shopLink,
    listingPrice: p.listingPrice, bestMerchant: p.bestMerchant };
}
app.get('/catalog-scan-page', requireKey, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ids = checkMerchantCity(req, res);
  if (!ids) return;
  const page = boundedInt(req.query.page, 0, 0, 2000);
  try {
    const upstream = await fetchCatalogPage(ids.merchantId, ids.cityId, page);
    if (upstream.status !== 200 || !Array.isArray(upstream.data?.data)) {
      return res.status(statusForUpstream(upstream.status)).json({ok:false,
        error:'catalog_response_unavailable',upstreamStatus:upstream.status});
    }
    const products = upstream.data.data.map(simplifyProduct);
    // Offer checks run with bounded concurrency and budget; individual errors
    // remain visible to the Apps Script retry phase.
    const checked = new Array(products.length);
    let cursor = 0;
    const deadline = Date.now() + 70000;
    async function worker() {
      while (cursor < products.length) {
        const n = cursor++;
        const product = products[n];
        if (!validId(product.productId, 6, 15)) {
          checked[n] = {...safeProduct(product),state:'ERROR',error:'invalid_product_id'};
          continue;
        }
        if (Date.now() > deadline) {
          checked[n] = {...safeProduct(product),state:'ERROR',error:'request_time_budget'};
          continue;
        }
        try {
          const verified = await verifyOurOffer(product.productId, ids.merchantId, ids.cityId);
          checked[n] = {...safeProduct(product), ...verified};
        } catch (error) {
          checked[n] = {...safeProduct(product),state:'ERROR',error:String(error.code || error.message || error).slice(0,120)};
        }
      }
    }
    await Promise.all([worker(),worker(),worker()]);
    return res.json({ok:true,version:VERSION,...ids,page,count:products.length,
      elapsedMs:upstream.elapsedMs,checked,
      note:'Search results may change across pages. NOT_CONFIRMED is not DELISTED. Never purge missing items.'});
  } catch (error) {
    return res.status(502).json({ok:false,error:'catalog_scan_failed',...publicError(error)});
  }
});

// Retry individual ERROR/NOT_CONFIRMED cards without refreshing the search page.
app.get('/catalog-verify-own', requireKey, async (req,res) => {
  res.set('Cache-Control','no-store');
  const ids = checkMerchantCity(req,res);
  if (!ids) return;
  const productId = String(req.query.productId || '').trim();
  if (!validId(productId,6,15)) return res.status(400).json({ok:false,error:'invalid_product_id'});
  try {
    const v = await verifyOurOffer(productId,ids.merchantId,ids.cityId);
    return res.json({ok:true,productId,...ids,...v});
  } catch (error) {
    return res.status(502).json({ok:false,error:'catalog_verify_failed',...publicError(error)});
  }
});

// V6: batch SKU/price verification for already collected Product IDs.
// This endpoint does NOT scan catalog pages and does NOT write to Google Sheets.
// It stops assigning new work if Kaspi starts returning 403/429; completed results are still returned.
app.post('/catalog-verify-batch', requireKey, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const merchantId = String(req.body?.merchantId || DEFAULT_MERCHANT).trim();
  const cityId = String(req.body?.cityId || DEFAULT_CITY).trim();
  const requestedConcurrency = boundedInt(req.body?.concurrency, BATCH_VERIFY_DEFAULT_CONCURRENCY, 1, BATCH_VERIFY_MAX_CONCURRENCY);
  const rawIds = Array.isArray(req.body?.productIds) ? req.body.productIds : [];

  if (!validId(merchantId) || !validId(cityId, 6, 15)) {
    return res.status(400).json({ok:false,error:'invalid_merchant_or_city'});
  }
  if (!rawIds.length) return res.status(400).json({ok:false,error:'empty_product_ids'});

  const seen = new Set();
  const productIds = [];
  for (const raw of rawIds) {
    const id = String(raw ?? '').trim();
    if (!validId(id, 6, 15)) return res.status(400).json({ok:false,error:'invalid_product_id',productId:id});
    if (!seen.has(id)) { seen.add(id); productIds.push(id); }
    if (productIds.length >= BATCH_VERIFY_MAX) break;
  }

  const started = Date.now();
  const results = new Array(productIds.length);
  let cursor = 0;
  let throttled = false;
  let throttleStatus = null;

  async function worker() {
    while (true) {
      if (throttled) return;
      const index = cursor++;
      if (index >= productIds.length) return;
      const productId = productIds[index];
      try {
        const result = await verifyOurOffer(productId, merchantId, cityId);
        results[index] = {productId, ...result};
        if (result.state === 'ERROR' && (result.upstreamStatus === 403 || result.upstreamStatus === 429)) {
          throttled = true;
          throttleStatus = result.upstreamStatus;
          return;
        }
      } catch (error) {
        const status = Number(error.response?.status || 0) || null;
        results[index] = {productId,state:'ERROR',error:'verify_exception',upstreamStatus:status,...publicError(error)};
        if (status === 403 || status === 429) {
          throttled = true;
          throttleStatus = status;
          return;
        }
      }
      if (BATCH_VERIFY_DELAY_MS > 0) await sleep(BATCH_VERIFY_DELAY_MS);
    }
  }

  await Promise.all(Array.from({length: requestedConcurrency}, () => worker()));
  const completed = results.filter(Boolean);
  const confirmed = completed.filter(x => x.state === 'CONFIRMED' && x.merchantSku).length;
  const errors = completed.filter(x => x.state === 'ERROR').length;
  const notConfirmed = completed.filter(x => x.state === 'NOT_CONFIRMED').length;

  return res.json({
    ok:true, version:VERSION, build:BUILD, merchantId, cityId,
    requested:productIds.length, processed:completed.length,
    confirmed, notConfirmed, errors,
    concurrency:requestedConcurrency, delayMs:BATCH_VERIFY_DELAY_MS,
    throttled, throttleStatus,
    elapsedMs:Date.now()-started,
    results:completed,
    note:'Batch verifies existing Product IDs only. CONFIRMED merchantSku/ourPrice belong to requested merchant. NOT_CONFIRMED is not proof of delisting.'
  });
});

// NEW V5: listing-only page. Makes ZERO /offers requests.
// Public merchant-filtered search is experimental and does not prove complete inventory.
app.get('/catalog-list-page', requireKey, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ids = checkMerchantCity(req, res);
  if (!ids) return;
  const page = boundedInt(req.query.page, 0, 0, 2000);
  try {
    const upstream = await fetchCatalogPage(ids.merchantId, ids.cityId, page);
    if (upstream.status !== 200 || !Array.isArray(upstream.data?.data)) {
      return res.status(statusForUpstream(upstream.status)).json({
        ok: false, error: 'catalog_list_unavailable', upstreamStatus: upstream.status,
        bodyPreview: typeof upstream.data === 'string' ? upstream.data.slice(0, 220) : null
      });
    }
    const products = upstream.data.data.map(simplifyProduct);
    return res.json({ ok: true, version: VERSION, ...ids, page,
      count: products.length, elapsedMs: upstream.elapsedMs,
      products, pagination: paginationHints(upstream.data),
      warning: 'Experimental city search. Missing items are NOT proof of delisting; listingPrice is NOT our price.' });
  } catch (error) {
    return res.status(502).json({ok: false, error: 'catalog_list_failed', ...publicError(error)});
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`DOMPLAST SERVER VERSION: ${VERSION} / ${BUILD}`);
  console.log(`Listening on port ${PORT}`);
  console.log(`Proxy configured: ${Boolean(UPSTREAM_PROXY_URL)}`);
  console.log(`Batch verify: max=${BATCH_VERIFY_MAX}, concurrency=${BATCH_VERIFY_DEFAULT_CONCURRENCY}, delayMs=${BATCH_VERIFY_DELAY_MS}, offersLimit=${VERIFY_OFFERS_LIMIT}`);
});
