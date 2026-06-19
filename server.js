const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = process.env.PORT || 3000;

console.log('Starting server...');
console.log('API KEY exists:', !!API_KEY);
console.log('PORT:', PORT);
console.log('__dirname:', __dirname);
console.log('Files in dir:', fs.readdirSync(__dirname));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // API PROXY
  if (req.method === 'POST' && parsed.pathname === '/api/chat') {
    if (!API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch(e) { res.writeHead(400); res.end('Bad JSON'); return; }
      const kieBody = JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1000,
        system: payload.system || '',
        messages: payload.messages || [],
        stream: false,
      });
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
          res.writeHead(kieRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });
      kieReq.on('error', err => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
      kieReq.write(kieBody);
      kieReq.end();
    });
    return;
  }

  // STATIC FILES из папки public
  let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  filePath = path.join(__dirname, 'public', filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // если файл не найден — отдаём index.html (SPA fallback)
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('404 Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
