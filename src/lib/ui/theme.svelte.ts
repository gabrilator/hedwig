/** Light or dark. Follows the system until someone picks one; the pick is kept per browser and applied before paint (app.html). */
const KEY = 'hedwig-theme';
export const theme = $state({ light: false, known: false });

export function readTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  theme.light = t ? t === 'light' : matchMedia('(prefers-color-scheme: light)').matches;
  theme.known = true;
}

export function toggleTheme() {
  const next = theme.light ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(KEY, next); } catch { /* private window: the choice lasts this page only */ }
  theme.light = next === 'light';
}
