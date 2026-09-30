'use strict';

const express = require('express');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const PORT = Number(process.env.PORT || 8080);
const API_KEY = String(process.env.API_KEY || '').trim();
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 25000);
const UPSTREAM_PROXY_URL = String(process.env.UPSTREAM_PROXY_URL || '').trim();

if (!API_KEY) {
  console.error('FATAL: API_KEY environment variable is required');
  process.exit(1);
}

function auth(req, res, next) {
  const key = String(req.get('X-API-Key') || '').trim();
  if (!key || key !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

function positiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function proxyAgent() {
  return UPSTREAM_PROXY_URL ? new HttpsProxyAgent(UPSTREAM_PROXY_URL) : undefined;
}

async function fetchKaspiOffers(productId, cityId, limit) {
  const url = `https://kaspi.kz/yml/offer-view/offers/${encodeURIComponent(productId)}`;
  const payload = {
    cityId: String(cityId),
    id: String(productId),
    merchantUID: '',
    limit,
    page: 0,
    sortOption: null,
    highRating: null,
    searchText: null,
    isExcellentMerchant: false,
    installationId: '-1'
  };

  const agent = proxyAgent();
  const config = {
    method: 'post',
    url,
    data: payload,
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
    maxRedirects: 5,
    headers: {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      'Content-Type': 'application/json;charset=UTF-8',
      'Origin': 'https://kaspi.kz',
      'Referer': `https://kaspi.kz/shop/p/-${encodeURIComponent(productId)}/?c=${encodeURIComponent(cityId)}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    }
  };

  if (agent) {
    config.httpAgent = agent;
    config.httpsAgent = agent;
    config.proxy = false;
  }

  const started = Date.now();
  const response = await axios(config);
  const elapsedMs = Date.now() - started;

  return {
    status: response.status,
    elapsedMs,
    data: response.data,
    responseHeaders: {
      server: response.headers?.server || null,
      'content-type': response.headers?.['content-type'] || null
    }
  };
}

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'domplast-kaspi-railway-test',
    proxyConfigured: Boolean(UPSTREAM_PROXY_URL),
    railway: {
      environment: process.env.RAILWAY_ENVIRONMENT_NAME || null,
      region: process.env.RAILWAY_REPLICA_REGION || null
    },
    time: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kaspi Railway Test</title>
<style>body{font-family:Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 16px}input,button{font-size:16px;padding:10px;margin:5px 0;width:100%;box-sizing:border-box}button{cursor:pointer}pre{white-space:pre-wrap;background:#f4f4f4;padding:12px;border-radius:8px;overflow:auto}.ok{color:#087a27}.bad{color:#b00020}</style></head>
<body><h2>Domplast — тест Railway → Kaspi</h2>
<p>Введите Product ID и API_KEY из переменных Railway. Ключ отправляется в заголовке X-API-Key и не попадает в URL.</p>
<label>Product ID</label><input id="pid" placeholder="137135273" inputmode="numeric">
<label>API_KEY</label><input id="key" type="password" placeholder="ваш секретный API_KEY">
<button id="go">Проверить Kaspi</button>
<div id="status"></div><pre id="out"></pre>
<script>
const q=s=>document.querySelector(s);
q('#go').onclick=async()=>{const pid=q('#pid').value.trim(), key=q('#key').value.trim(); q('#status').textContent='Запрос...'; q('#out').textContent=''; try{const r=await fetch('/offers?productId='+encodeURIComponent(pid),{headers:{'X-API-Key':key}}); const j=await r.json(); q('#status').className=r.ok?'ok':'bad'; q('#status').textContent='HTTP '+r.status+(j.upstreamStatus?' / Kaspi '+j.upstreamStatus:''); q('#out').textContent=JSON.stringify(j,null,2);}catch(e){q('#status').className='bad'; q('#status').textContent='Ошибка'; q('#out').textContent=String(e);}};
</script></body></html>`);
});

app.get('/offers', auth, async (req, res) => {
  const productId = String(req.query.productId || '').trim();
  const cityId = String(req.query.cityId || '351010000').trim();
  const limit = positiveInt(req.query.limit, 50, 1, 100);

  if (!/^\d{6,15}$/.test(productId)) {
    return res.status(400).json({ ok: false, error: 'invalid_product_id' });
  }
  if (!/^\d{6,15}$/.test(cityId)) {
    return res.status(400).json({ ok: false, error: 'invalid_city_id' });
  }

  try {
    const upstream = await fetchKaspiOffers(productId, cityId, limit);
    const preview = typeof upstream.data === 'string'
      ? upstream.data.slice(0, 1000)
      : upstream.data;

    if (upstream.status !== 200) {
      return res.status(502).json({
        ok: false,
        error: upstream.status === 403 ? 'kaspi_forbidden' : 'kaspi_http_error',
        upstreamStatus: upstream.status,
        elapsedMs: upstream.elapsedMs,
        proxyConfigured: Boolean(UPSTREAM_PROXY_URL),
        body: preview
      });
    }

    return res.json({
      ok: true,
      upstreamStatus: upstream.status,
      elapsedMs: upstream.elapsedMs,
      proxyConfigured: Boolean(UPSTREAM_PROXY_URL),
      productId,
      cityId,
      data: upstream.data
    });
  } catch (e) {
    console.error(e);
    const code = e.code || null;
    const status = Number(e.response?.status || 0) || null;
    return res.status(502).json({
      ok: false,
      error: 'kaspi_request_failed',
      upstreamStatus: status,
      code,
      message: String(e.message || e).slice(0, 800)
    });
  }
});

// Read-only, single-page experiment. Never use listing price as our price.
app.get('/catalog-test', (req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Каталог Domplast</title>
<h2>Проверка одной страницы каталога</h2>
<p>Тест ничего не меняет в Google Таблицах. Цена выдачи может принадлежать другому продавцу.</p>
<label>Merchant ID <input id="merchant" value="30427112"></label><br>
<label>Город <input id="city" value="351010000"></label><br>
<label>API_KEY <input id="key" type="password" autocomplete="off"></label><br>
<button id="go">Получить первую страницу</button><pre id="out"></pre>
<script>
document.getElementById('go').onclick=async function(){
 const el=id=>document.getElementById(id); this.disabled=true; el('out').textContent='Запрос…';
 try { const query=new URLSearchParams({merchantId:el('merchant').value.trim(),cityId:el('city').value.trim()});
 const r=await fetch('/catalog?'+query,{headers:{'X-API-Key':el('key').value.trim()}});
 el('out').textContent='HTTP '+r.status+'\\n'+JSON.stringify(await r.json(),null,2);
 } catch(e){el('out').textContent=String(e);} finally{this.disabled=false;}
};</script>`);
});

app.get('/catalog', auth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const merchantId = String(req.query.merchantId || '').trim();
  const cityId = String(req.query.cityId || '351010000').trim();
  if (!/^\d{1,20}$/.test(merchantId) || !/^\d{6,15}$/.test(cityId)) {
    return res.status(400).json({ok:false,error:'invalid_merchant_or_city'});
  }
  const params = {q:':availableInZones:'+cityId+':allMerchants:'+merchantId,
    page:0,sort:'relevance',ui:'d',i:-1,c:cityId};
  const agent = proxyAgent();
  const config = {params,timeout:REQUEST_TIMEOUT_MS,validateStatus:()=>true,
    maxRedirects:0,maxContentLength:2*1024*1024,
    headers:{Accept:'application/json','User-Agent':'Mozilla/5.0',
      Referer:'https://kaspi.kz/shop/search/'}};
  if(agent){config.httpAgent=agent;config.httpsAgent=agent;config.proxy=false;}
  try {
    const started=Date.now();
    const upstream=await axios.get('https://kaspi.kz/yml/product-view/pl/results',config);
    const body=upstream.data;
    if(upstream.status!==200 || !body || !Array.isArray(body.data)) {
      return res.status(upstream.status===429?429:502).json({ok:false,
        error:'catalog_response_unavailable',upstreamStatus:upstream.status,
        bodyPreview:typeof body==='string'?body.slice(0,500):body});
    }
    const products=body.data.map(p=>({productId:p.id==null?null:String(p.id),
      name:p.title||null,shopLink:p.shopLink||null,
      listingPrice:p.unitSalePrice??p.unitPrice??null,
      bestMerchant:p.bestMerchant==null?null:String(p.bestMerchant),
      merchantSku:null}));
    return res.json({ok:true,experimental:true,merchantId,cityId,page:0,
      elapsedMs:Date.now()-started,count:products.length,
      warning:'Одна страница городской витрины. Полнота каталога не проверена. Артикул продавца не установлен. listingPrice не подтверждена как наша цена.',
      products,raw:body});
  } catch(e) {
    return res.status(502).json({ok:false,error:'catalog_request_failed',code:e.code||null});
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Domplast Kaspi Railway test listening on :${PORT}`);
  console.log(`Proxy configured: ${Boolean(UPSTREAM_PROXY_URL)}`);
});
