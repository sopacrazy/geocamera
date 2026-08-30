import { el } from './dom';
import { getAllPhotos, deletePhoto, type PhotoRecord } from './db';
import { saveFile } from './save-file';

interface InitGalleryOptions {
  onPhotoChange?: () => void;
}

let activePhoto: PhotoRecord | null = null;
let onPhotoChangeCallback: (() => void) | undefined;

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour12: false });
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export async function renderGallery(): Promise<void> {
  const photos = await getAllPhotos();
  const grid = el('gallery-grid');
  const empty = el<HTMLElement>('gallery-empty');
  el('gallery-count').innerText = String(photos.length);
  grid.innerHTML = '';

  if (photos.length === 0) {
    empty.hidden = false;
    grid.hidden = true;
    return;
  }
  empty.hidden = true;
  grid.hidden = false;

  for (const p of photos) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'gallery-tile';
    tile.setAttribute('aria-label', `Foto de ${formatDateTime(p.datetime)}`);

    const img = document.createElement('img');
    img.src = p.dataUrl;
    img.loading = 'lazy';
    img.alt = '';

    const tag = document.createElement('span');
    tag.className = 'gallery-tile-date';
    tag.innerText = formatShortDate(p.datetime);

    tile.appendChild(img);
    tile.appendChild(tag);
    tile.addEventListener('click', () => openLightbox(p));
    grid.appendChild(tile);
  }
}

function openLightbox(photo: PhotoRecord): void {
  activePhoto = photo;
  el<HTMLImageElement>('lightbox-img').src = photo.dataUrl;
  el('lightbox-datetime').innerText = formatDateTime(photo.datetime);
  el('lightbox-coords').innerText = `${photo.lat.toFixed(6)}, ${photo.lon.toFixed(6)}`;
  el('lightbox-address').innerText = photo.address || '--';
  el('lightbox').classList.remove('hidden');
}

function closeLightbox(): void {
  el('lightbox').classList.add('hidden');
  activePhoto = null;
}

export function initGallery({ onPhotoChange }: InitGalleryOptions = {}): void {
  onPhotoChangeCallback = onPhotoChange;

  el('lightbox-close').addEventListener('click', closeLightbox);

  el('lightbox-delete').addEventListener('click', async () => {
    if (!activePhoto || activePhoto.id === undefined) return;
    await deletePhoto(activePhoto.id);
    closeLightbox();
    await renderGallery();
    onPhotoChangeCallback?.();
  });

  el('lightbox-download').addEventListener('click', () => {
    if (!activePhoto) return;
    saveFile(activePhoto.dataUrl, `geocamera_${activePhoto.datetime.replace(/[:.]/g, '-')}.jpg`);
  });
}
