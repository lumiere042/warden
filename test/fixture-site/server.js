// A tiny site with known defects, used by the tests and for trying the tool locally:
//   npm run fixture   then   npm run qa -- --config test/fixture-site/qa.config.json --no-email
import http from 'node:http';
import zlib from 'node:zlib';
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
     <a href="/js-error">JS error</a> <a href="/layout-shift">Layout shift</a>
     <img src="/logo.png" alt=""> <img src="/img/missing.png" alt="">
     </body></html>`,
  // Missing description, two h1s, no OG tags
  '/about': () => head('About Fixture Site', '<link rel="canonical" href="/about">') + `<h1>About</h1><h1>Second H1</h1><a href="/">Home</a></body></html>`,
  '/noindex': () =>
    head('Fixture Site — Noindex Page', goodMeta('/noindex', 'This page is accidentally hidden from search engines by a robots meta tag.') + '<meta name="robots" content="noindex">') +
    `<h1>Hidden</h1></body></html>`,
  // Only reachable through sitemap.xml
  // Logs the same widget error as /js-error (different cache-buster and line number), so the two group into one issue.
  '/hidden': () =>
    head('Fixture Site — Sitemap Only', goodMeta('/hidden', 'This page is only linked from the sitemap, to test sitemap discovery.')) +
    `<h1>Sitemap only</h1><script>console.error('Widget failed in /widget.js?v=2:40:9')</script></body></html>`,
  '/js-error': () =>
    head('Fixture Site — JavaScript Error', goodMeta('/js-error', 'A page whose scripts fail, to test that JavaScript errors are reported.')) +
    `<h1>JS error</h1><script>console.error('Widget failed in /widget.js?v=1:12:5')</script><script>throw new Error('Boom from fixture')</script></body></html>`,
  // Content jumps down after load: a cumulative layout shift well over 0.1.
  '/layout-shift': () =>
    head('Fixture Site — Layout Shift', goodMeta('/layout-shift', 'A page whose content jumps down after loading, to test layout shift measurement.')) +
    `<h1>Layout shift</h1><div id="banner"></div><p style="font-size:32px;line-height:1.4;">${'Text that gets pushed down by a late banner. '.repeat(12)}</p>
     <script>setTimeout(() => { const b = document.getElementById('banner'); b.style.height = '400px'; b.style.background = '#ccc'; }, 100);</script></body></html>`,
  // Only reachable through a sitemap listed in robots.txt (sitemap index -> gzipped sitemap)
  '/from-robots': () => head('Fixture Site — From robots.txt', goodMeta('/from-robots', 'This page is only listed in a gzipped sitemap referenced from robots.txt.')) + `<h1>From robots</h1></body></html>`,
  // Only linked from the 404 page, which the crawler must not follow.
  '/only-from-404': () => head('Fixture Site — Only From 404', goodMeta('/only-from-404', 'This page is only linked from the 404 page, so it should never be crawled.')) + `<h1>Orphan</h1></body></html>`,
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
    const base = `http://${req.headers.host}`;
    const urlset = (paths) => `<?xml version="1.0"?><urlset>${paths.map((x) => `<url><loc>${base}${x}</loc></url>`).join('')}</urlset>`;
    // /gone-from-sitemap 404s and nothing links to it; the PDF must not be crawled as a page.
    if (p === '/sitemap.xml') return send(200, urlset(['/', '/hidden', '/gone-from-sitemap', '/brochure.pdf']), 'application/xml');
    if (p === '/robots.txt') return send(200, `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap_index.xml\n`, 'text/plain');
    if (p === '/sitemap_index.xml') {
      return send(200, `<?xml version="1.0"?><sitemapindex><sitemap><loc>${base}/sitemap-pages.xml.gz</loc></sitemap></sitemapindex>`, 'application/xml');
    }
    if (p === '/sitemap-pages.xml.gz') return send(200, zlib.gzipSync(urlset(['/from-robots'])), 'application/gzip');
    if (p === '/brochure.pdf') return send(200, '%PDF-1.4 fixture', 'application/pdf');
    if (p === '/logo.png') return send(200, Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png');
    if (p === '/slow') {
      await new Promise((r) => setTimeout(r, 3500));
      return send(200, head('Fixture Site — Slow Page', goodMeta('/slow', 'A page that takes over three seconds to respond, to test performance flags.')) + '<h1>Slow</h1></body></html>');
    }
    if (pages[p]) return send(200, pages[p]());
    return send(404, head('Not found') + '<h1>404</h1><a href="/only-from-404">You might like</a></body></html>');
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4000);
  createServer().listen(port, () => console.log(`Fixture site on http://localhost:${port}`));
}
