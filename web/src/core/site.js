// Pages of the tabora.app site in the language of the interface (the site has the same four languages).
import { language } from "./i18n.js";

const SITE_LANGS = ["ru", "en", "uk", "es"];

export function sitePage(slug) {
  const lang = SITE_LANGS.includes(language()) ? language() : "en";
  return `https://tabora.app/${lang}/${slug}/`;
}
