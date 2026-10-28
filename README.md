

https://github.com/user-attachments/assets/9057fd67-e463-4cc5-8122-cc8eaf1e2a4e

# Warden

Automated QA for any website. Paste a link and Warden crawls the site in a real browser, then shows you what's broken:

- **Broken links**: internal pages, images, scripts, stylesheets and (optionally) external links
- **Missing or weak meta tags**: title, description, canonical, viewport, `lang`, H1s, Open Graph, duplicates, accidental `noindex`
- **Slow pages**: load time, Largest Contentful Paint and page weight, against limits you set
- **Forms that don't submit**: fills in your forms and checks they really send, without spamming your inbox
- **AI summary (optional)**: a plain-English "fix these first" briefing from **the AI of your choice** (Claude, OpenAI, Gemini, a local model, or your own adapter)

**No server or account needed.** It runs on your own computer, or free on GitHub Actions, and only when you start it.

---

## Three ways to run it

| | Command | You get |
|---|---|---|
| **In your browser** (easiest) | `npm run serve` | A local page at `http://localhost:4173`: paste any URL, watch it scan, read the results by category |
| **In the terminal** | `npm run qa -- example.com` | A one-off run; the report is saved to `reports/` and optionally emailed |
| **On GitHub** | Actions → **Run QA** | Runs on GitHub's servers and emails you the report; no computer needed |

## Quick start

Requires Node.js 20+.

```bash
git clone https://github.com/lumiere042/warden.git
cd warden
npm install
npx playwright install chromium

npm run serve        # open http://localhost:4173 and paste a URL
```

That's it: no keys or config needed to start. Add `.env` (email, AI) and `qa.config.json` (form tests, limits) later if you want them.

---

## Check a site from your browser

```bash
npm run serve                     # open http://localhost:4173 and paste a URL
npm run serve -- example.com      # or start scanning right away; open the link to watch
```

You get live progress while it crawls (pages found, current page, a progress bar), then the results on the same page, one category at a time:

| Tab | What's in it |
|---|---|
| **Overview** | Counts (critical, warnings, new, fixed, pages, links checked), the AI summary if you've set one up, and the top problems in each category |
| **Broken links** | Every broken link or asset with its status code and the pages it's on. Search it, filter by broken / warnings / new only, 25 per page |
| **Forms** | Each tested form as PASS or FAIL with the reason, plus forms found on the site that aren't set up for testing yet |
| **Speed** | Average load, LCP and page weight against your limits, and one row per slow page with load, LCP, weight, requests and server response time |
| **Meta & SEO** | Grouped by problem, for example "Missing meta description · 30 pages", with a note on why it matters. Click a group to see the pages |
| **Fixed** | What disappeared since your last scan of that site |

Past scans are listed under **Recent reports**; click one to open it in the same view.

Good to know:

- Type `example.com` and it becomes `https://example.com`; `localhost:3000` becomes `http://`, so local dev servers work too.
- Email is off here by default. Tick **Also email me** if you've set up email in `.env`. **AI summary** is available once an AI key is set.
- The page only listens on your own machine (`127.0.0.1`), runs one scan at a time, and `--port 5000` picks a different port.

### Where your results are saved

Every scan, from the browser or the terminal, is saved in the `reports/` folder:

```
reports/
  2026-10-28_0820_example.com.html   ← the full report; opens in any browser, even with Warden stopped
  2026-10-28_0820_example.com.json   ← the same results as data (this is what the browser view reads)
  last.json                          ← what Warden remembers, to mark issues NEW / FIXED next time
```

Each scan gets its own files, named by date, time (UTC) and site. `reports/` is in `.gitignore`, so results never get pushed. Use `--out <folder>` to save them somewhere else. Nothing is emailed unless you set up email.

## Check a site from the terminal

```bash
npm run qa -- example.com --no-email     # scan, save the report, print a summary line
npm run qa                               # scan the sites in qa.config.json and email the report
```

To try it without touching a real site, use the bundled demo site, which has deliberate bugs:

```bash
npm run fixture                                                       # terminal 1
npm run qa -- --config test/fixture-site/qa.config.json --no-email    # terminal 2
```

## Run it on GitHub (free, no computer needed)

1. Click **Use this template**, or fork this repo. A private repo is fine.
2. Edit `qa.config.json` in your copy and put in your site URL and forms. If you'd rather not commit your URL, add a `SITE_URL` secret instead (step 3).
3. Go to **Settings → Secrets and variables → Actions → New repository secret** and add:

   | Secret | Needed? | Example |
   |---|---|---|
   | `EMAIL_PROVIDER` | yes | `resend` or `smtp` |
   | `EMAIL_FROM` | yes | `QA Bot <qa@yourdomain.com>` |
   | `EMAIL_TO` | yes | `you@yourdomain.com,team@yourdomain.com` |
   | `RESEND_API_KEY` | if using Resend | `re_...` |
   | `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | if using SMTP | `smtp.gmail.com` / `465` / you / app password |
   | `SITE_URL` | optional | `https://yoursite.com` (instead of committing qa.config.json) |
   | AI keys | optional | see [Choose your AI](#choose-your-ai) |

4. Open the **Actions** tab and enable workflows (forks start with them turned off).
5. Whenever you want a report, go to **Actions → Run QA → Run workflow**. You can type a different URL in the box to check another site just once.

The report arrives by email a few minutes later. Each run's full report is also saved as a downloadable artifact on its run page. Timings are measured from GitHub's US servers, so use them to spot trends rather than as what every visitor sees.

## Run it on a schedule (optional)

It never runs by itself unless you add a schedule. Pick whichever matches how you run it.

**On GitHub:** add a `schedule` to the `on:` section of `.github/workflows/qa.yml` and commit:

```yaml
on:
  workflow_dispatch:
    # ...keep what's already here...
  schedule:
    - cron: '30 23 * * 0-4'   # 07:30 Manila time (UTC+8), Monday–Friday
```

GitHub cron times are always **UTC**, so convert from your timezone first. [crontab.guru](https://crontab.guru) helps you build the line. Runs can start 5–30 minutes late when GitHub is busy. On public repos, GitHub pauses schedules after 60 days with no commits; re-enable them from the Actions tab.

**On your computer** (the computer has to be on at that time):

```bash
# macOS / Linux: run `crontab -e` and add (local time, 07:30 Mon–Fri):
30 7 * * 1-5  cd /path/to/warden && npm run qa

# Windows (Command Prompt), 07:30 every day:
schtasks /create /tn "warden" /sc daily /st 07:30 /tr "cmd /c cd /d C:\path\to\warden && npm run qa"
```

---

## How it works

```
 sitemap.xml + crawl ──► headless Chrome loads each page ──► checks ──► report ──► (AI summary) ──► browser view / email
                          (Playwright)                         │
                                                               ├─ links:  HEAD/GET every unique URL
                                                               ├─ meta:   reads the page's <head>
                                                               ├─ speed:  browser Performance API
                                                               └─ forms:  fill + submit in a real browser
```

The scanning itself is plain, predictable code, so every run works the same way. The AI only writes the summary: it reads the findings and explains what matters most. Leave the AI out and everything else still works.

Each run compares with the previous scan of the same site, so issues are marked **NEW** and you can see what got **fixed**. Scanning one site never resets another site's history.

---

## Configuration (`qa.config.json`)

Optional. Copy `qa.config.example.json` to `qa.config.json` to set form tests, speed limits and more.

```jsonc
{
  "sites": [
    {
      "url": "https://example.com",
      "maxPages": 50,                 // crawl limit per site
      "forms": [ /* see below */ ]
    }
  ],
  "thresholds": { "loadMs": 3000, "lcpMs": 2500, "pageWeightKb": 3000 },
  "checkExternalLinks": true,
  "exclude": ["/wp-admin", "mailto:", "tel:"],   // any URL containing these is skipped
  "ai": { "provider": "anthropic", "model": "claude-opus-5-5" }   // optional; keys never go here
}
```

A threshold that's exceeded is a **warning**, and one exceeded by more than 2× is **critical**. With several sites listed, `npm run qa` checks them all and sends one email. When you scan a URL from the browser page, the form tests and limits for that site are used automatically.

### Testing forms

Submitting a form on a live site creates real enquiries, so each form needs an explicit entry and you choose how it's tested:

```jsonc
{
  "page": "/contact",
  "selector": "form#contact",
  "mode": "intercept",              // or "submit"
  "fields": { "#email": "qa-test@example.com", "#message": "Automated QA test", "#agree": true },
  "expectEndpoint": "/api/contact", // optional: intercept mode checks the request goes here
  "successText": "Thanks",          // submit mode: text that appears on success
  "successSelector": ".alert-success", // submit mode: or an element that appears
  "submitSelector": "button.send",  // optional, if the submit button is unusual
  "timeoutMs": 15000
}
```

| Mode | What happens | Passes when |
|---|---|---|
| `intercept` (default, safe) | Fills in the form, clicks submit, then **catches and cancels** the outgoing request, so nothing is delivered | the browser actually sends the request. It catches broken JS, validation that blocks submitting, and wrong endpoints |
| `submit` | Really submits test data | `successText` / `successSelector` appears, and the server didn't answer with an error |

Use `submit` when you also want to know the server side works, for example to spot a contact form returning 500. Use obvious test values so the messages are easy to filter out. Forms the crawl finds that you haven't configured are listed under "Found but not tested".

---

## Choose your AI

The AI summary is optional and works with whichever provider you pick. Set `AI_PROVIDER` plus a key in `.env`, or as secrets on GitHub:

| `AI_PROVIDER` | Key | `AI_MODEL` | Notes |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | optional (default `claude-opus-5-5`) | Claude |
| `openai` | `OPENAI_API_KEY` | required | OpenAI Chat Completions |
| `gemini` | `GEMINI_API_KEY` | required | Google Gemini |
| `openai-compatible` | `AI_API_KEY` (if the server needs one) | required | Set `AI_BASE_URL`. Works with **Ollama** (`http://localhost:11434/v1`), LM Studio, OpenRouter, Groq, Together, … |
| `./path/to/file.js` | whatever your adapter needs | your choice | Your own adapter, see below |
| `none` | | | Turn the summary off |

- If `AI_PROVIDER` is empty, it's picked from whichever of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY` is set.
- `AI_API_KEY` works for any provider and overrides the vendor-specific key.
- In GitHub you can set `AI_PROVIDER`, `AI_MODEL` and `AI_BASE_URL` as **variables** rather than secrets, since they aren't sensitive.
- If the AI call fails (bad key, outage, rate limit), you still get the report without the summary, and the error appears in the log.

### Edit what the AI says

The instructions the AI follows are in [`prompts/summary.md`](prompts/summary.md). Edit that file directly, or point `AI_PROMPT_FILE` at your own. Ideas: write for a non-technical client, reply in another language, or focus only on SEO.

### Bring your own AI

Create a file that exports one function, and set `AI_PROVIDER=./my-provider.js`:

```js
// my-provider.js
export const defaultModel = 'my-model';   // optional

export async function complete({ system, prompt, model, apiKey, baseUrl, maxTokens }) {
  // system = contents of prompts/summary.md
  // prompt = this run's findings as JSON
  const res = await fetch('https://my-llm.example.com/generate', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, system, input: prompt, max_tokens: maxTokens }),
  });
  return (await res.json()).text;          // return plain text
}
```

The built-in adapters in [`src/ai/providers/`](src/ai/providers/) are short and make good starting points.

---

## Email setup (optional)

Without email, reports are still saved in `reports/` and shown in the browser page. To have them emailed, copy `.env.example` to `.env` and pick one:

**Resend** (easiest): sign up at [resend.com](https://resend.com), verify your domain, create an API key, and set `EMAIL_PROVIDER=resend` and `RESEND_API_KEY`. `EMAIL_FROM` must use the domain you verified.

**SMTP** (any mail provider): set `EMAIL_PROVIDER=smtp` and the `SMTP_*` values. For Gmail, turn on 2-step verification, create an [App Password](https://myaccount.google.com/apppasswords), and use `smtp.gmail.com`, port `465`, your address and the app password.

The email body shows up to 25 rows per section, and the complete report is attached as an HTML file.

## Command-line options

```
npm run serve -- [url] [options]    local web page at http://localhost:4173
npm run qa -- [url] [options]       one-off run in the terminal

  url               site to check (instead of the sites in qa.config.json)
  --config <file>   config file (default: qa.config.json)
  --no-email        write the report but don't email it
  --no-ai           skip the AI summary
  --out <dir>       report folder (default: reports)
  --strict          exit with code 1 when critical issues are found (fails the GitHub run)
  --port <n>        port for serve (default: 4173)
```

## Development

```bash
npm test     # runs every check and the web server against the bundled demo site; no network or API keys needed
```

| Path | What it does |
|---|---|
| `src/cli.js` | Command line: `qa` and `serve` |
| `src/run.js` | One full scan: crawl, checks, report, AI summary, email. Shared by the CLI and the server |
| `src/server.js` | The local web server and its API (start a scan, live progress, serve reports) |
| `src/web/index.html` | The browser page: scan form, progress and the results view |
| `src/crawler.js` | Finds pages (sitemap + links) and collects page data in headless Chrome |
| `src/checks/*` | One file per check: links, meta, performance, forms |
| `src/report/*` | Builds the report, tracks new/fixed, renders the email/HTML version |
| `src/ai/*` | The AI summary and the provider adapters |
| `src/email/send.js` | Resend and SMTP |

## License

MIT
