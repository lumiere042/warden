// A tiny site with known defects, used by the tests and for trying the tool locally:
//   npm run fixture   then   npm run qa -- --config test/fixture-site/qa.config.json --no-email
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const head = (title, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${extra}</head><body>`;
const goodMeta = (path, desc) => `<meta name="description" content="${desc}">
<link rel="canonical" href="${path}"><meta property="og:title" content="Fixture"><meta property="og:description" content="${desc}"><meta property="og:image" content="/logo.png">`;

const pages = {
  '/': () =>
    head('Fixture Site — Home Page', goodMeta('/', 'A fixture website used to test the website QA checker with known defects.')) +
    `<h1>Home</h1>
     <a href="/about">About</a> <a href="/slow">Slow</a> <a href="/contact">Contact</a>
     <a href="/missing-page">Broken link</a> <a href="/noindex">Noindex</a>
     <img src="/logo.png" alt=""> <img src="/img/missing.png" alt="">
     </body></html>`,
  // Missing description, two h1s, no OG tags
  '/about': () => head('About Fixture Site', '<link rel="canonical" href="/about">') + `<h1>About</h1><h1>Second H1</h1><a href="/">Home</a></body></html>`,
  '/noindex': () =>
    head('Fixture Site — Noindex Page', goodMeta('/noindex', 'This page is accidentally hidden from search engines by a robots meta tag.') + '<meta name="robots" content="noindex">') +
    `<h1>Hidden</h1></body></html>`,
  // Only reachable through sitemap.xml
  '/hidden': () => head('Fixture Site — Sitemap Only', goodMeta('/hidden', 'This page is only linked from the sitemap, to test sitemap discovery.')) + `<h1>Sitemap only</h1></body></html>`,
  '/contact': () =>
    head('Fixture Site — Contact Us', goodMeta('/contact', 'Contact form page with one working form, one broken form, and one with a required field.')) +
    `<h1>Contact</h1>
     <form id="contact" action="/api/contact" method="post">
       <input id="email" name="email" type="email" required>
       <textarea id="message" name="message"></textarea>
       <button type="submit">Send</button>
     </form>
     <p id="thanks" hidden>Thanks, we got your message</p>
     <form id="broken" action="/api/broken" method="post">
       <input id="name" name="name">
       <button type="submit">Send</button>
     </form>
     <form id="required" action="/api/contact" method="post">
       <input id="phone" name="phone" required>
       <button type="submit">Send</button>
     </form>
     <form id="newsletter" action="/api/newsletter" method="post"><input name="nl" type="email"><button>Join</button></form>
     <script>
       document.getElementById('contact').addEventListener('submit', async (e) => {
         e.preventDefault();
         const res = await fetch('/api/contact', { method: 'POST', body: new URLSearchParams(new FormData(e.target)) });
         if (res.ok) document.getElementById('thanks').hidden = false;
       });
     </script>
     </body></html>`,
};

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const send = (status, body, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };

    if (req.method === 'POST') {
      for await (const _ of req);
      if (p === '/api/contact') return send(200, '{"ok":true}', 'application/json');
      if (p === '/api/broken') return send(500, 'Internal Server Error', 'text/plain');
      return send(404, 'not found', 'text/plain');
    }
    if (p === '/sitemap.xml') {
      const base = `http://${req.headers.host}`;
      return send(200, `<?xml version="1.0"?><urlset><url><loc>${base}/</loc></url><url><loc>${base}/hidden</loc></url></urlset>`, 'application/xml');
    }
    if (p === '/logo.png') return send(200, Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png');
    if (p === '/slow') {
      await new Promise((r) => setTimeout(r, 3500));
      return send(200, head('Fixture Site — Slow Page', goodMeta('/slow', 'A page that takes over three seconds to respond, to test performance flags.')) + '<h1>Slow</h1></body></html>');
    }
    if (pages[p]) return send(200, pages[p]());
    return send(404, head('Not found') + '<h1>404</h1></body></html>');
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4000);
  createServer().listen(port, () => console.log(`Fixture site on http://localhost:${port}`));
}
