


https://github.com/user-attachments/assets/9057fd67-e463-4cc5-8122-cc8eaf1e2a4e

# Warden

Automated QA for any website. Paste a link and Warden crawls the site in a real browser, then shows you what's broken: dead pages and links, forms that don't send, slow pages, SEO gaps, accessibility problems and HTTPS mistakes. An AI summary from **the AI of your choice** (Claude, OpenAI, Gemini, a local model, or your own adapter) can tell you what to fix first.

**No server or account needed.** It runs on your own computer, in Docker, or free on GitHub Actions, and only when you start it.

## What it checks

| Check | What it finds |
|---|---|
| **Pages** | The site being down, pages that fail but nothing links to (for example ones only listed in `sitemap.xml`), and JavaScript errors, grouped by message across pages |
| **Broken links** | Internal pages, images, scripts, stylesheets and (optionally) external links. Internal links that redirect, or go through a redirect chain, are flagged so you can point them at the final URL. Requests to each host are rate-limited, and a `429 Too Many Requests` is retried once |
| **Forms** | Fills in your forms and checks they really send, without spamming your inbox. Analytics beacons and chat widgets that fire on click are no longer mistaken for the form's submission |
| **Speed** | Load time, Largest Contentful Paint, layout shift (CLS) and page weight against limits you set. A small margin stops pages that hover around a limit from flipping between NEW and FIXED every run |
| **Meta & SEO** | Title, description, viewport, `lang`, H1s, Open Graph, accidental `noindex`, duplicate titles and descriptions, canonical links that are invalid, broken or point elsewhere, images without `alt`, `hreflang` mistakes, and a missing favicon |
| **Accessibility** | An [axe-core](https://github.com/dequelabs/axe-core) audit of every page against WCAG 2 A and AA, grouped by rule so one problem in your footer is one issue, not fifty |
| **Security & HTTPS** | Missing security headers (HSTS, CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`), mixed content, `http://` not redirecting to `https://`, and TLS certificates that are expired, untrusted or about to expire |
| **Visual changes** (optional) | Screenshots of your pages compared with an earlier baseline, so you notice when something looks different. See [Visual changes](#visual-changes-optional) |

Each problem is **critical** or a **warning**, and is marked **NEW** or **FIXED** compared with your last scan of that site.

---

## Three ways to run it

| | Command | You get |
|---|---|---|
| **In your browser** (easiest) | `npm run serve` | A local page at `http://localhost:4173`: paste any URL, watch it scan, read the results by category |
| **In the terminal** | `npm run qa -- example.com` | A one-off run; the report is saved to `reports/` and optionally emailed or posted to chat |
| **On GitHub** | Actions → **Run QA** | Runs on GitHub's servers and emails you the report; no computer needed |

You can also [install it as a command](#install-it-as-a-command) or [run it in Docker](#run-it-in-docker).

## Quick start

Requires Node.js 20+.

```bash
git clone https://github.com/lumiere042/warden.git
cd warden
npm install
npx playwright install chromium

npm run serve        # open http://localhost:4173 and paste a URL
```

That's it: no keys or config needed to start. Add `.env` (email, AI, chat) and `qa.config.json` (form tests, limits) later if you want them.

## Install it as a command

The npm name `warden` belongs to an unrelated package, so Warden isn't published to npm yet. Install it straight from GitHub instead:

```bash
npm install -g github:lumiere042/warden
npx playwright install chromium      # the browser Warden drives

warden --version
warden example.com --no-email        # one-off run
warden --serve                       # the browser page
```

Or run it once without installing: `npx github:lumiere042/warden example.com --no-email`.

The command reads `qa.config.json` and `.env` from the folder you run it in, and saves reports to `reports/` there.

---

## Check a site from your browser

```bash
npm run serve                     # open http://localhost:4173 and paste a URL
npm run serve -- example.com      # or start scanning right away; open the link to watch
```

You get live progress while it crawls (pages found, current page, a progress bar) and a **Cancel** button to stop a scan early. Then the results appear on the same page, one category at a time:

| Tab | What's in it |
|---|---|
| **Overview** | Counts (critical, warnings, new, fixed, pages, links checked), the AI summary if you've set one up, the top problems in each category, and how many issues your [ignore list](#ignoring-known-issues) hid |
| **Pages** | Site down, failing pages nothing links to, and JavaScript errors |
| **Broken links** | Every broken link, asset or redirect with its status code and the pages it's on. Search it, filter by broken / warnings / new only, 25 per page |
| **Forms** | Each tested form as PASS or FAIL with the reason, plus forms found on the site that aren't set up for testing yet |
| **Speed** | Average load, LCP, CLS and page weight against your limits, and one row per slow page |
| **Meta & SEO** | Grouped by problem, for example "Missing meta description · 30 pages", with a note on why it matters. Click a group to see the pages |
| **Accessibility** | One entry per failing axe rule, with how many elements and pages it affects |
| **Security & HTTPS** | Missing headers, mixed content, the http → https redirect and the certificate |
| **Visual changes** | Only when turned on: baseline, current and diff screenshots for each page that changed |
| **Fixed** | What disappeared since your last scan of that site |

Past scans are listed under **Recent reports**; click one to open it in the same view. **History** (above a report) and **Site history** (under Recent reports) show trend charts across runs, see [Site history](#site-history).

Good to know:

- Type `example.com` and it becomes `https://example.com`; `localhost:3000` becomes `http://`, so local dev servers work too.
- Email is off here by default. Tick **Also email me** if you've set up email in `.env`. **AI summary** is available once an AI key is set. Chat notifications are only sent from terminal and GitHub runs.
- It runs one scan at a time, and `--port 5000` picks a different port.
- It only listens on your own machine (`127.0.0.1`), and only accepts requests from its own page at `localhost`. Other websites open in your browser can't start scans or read your reports. Use `--host 0.0.0.0` only inside Docker (see [Run it in Docker](#run-it-in-docker)).

### Where your results are saved

Every scan, from the browser or the terminal, is saved in the `reports/` folder:

```
reports/
  2026-10-28_0820_example.com.html   ← the full report; opens in any browser, even with Warden stopped
  2026-10-28_0820_example.com.json   ← the same results as data (this is what the browser view reads)
  last.json                          ← what Warden remembers, to mark issues NEW / FIXED next time
  screenshots/example.com/           ← baseline/, current/ and diff/ images, only with the visual check on
```

Each scan gets its own files, named by date, time (UTC) and site. With `--format`, a `.sarif`, `.junit.xml` and/or `.md` file is written next to them. `reports/` is in `.gitignore`, so results never get pushed. Use `--out <folder>` to save them somewhere else. Nothing is emailed unless you set up email.

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
   | `EMAIL_PROVIDER` | for email | `resend` or `smtp` |
   | `EMAIL_FROM` | for email | `QA Bot <qa@yourdomain.com>` |
   | `EMAIL_TO` | for email | `you@yourdomain.com,team@yourdomain.com` |
   | `RESEND_API_KEY` | if using Resend | `re_...` |
   | `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | if using SMTP | `smtp.gmail.com` / `465` / you / app password |
   | `SITE_URL` | optional | `https://yoursite.com` (instead of committing qa.config.json) |
   | `SLACK_WEBHOOK_URL` / `DISCORD_WEBHOOK_URL` / `TEAMS_WEBHOOK_URL` / `WEBHOOK_URL` | optional | see [Chat notifications](#chat-notifications) |
   | AI keys | optional | see [Choose your AI](#choose-your-ai) |

4. Open the **Actions** tab and enable workflows (forks start with them turned off).
5. Whenever you want a report, go to **Actions → Run QA → Run workflow**. You can type a different URL in the box to check another site just once.

The report arrives by email a few minutes later. Each run's full report is also saved as a downloadable artifact on its run page. Timings are measured from GitHub's US servers, so use them to spot trends rather than as what every visitor sees.

### CI outputs

The workflow runs `node src/cli.js --format sarif,junit`, so each run also produces:

- **A job summary** on the run page: counts per check and the critical issues. This is written automatically whenever Warden runs in GitHub Actions.
- **SARIF and JUnit files** in the report artifact, for tools that read them. `--format markdown` adds the summary as a `.md` file too.
- **Code scanning alerts (optional):** add the repository **variable** `UPLOAD_SARIF` = `true` (Settings → Secrets and variables → Actions → Variables) and issues show up under **Security → Code scanning**. Code scanning must be available for the repo (it is on public repos).

Add `--strict` to the command to fail the run when critical issues are found.

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

## Run it in Docker

The image is built on the official Playwright image, so Node and Chromium are included. Your config, `.env` and `reports/` come from the folder you mount.

```bash
docker build -t warden .

# One-off run
docker run --rm -v "$PWD:/work" -w /work warden https://example.com --no-email
docker run --rm --env-file .env -v "$PWD:/work" -w /work warden        # uses ./qa.config.json

# The browser page: open http://localhost:4173
docker run --rm -p 4173:4173 -v "$PWD:/work" -w /work warden --serve --host 0.0.0.0
```

- `--host 0.0.0.0` is needed so the page is reachable from outside the container. Open it as `http://localhost:4173`; other addresses are refused. To keep it off your network, publish it as `-p 127.0.0.1:4173:4173`.
- The container runs as root, so on Linux the report files it writes are owned by root. Add `--user "$(id -u):$(id -g)"` to `docker run` to have them owned by you.

---

## How it works

```
 sitemap.xml + crawl ──► headless Chrome loads each page ──► checks ──► report ──► (AI summary) ──► browser view / email / chat / CI files
                          (Playwright)                         │
                                                               ├─ pages:          failed pages and JavaScript errors from the crawl
                                                               ├─ links:          HEAD/GET every unique URL, following redirects
                                                               ├─ forms:          fill + submit in a real browser
                                                               ├─ speed:          browser Performance API
                                                               ├─ meta & SEO:     reads the page's <head>, images and favicon
                                                               ├─ accessibility:  axe-core inside each page
                                                               ├─ security:       response headers, mixed content, http redirect, TLS
                                                               └─ visual:         screenshots compared with a baseline (optional)
```

The scanning itself is plain, predictable code, so every run works the same way. The AI only writes the summary: it reads the findings and explains what matters most. Leave the AI out and everything else still works.

Each run compares with the previous scan of the same site, so issues are marked **NEW** and you can see what got **fixed**. Scanning one site never resets another site's history.

## Visual changes (optional)

Warden can screenshot your pages and tell you when they look different from before, for example a broken stylesheet, a missing banner or a layout that slipped. It's off by default. Turn it on in `qa.config.json`:

```jsonc
"visual": { "enabled": true }
```

- **First run:** the screenshots become the **baseline**, saved in `reports/screenshots/<host>/baseline/`.
- **Later runs:** new screenshots go in `current/` and are compared with the baseline. When more than `maxDiffPct` of a page changed, you get a warning like "4.2% of the page changed since the baseline", plus an image in `diff/` with the changes highlighted. A page whose size changed is flagged too.
- **Accepting a change:** a change stays listed until you accept it. Run once from the terminal with `--update-baseline`, and the current screenshots become the new baseline.

In the browser page, the **Visual changes** tab shows the baseline, current and diff screenshots side by side.

| Option | Default | What it does |
|---|---|---|
| `visual.enabled` | `false` | Turn the check on |
| `visual.maxPages` | `10` | Pages to screenshot per site (the first ones crawled) |
| `visual.fullPage` | `false` | Capture the whole page instead of the first screen |
| `visual.threshold` | `0.1` | How different a pixel must be to count as changed (0 to 1; higher ignores small color shifts) |
| `visual.maxDiffPct` | `1` | Warn when more than this % of the page changed |
| `visual.viewport` | `{ "width": 1280, "height": 800 }` | Window size for the screenshots. With `device` set, the phone's screen size is used instead |
| `visual.updateBaseline` | `false` | Accept the current screenshots as the new baseline. Left on, it accepts every change every run, so prefer `--update-baseline` for one run |

Dynamic content such as carousels, ads, dates and cookie banners will show up as changes. Raise `maxDiffPct`, or use [`ignore`](#ignoring-known-issues) for pages that always change.

## Site history

Every report Warden saves becomes part of that site's history. Click **History** above a report, or **Site history** under Recent reports, to see:

- a chart of **critical issues and warnings** per run,
- a chart of **average load time and LCP** per run,
- a table of every run (critical, warnings, new, fixed, pages) with a link to its report.

History is built from the saved `.json` reports in `reports/`, so deleting them deletes the history. On GitHub each run starts fresh and only `last.json` is carried over (for NEW / FIXED), so there's no history or visual baseline there unless you keep the `reports/` folder between runs yourself.

---

## Configuration (`qa.config.json`)

Optional. Copy `qa.config.example.json` to `qa.config.json` to set form tests, speed limits and more.

```jsonc
{
  "sites": [
    {
      "url": "https://example.com",
      "maxPages": 50,                 // crawl limit for this site
      "forms": [ /* see below */ ]
    }
  ],
  "thresholds": { "loadMs": 3000, "lcpMs": 2500, "pageWeightKb": 3000, "clsScore": 0.1 },
  "checkExternalLinks": true,
  "exclude": ["/wp-admin"],           // any URL containing these is skipped
  "ai": { "provider": "anthropic", "model": "claude-opus-5-5" }   // optional; keys never go here
}
```

With several sites listed, `npm run qa` checks them all and sends one report. When you scan a URL from the browser page or with `--site`, the form tests for that site are used automatically.

Every option, with its default:

| Option | Default | What it does |
|---|---|---|
| `sites` | | List of `{ url, maxPages?, forms? }` to check. Not needed when you pass a URL or set `SITE_URL` |
| `maxPages` | `50` | Pages to crawl per site (a site's own `maxPages` wins) |
| `pageConcurrency` | `3` | Pages loaded in the browser at once |
| `pageTimeoutMs` | `30000` | Time limit for loading one page in the browser |
| `concurrency` | `8` | Link checks in flight at once |
| `linkHostConcurrency` | `2` | Link checks in flight to any one host, so you don't hammer a server |
| `timeoutMs` | `10000` | Time limit for each link check and sitemap fetch |
| `thresholds.loadMs` | `3000` | Page load time limit |
| `thresholds.lcpMs` | `2500` | Largest Contentful Paint limit |
| `thresholds.pageWeightKb` | `3000` | Page weight limit (everything the page downloads) |
| `thresholds.clsScore` | `0.1` | Layout shift (CLS) limit |
| `thresholds.marginPct` | `10` | A page that was fine last run must go this % over a limit before it's flagged. Stops timing noise flipping pages between NEW and FIXED |
| `checkExternalLinks` | `true` | Also check links to other sites |
| `exclude` | `["mailto:", "tel:", "javascript:"]` | URLs containing any of these are skipped. Yours are added to the defaults |
| `device` | `null` | Run as a phone, see [Mobile run](#mobile-run) |
| `auth` | `{}` | Log in to staging or members-only sites, see [Password-protected and staging sites](#password-protected-and-staging-sites) |
| `accessibility` | `{ "enabled": true, "tags": ["wcag2a", "wcag2aa"], "disableRules": [] }` | `tags` picks the axe-core rule sets (for example add `"wcag21aa"`); `disableRules` skips rules by id |
| `security` | `{ "enabled": true, "headers": true, "certWarnDays": 21 }` | `headers: false` skips the header checks; `certWarnDays` is how early to warn about certificate expiry |
| `ignore` | `[]` | Known issues to leave out, see [Ignoring known issues](#ignoring-known-issues) |
| `notify` | `{ "onlyOnIssues": false }` | `true` posts to chat only when something is critical or new, see [Chat notifications](#chat-notifications) |
| `formats` | `[]` | Extra report files to write every run, e.g. `["sarif", "junit", "markdown"]` (same as `--format`) |
| `visual` | `{ "enabled": false, ... }` | Screenshot comparison between runs, see [Visual changes](#visual-changes-optional) |
| `ai` | | `provider`, `model`, `baseUrl`, `promptFile`, `maxTokens` (default `16000`). Environment variables win, and keys never go here. See [Choose your AI](#choose-your-ai) |
| `userAgent` | `warden-qa-bot/0.1 (+https://github.com/lumiere042/warden)` | How Warden identifies itself to your server |

A speed limit that's exceeded is a **warning**, and one exceeded by more than 2× is **critical**.

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

### Ignoring known issues

Some warnings you already know about and have decided to live with. Add them to `ignore` and they're left out of the report, the counts and the emails (the report still says how many were ignored):

```jsonc
"ignore": [
  { "check": "meta", "key": "open-graph", "reason": "We don't share pages on social media" },
  { "check": "links", "key": "linkedin.com", "reason": "LinkedIn blocks bots" },
  { "check": "security", "key": "header:content-security-policy" },
  { "page": "/old-blog/", "reason": "Being removed next month" }
]
```

A rule matches when everything it gives matches: `check` exactly (`pages`, `links`, `forms`, `performance`, `meta`, `accessibility`, `security` or `visual`), and `key`, `page` and `match` (the message) as part of the text. Each rule needs at least one of those four. `reason` is a note for you. You can find an issue's `check` and `key` in the report's `.json` file.

### Password-protected and staging sites

Warden can get past a login or a staging password, so you can check a site before it goes live:

| What you have | How to set it |
|---|---|
| HTTP basic auth (the browser's own password box) | Set `AUTH_USERNAME` and `AUTH_PASSWORD` in `.env`. Passwords never go in the config file |
| A login page | Log in once and save the session: `npx playwright codegen --save-storage=auth.json https://staging.example.com`, then set `"auth": { "storageState": "auth.json" }`. Keep that file out of git |
| A token or header | `"auth": { "headers": { "Authorization": "Bearer ${STAGING_TOKEN}" } }`. `${NAME}` is filled in from the environment, so the token stays in `.env` |
| A cookie, e.g. a preview flag | `"auth": { "cookies": [{ "name": "preview", "value": "1", "url": "https://staging.example.com" }] }`. Each cookie needs a `url`, or a `domain` and `path` |

Link checks and sitemap fetches also send the basic-auth login and `auth.headers`, but only to the sites being checked, never to external links. On GitHub, add `AUTH_USERNAME`, `AUTH_PASSWORD` or your token as secrets and pass them in the `env:` of the **Run QA** step in `.github/workflows/qa.yml`.

### Mobile run

Set `"device"` to any [Playwright device name](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/deviceDescriptorsSource.json), such as `"Pixel 7"` or `"iPhone 15"`, and the whole scan runs with that phone's screen size, touch and user agent. Sites that serve a different mobile version get checked as phones see them. An unknown name stops the run with an error before anything is crawled.

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
- `AI_API_KEY` works for any provider and overrides the vendor-specific key. `AI_MAX_TOKENS` caps the reply length (default `16000`).
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

## Chat notifications

Get a short message in chat after each terminal or GitHub run: counts per site, the top critical issues, a link to the report and the AI summary. Set any of these in `.env` (or as GitHub secrets); each one is used only when it's set:

| Variable | Where it posts |
|---|---|
| `SLACK_WEBHOOK_URL` | A Slack [incoming webhook](https://api.slack.com/messaging/webhooks) |
| `DISCORD_WEBHOOK_URL` | A Discord channel webhook |
| `TEAMS_WEBHOOK_URL` | A Microsoft Teams "Workflows" webhook (sent as an Adaptive Card) |
| `WEBHOOK_URL` | Any endpoint: a JSON POST with the subject, per-site counts, top critical issues and the AI summary |

- `REPORT_URL_BASE` sets the report link: the report's file name is added to the end, or replaces `{file}` if you include it (e.g. `https://qa.example.com/reports/`). On GitHub it defaults to the run page, where the report artifact is.
- `"notify": { "onlyOnIssues": true }` in `qa.config.json` keeps chat quiet unless something is critical or new.
- `--no-notify` skips chat for one run. A webhook that fails is logged and never fails the run.

## Command-line options

```
npm run qa -- [url] [options]       run once, save the report (and email it)
npm run serve -- [url] [options]    open the local web page; paste a URL there to scan
warden [url] [options]              same, when installed with npm i -g (or via npx)
```

| Option | What it does |
|---|---|
| `url` | Site to check (overrides the sites in the config) |
| `--config <file>` | Config file (default: `qa.config.json`) |
| `--site <url>` | Same as giving a url |
| `--no-email` | Write the report but don't email it |
| `--no-ai` | Skip the AI summary |
| `--no-notify` | Don't post to the Slack / Discord / Teams / webhook URLs set in env |
| `--format <list>` | Also write `sarif`, `junit` and/or `markdown` files, e.g. `--format sarif,junit` |
| `--out <dir>` | Where reports are written (default: `reports`) |
| `--strict` | Exit with code 1 when critical issues are found (fails a CI run) |
| `--update-baseline` | Accept the current screenshots as the new [visual](#visual-changes-optional) baseline |
| `--serve` | Start the local web page instead of a one-off run |
| `--port <n>` | Port for `--serve` (default: `4173`, or `PORT` from the environment) |
| `--host <addr>` | Address `--serve` listens on (default: `127.0.0.1`; use `0.0.0.0` in Docker) |
| `-v`, `--version` | Print the version |
| `-h`, `--help` | Show the help |

## Writing your own check

Each check is one file in [`src/checks/`](src/checks/), listed in [`src/checks/index.js`](src/checks/index.js). To add one, create `src/checks/<name>.js` and add it to the `CHECKS` list there. The list order is also the order of the report sections.

```js
export default {
  name: 'my-check',        // unique id; becomes issue.check
  title: 'My check',       // section heading in the reports

  // Optional: return false to skip the check for this run (no collect, no run, no report section).
  enabled: (config) => Boolean(config.myCheck?.enabled),

  // Optional: runs on the live Playwright page while crawling. Save what run() needs in result.data[name].
  async collect({ page, response, result, site, config, outDir }) {},

  // Required: runs once per site after the crawl.
  async run({ browser, pages, site, config, previous, log, signal, outDir }) {
    return { checked: pages.length, issues: [] };
  },
};
```

`outDir` is the reports folder, for checks that keep files between runs (the visual check stores its screenshots there).

Each issue looks like `{ check, severity: 'critical' | 'warning', key, page, message, detail?, siteWide? }`. `key` must stay the same between runs for the same problem, since it's how Warden marks issues NEW and FIXED. The comment at the top of `src/checks/index.js` explains every field, and the built-in checks are good examples.

## Development

```bash
npm test     # runs every check, the outputs and the web server against the bundled demo site; no network or API keys needed
```

The demo site lives in `test/fixture-site/` and has deliberate bugs of every kind. Run it with `npm run fixture` (on `http://localhost:4000`) to try changes by hand.

| Path | What it does |
|---|---|
| `src/cli.js` | Command line: one-off runs and `--serve` |
| `src/run.js` | One full scan: crawl, checks, report, AI summary, email, chat. Shared by the CLI and the server |
| `src/server.js` | The local web server and its API (start or cancel a scan, live progress, history, serve reports and screenshots) |
| `src/web/index.html` | The browser page: scan form, progress and the results view |
| `src/crawler.js` | Finds pages (sitemap + links) and collects page data in headless Chrome |
| `src/browser.js` | Browser setup shared by every check: device, auth, user agent |
| `src/checks/*` | One file per check: pages, links, forms, performance, meta, accessibility, security, visual |
| `src/report/*` | Builds the report, tracks new/fixed, reads the run history, renders the HTML version and the SARIF / JUnit / Markdown files |
| `src/notify/webhooks.js` | Slack, Discord, Teams and generic webhooks |
| `src/ai/*` | The AI summary and the provider adapters |
| `src/email/send.js` | Resend and SMTP |
| `Dockerfile` | The container image |

## License

MIT
