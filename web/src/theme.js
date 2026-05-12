// Light/dark theme toggle. Persisted in localStorage and applied via the
// data-theme attribute on <html>, which CSS variables key off of.

const STORAGE_KEY = 'relight.theme';

export function initTheme(state) {
  const stored = localStorage.getItem(STORAGE_KEY);
  state.theme = stored === 'light' ? 'light' : 'dark';
  applyTheme(state.theme);

  const sw = document.getElementById('theme-switch');
  sw.checked = state.theme === 'light';
  sw.addEventListener('change', () => {
    state.theme = sw.checked ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEY, state.theme);
    applyTheme(state.theme);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}
