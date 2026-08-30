import { el } from './dom';

export interface Theme {
  id: string;
  name: string;
  desc: string;
  accent: string;
  accentDim: string;
  danger: string;
}

export const THEMES: Theme[] = [
  { id: 'amber', name: 'Âmbar', desc: 'Laranja quente, o padrão', accent: '#FFB100', accentDim: 'rgba(255,177,0,0.32)', danger: '#FF4D4F' },
  { id: 'mint', name: 'Menta', desc: 'Verde suave de alta visibilidade', accent: '#2DD4A7', accentDim: 'rgba(45,212,167,0.32)', danger: '#FF4D4F' },
  { id: 'arctic', name: 'Ártico', desc: 'Ciano frio', accent: '#22D3EE', accentDim: 'rgba(34,211,238,0.32)', danger: '#FF4D4F' },
  { id: 'crimson', name: 'Escarlate', desc: 'Vermelho de alerta', accent: '#FF5A6E', accentDim: 'rgba(255,90,110,0.32)', danger: '#FFB100' },
  { id: 'mono', name: 'Mono', desc: 'Preto e branco de alto contraste', accent: '#E5E7EB', accentDim: 'rgba(229,231,235,0.28)', danger: '#FF4D4F' },
];

const STORAGE_KEY = 'geocamera_theme';

export function getSavedThemeId(): string {
  const saved = localStorage.getItem(STORAGE_KEY);
  return THEMES.some((t) => t.id === saved) ? (saved as string) : THEMES[0].id;
}

export function applyTheme(id: string): void {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  const root = document.documentElement.style;
  root.setProperty('--accent', theme.accent);
  root.setProperty('--accent-dim', theme.accentDim);
  root.setProperty('--danger', theme.danger);
  localStorage.setItem(STORAGE_KEY, theme.id);
}

export function initTheme(): void {
  applyTheme(getSavedThemeId());
}

export function themeColor(varName: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value || fallback;
}

export function renderThemeList(): void {
  const container = el('theme-list');
  const current = getSavedThemeId();
  container.innerHTML = '';

  THEMES.forEach((t) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'theme-item' + (t.id === current ? ' active' : '');

    const swatch = document.createElement('span');
    swatch.className = 'theme-swatch';
    swatch.style.background = t.accent;

    const text = document.createElement('span');
    text.className = 'theme-text';
    text.innerHTML = `<span class="theme-name">${t.name}</span><span class="theme-desc">${t.desc}</span>`;

    item.appendChild(swatch);
    item.appendChild(text);

    if (t.id === current) {
      const check = document.createElement('span');
      check.className = 'theme-check';
      check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      item.appendChild(check);
    }

    item.addEventListener('click', () => {
      applyTheme(t.id);
      renderThemeList();
    });

    container.appendChild(item);
  });
}
