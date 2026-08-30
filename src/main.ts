import { el } from './dom';
import { initTheme, renderThemeList } from './theme';
import { initCamera, stopCamera, resetCameraUI } from './camera';
import { initGallery, renderGallery } from './gallery';
import { initMap, renderMap, renderMapPicker } from './map';
import { initTrail, resetTrailSetup, resetTrailActive } from './trail';
import { getAllPhotos } from './db';

type ScreenName = 'home' | 'camera' | 'gallery' | 'map-picker' | 'map' | 'theme' | 'trail-setup' | 'trail-active';

const screenEls: Record<ScreenName, HTMLElement> = {
  home: el('screen-home'),
  camera: el('screen-camera'),
  gallery: el('screen-gallery'),
  'map-picker': el('screen-map-picker'),
  map: el('screen-map'),
  theme: el('screen-theme'),
  'trail-setup': el('screen-trail-setup'),
  'trail-active': el('screen-trail-active'),
};

async function updateHomeBadge(): Promise<void> {
  const photos = await getAllPhotos();
  const count = photos.length;

  const galleryBadge = el('home-gallery-badge');
  galleryBadge.innerText = count === 1 ? '1 foto' : `${count} fotos`;
  galleryBadge.hidden = count === 0;

  const mapBadge = el('home-map-badge');
  mapBadge.innerText = count === 1 ? '1 ponto' : `${count} pontos`;
  mapBadge.hidden = count === 0;

  const photoLayer = el('home-gallery-photo');
  const galleryCard = el('home-gallery-btn');
  const latest = photos[0];
  if (latest) {
    photoLayer.style.backgroundImage = `url(${latest.dataUrl})`;
    photoLayer.hidden = false;
    galleryCard.classList.add('has-photo');
  } else {
    photoLayer.hidden = true;
    galleryCard.classList.remove('has-photo');
  }
}

function formatGreetingDate(): string {
  const str = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function showScreen(name: ScreenName): void {
  (Object.entries(screenEls) as [ScreenName, HTMLElement][]).forEach(([key, node]) => {
    node.classList.toggle('hidden', key !== name);
  });

  if (name === 'camera') {
    resetCameraUI();
  } else {
    stopCamera();
  }

  if (name !== 'trail-active') {
    resetTrailActive();
  }
  if (name === 'trail-setup') {
    resetTrailSetup();
  }

  if (name === 'gallery') renderGallery();
  if (name === 'map-picker') renderMapPicker();
  if (name === 'map') renderMap();
  if (name === 'theme') renderThemeList();
  if (name === 'home') updateHomeBadge();
}

function init(): void {
  initTheme();

  initCamera({
    onBack: () => showScreen('home'),
    onPhotoChange: updateHomeBadge,
  });

  initGallery({ onPhotoChange: updateHomeBadge });
  initMap({ onSelectItem: () => showScreen('map') });

  initTrail({
    onBack: () => showScreen('home'),
    onSaved: updateHomeBadge,
  });

  el('home-camera-btn').addEventListener('click', () => showScreen('camera'));
  el('home-gallery-btn').addEventListener('click', () => showScreen('gallery'));
  el('home-map-btn').addEventListener('click', () => showScreen('map-picker'));
  el('home-theme-btn').addEventListener('click', () => showScreen('theme'));
  el('home-theme-shortcut').addEventListener('click', () => showScreen('theme'));
  el('home-trail-btn').addEventListener('click', () => showScreen('trail-setup'));
  el('gallery-back-btn').addEventListener('click', () => showScreen('home'));
  el('map-picker-back-btn').addEventListener('click', () => showScreen('home'));
  el('map-back-btn').addEventListener('click', () => showScreen('map-picker'));
  el('theme-back-btn').addEventListener('click', () => showScreen('home'));

  el('trail-start-btn').addEventListener('click', () => showScreen('trail-active'));

  el('home-date-text').innerText = formatGreetingDate();

  updateHomeBadge();
  showScreen('home');
}

init();
