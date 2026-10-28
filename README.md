# website-qa

Automated QA for any website, with the report emailed to you whenever you run it:

- **Broken links**: internal pages, images, scripts, stylesheets and (optionally) external links
- **Missing or weak meta tags**: title, description, canonical, viewport, `lang`, H1s, Open Graph, duplicates, accidental `noindex`
- **Slow pages**: load time, Largest Contentful Paint and page weight, against limits you set
- **Forms that don't submit**: fills in your forms and checks they really send, without spamming your inbox
- **AI summary (optional)**: a plain-English "fix these first" briefing from **the AI of your choice** (Claude, OpenAI, Gemini, a local model, or your own adapter)

**No server needed.** Run it on your own computer, or with one click on GitHub Actions, for free. It runs only when you start it, and you can [add a schedule](#run-it-on-a-schedule-optional) if you want it automatic.

---

## How it works

```
 sitemap.xml + crawl ──► headless Chrome loads each page ──► checks ──► report ──► (AI summary) ──► email
                          (Playwright)                         │
                                                               ├─ links:  HEAD/GET every unique URL
                                                               ├─ meta:   reads the page's <head>
                                                               ├─ speed:  browser Performance API
                                                               └─ forms:  fill + submit in a real browser
```

The scanning itself is plain, predictable code, so every run works the same way. The AI only writes the summary at the top of the email: it reads the findings and explains what matters most. Leave the AI out and everything else still works.

Each run also compares with the previous one, so the email marks issues as **NEW** and lists what got **fixed**.

---

## Quick start (on your computer)

Requires Node.js 20+.

```bash
git clone https://github.com/<you>/website-qa.git
cd website-qa
npm install
npx playwright install chromium

cp .env.example .env                       # email + optional AI keys
cp qa.config.example.json qa.config.json   # your site + forms

npm run qa -- --no-email     # writes reports/<date>.html - open it in a browser
npm run qa                   # same, and emails it
```

To try it without touching a real site, use the bundled demo site, which has deliberate bugs:

```bash
npm run fixture                                                       # terminal 1
npm run qa -- --config test/fixture-site/qa.config.json --no-email    # terminal 2
```

## Run it on GitHub (free, no server)

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
30 7 * * 1-5  cd /path/to/website-qa && npm run qa

# Windows (Command Prompt), 07:30 every day:
schtasks /create /tn "website-qa" /sc daily /st 07:30 /tr "cmd /c cd /d C:\path\to\website-qa && npm run qa"
```

---

## Configuration (`qa.config.json`)

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

You can check several sites at once; they all go into one email. A threshold that's exceeded is a **warning**, and one exceeded by more than 2× is **critical**.

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

Use `submit` when you also want to know the server side works, for example to spot a contact form returning 500. Use obvious test values so the messages are easy to filter out. Forms the crawl finds that you haven't configured are listed in the report under "Forms found but not tested".

---

## Choose your AI

The AI summary is optional and works with whichever provider you pick. Set `AI_PROVIDER` plus a key, as env vars locally or as secrets in GitHub:

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
- If the AI call fails (bad key, outage, rate limit), the email still goes out without the summary, and the error appears in the run log.

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

## Email setup

**Resend** (easiest): sign up at [resend.com](https://resend.com), verify your domain, create an API key, and set `EMAIL_PROVIDER=resend` and `RESEND_API_KEY`. `EMAIL_FROM` must use the domain you verified.

**SMTP** (any mail provider): set `EMAIL_PROVIDER=smtp` and the `SMTP_*` values. For Gmail, turn on 2-step verification, create an [App Password](https://myaccount.google.com/apppasswords), and use `smtp.gmail.com`, port `465`, your address and the app password.

The email body shows up to 25 rows per section. The complete report is attached as an HTML file.

## Command-line options

```
npm run qa -- [options]
  --config <file>   config file (default: qa.config.json)
  --site <url>      check this URL instead of the configured sites
  --no-email        write the report but don't email it
  --no-ai           skip the AI summary
  --out <dir>       report folder (default: reports)
  --strict          exit with code 1 when critical issues are found (fails the GitHub run)
```

## Development

```bash
npm test     # runs every check against the bundled demo site with known bugs; no network or API keys needed
```

Layout: `src/crawler.js` (discovery and page data), `src/checks/*` (one file per check), `src/report/*` (diff and HTML), `src/ai/*` (summary and provider adapters), `src/email/send.js`.

## License

MIT
