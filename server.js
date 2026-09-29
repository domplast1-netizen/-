const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = process.env.PORT || 3000;

console.log('✅ Server starting...');
console.log('API KEY exists:', !!API_KEY);
console.log('PORT:', PORT);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── API PROXY ──
  if (req.method === 'POST' && req.url === '/api/chat') {
    if (!API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set on server' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch(e) { res.writeHead(400); res.end('Bad JSON'); return; }

      const kieBody = JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: payload.system || '',
        messages: payload.messages || [],
        stream: false,
        thinkingFlag: false,
      });

      console.log(`→ kie.ai request: ${(payload.messages||[]).length} messages`);

      const options = {
        hostname: 'api.kie.ai',
        path: '/claude/v1/messages',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(kieBody),
        },
      };

      const kieReq = https.request(options, kieRes => {
        let data = '';
        kieRes.on('data', c => data += c);
        kieRes.on('end', () => {
          console.log(`← kie.ai status: ${kieRes.statusCode}`);
          if (kieRes.statusCode !== 200) {
            console.log('← kie.ai error:', data.slice(0, 500));
          }
          res.writeHead(kieRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });

      kieReq.on('error', err => {
        console.error('Network error:', err.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Network error: ' + err.message }));
      });

      kieReq.write(kieBody);
      kieReq.end();
    });
    return;
  }

  // ── STATIC FILES ──
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  filePath = path.join(__dirname, 'public', filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      const index = path.join(__dirname, 'public', 'index.html');
      fs.readFile(index, (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('404'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`✅ Running on http://localhost:${PORT}`);
});
