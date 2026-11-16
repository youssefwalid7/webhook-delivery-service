import http from 'node:http';

// A fake customer for testing. The path picks how it behaves:
//   /ok     answers 200 at once
//   /fail   answers 500
//   /slow   answers after 10 s, longer than the worker's 5 s limit
//   /flaky  fails twice for each delivery id, then answers 200
// GET /received lists the last 1,000 webhooks it got, for the demo script.
const received = [];
const flakyTries = new Map();

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/received') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(received));
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString(); // the raw body, exactly as signed
    received.push({
      path: req.url,
      timestamp: req.headers['webhook-timestamp'],
      signature: req.headers['webhook-signature'],
      body,
    });
    if (received.length > 1000) received.shift();
    console.log(`${req.url} received ${JSON.parse(body).id}`);

    if (req.url === '/ok') return res.end('ok');
    if (req.url === '/fail') return res.writeHead(500).end();
    if (req.url === '/slow') return setTimeout(() => res.end('late'), 10_000);
    if (req.url === '/flaky') {
      const id = JSON.parse(body).id;
      const tries = (flakyTries.get(id) ?? 0) + 1;
      flakyTries.set(id, tries);
      return tries <= 2 ? res.writeHead(503).end() : res.end('ok');
    }
    res.writeHead(404).end();
  });
}).listen(4000, () => console.log('Test receiver listening on port 4000'));
