// TEST ONLY. Add this route BEFORE app.listen(...) in your existing server.js.
// Does not change /catalog, /offers, or the Google Sheet.
app.get('/catalog-page-probe', auth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const merchantId = String(req.query.merchantId || '30427112').trim();
  const cityId = String(req.query.cityId || '351010000').trim();
  const page = positiveInt(req.query.page, 0, 0, 20);
  const verify = positiveInt(req.query.verify, 3, 0, 5);
  if (!/^\d{1,20}$/.test(merchantId) || !/^\d{6,15}$/.test(cityId)) {
    return res.status(400).json({ok:false,error:'invalid_merchant_or_city'});
  }
  const agent = proxyAgent();
  const params = {q: ':availableInZones:' + cityId + ':allMerchants:' + merchantId,
    page, sort:'relevance', ui:'d', i:-1, c:cityId};
  const config = {params,timeout:REQUEST_TIMEOUT_MS,validateStatus:()=>true,
    maxRedirects:0,maxContentLength:2*1024*1024,
    headers:{Accept:'application/json','User-Agent':'Mozilla/5.0',
      Referer:'https://kaspi.kz/shop/search/'}};
  if (agent) { config.httpAgent=agent; config.httpsAgent=agent; config.proxy=false; }
  try {
    const started=Date.now();
    const upstream=await axios.get('https://kaspi.kz/yml/product-view/pl/results', config);
    const body=upstream.data;
    if(upstream.status!==200 || !body || !Array.isArray(body.data)) {
      return res.status(upstream.status===429?429:502).json({ok:false,
        error:'catalog_response_unavailable',upstreamStatus:upstream.status,
        bodyPreview:typeof body==='string'?body.slice(0,300):null});
    }
    // We intentionally do NOT treat bestMerchant as proof that the merchant owns a card.
    const products=body.data.map(p=>({productId:p.id==null?null:String(p.id),
      name:p.title||null, listingPrice:p.unitSalePrice??p.unitPrice??null,
      bestMerchant:p.bestMerchant==null?null:String(p.bestMerchant)}));
    // Surface pagination hints without returning huge raw data or leaking keys.
    const pagination={};
    for (const [key,value] of Object.entries(body)) {
      if(key==='data') continue;
      if(['string','number','boolean'].includes(typeof value) || value===null)
        pagination[key]=value;
      else if (Array.isArray(value)) pagination[key]={arrayLength:value.length};
      else if(value && typeof value==='object') {
        const shallow={};
        for (const [k,v] of Object.entries(value)) {
          if(['string','number','boolean'].includes(typeof v) || v===null) shallow[k]=v;
        }
        pagination[key]=shallow;
      }
    }
    const verified=[];
    for(const product of products.slice(0,verify)) {
      if(!/^\d{6,15}$/.test(product.productId||'')) continue;
      try {
        const of=await fetchKaspiOffers(product.productId,cityId,50);
        const offers=of.data && Array.isArray(of.data.offers) ? of.data.offers : [];
        const own=offers.filter(o=>String(o.merchantId||'')===merchantId);
        verified.push({productId:product.productId,offersHttp:of.status,
          offersCount:offers.length,merchantFound:own.length>0,
          // Merchant SKU and our price come from the VERIFIED merchant's offer only.
          ourMerchantSku:own[0]?.merchantSku==null?null:String(own[0].merchantSku),
          ourPrice:typeof own[0]?.price==='number'?own[0].price:null,
          firstOfferMerchant:offers[0]?.merchantId==null?null:String(offers[0].merchantId)});
      } catch(e) {
        verified.push({productId:product.productId,error:String(e.code||e.message||e).slice(0,150)});
      }
    }
    return res.json({ok:true,experimental:true,merchantId,cityId,page,
      elapsedMs:Date.now()-started,count:products.length,pagination,
      products,verified,
      warning:'This is an experimental storefront search, NOT a complete merchant catalog. Do not delete unlisted SKUs or use listingPrice as our price.'});
  } catch(e) {
    return res.status(502).json({ok:false,error:'catalog_probe_failed',code:e.code||null,
      message:String(e.message||e).slice(0,200)});
  }
});
