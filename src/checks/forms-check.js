import { checkForms } from './forms.js';

// Plugin wrapper around forms.js. Besides { checked, issues } the result has
// `results` (one per configured form test) and `untested` (forms found but not configured).
export default {
  name: 'forms',
  title: 'Forms',
  run: ({ browser, pages, site, config }) => checkForms(browser, pages, site, config),
};
