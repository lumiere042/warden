import pages from './pages.js';
import links from './links.js';
import forms from './forms-check.js';
import performance from './performance.js';
import meta from './meta.js';
import accessibility from './accessibility.js';
import security from './security.js';

/**
 * Every check Warden runs, in order. The order is also the order of the report sections.
 *
 * To add a check, create src/checks/<name>.js and add it here. A check default-exports:
 *
 *   export default {
 *     name: 'links',          // unique id; becomes issue.check and the key in report.sites[].checks
 *     title: 'Broken links',  // section heading in the reports
 *
 *     // Optional. Runs on the live Playwright page while crawling, after the DOM is collected
 *     // (HTML pages only, each page in its own context). Save what run() needs in
 *     // result.data[name]. Keep it quick, and catch your own errors.
 *     async collect({ page, response, result, site, config }) {},
 *
 *     // Required. Runs once per site after the crawl.
 *     //   browser   Playwright browser (use newContext() from ../browser.js for new pages)
 *     //   pages     crawled page results: { url, finalUrl, status, error, isHtml, source,
 *     //             links, forms, meta, perf, consoleErrors, data }
 *     //   site      the site's config entry; config: the whole config
 *     //   previous  the last run's saved issues (last.json) or null
 *     //   log       progress logger; signal: AbortSignal, stop early when signal.aborted
 *     async run({ browser, pages, site, config, previous, log, signal }) {
 *       return { checked, issues, summary }; // summary and any other fields are optional
 *     },
 *   };
 *
 * Each issue: { check, severity: 'critical' | 'warning', key, page, message, detail?, siteWide? }
 *   key       stable id of the problem on that page, used to mark issues NEW / FIXED between runs
 *   siteWide  true when the issue isn't tied to one page (key alone identifies it, e.g. a broken URL
 *             found on many pages); put the affected pages in detail.pages to have them listed
 */
export const CHECKS = [pages, links, forms, performance, meta, accessibility, security];
