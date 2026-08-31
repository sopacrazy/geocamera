import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import html2canvas from 'html2canvas';
import { tileLayerOffline, savetiles, type TileLayerOffline, type ControlSaveTiles } from 'leaflet.offline';
import { el } from './dom';
import { getAllPhotos, getAllTracks, getAllPlots, deletePlot, deleteTrack, type PhotoRecord, type TrackRecord, type PlotRecord } from './db';
import { saveFile } from './save-file';

const TRACK_COLORS = ['#4A9EFF', '#FF9F4A', '#B26AFF', '#FF4D6A', '#4AD9C0'];
const PLOT_COLORS = ['#D4A017', '#4A9EFF', '#FF6B4A', '#8B5CF6', '#2ECC71', '#FF4D9E'];

// A tile that couldn't be loaded (not cached + offline) renders as this fully
// transparent 1x1 PNG instead of a broken-image icon — the dark map background
// shows through cleanly, and points/lines still render correctly on top.
const BLANK_TILE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const OFFLINE_MAX_ZOOM = 17;
const OFFLINE_MAX_TILES = 3000; // safety cap so nobody accidentally queues up "all of Brazil"

let mapInstance: L.Map | null = null;
let markersLayer: L.LayerGroup | null = null;
let tracksLayer: L.LayerGroup | null = null;
let activeBaseLayer: TileLayerOffline | null = null;
let saveTilesControl: ControlSaveTiles | null = null;
let offlineDownloadInProgress = false;

// Which saved areas/trails are hidden from the map right now — lets someone
// isolate a single item instead of always seeing everything mixed together.
// Session-only: resets to "everything visible" each time the map screen opens.
const hiddenPlotIds = new Set<number>();
const hiddenTrackIds = new Set<number>();

let pendingDelete: { kind: 'plot' | 'track'; id: number; name: string } | null = null;

const EYE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';
const DELETE_BUTTON_HTML = `<button type="button" class="picker-item-delete" aria-label="Excluir">${TRASH_ICON}</button>`;

interface RouteSegment {
  label: string;
  meters: number;
}

type OrderedPhoto = PhotoRecord & { id: number };

interface PlotGroup {
  plot: PlotRecord;
  photos: OrderedPhoto[];
}

function getDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function computePolygonAreaHectares(points: { lat: number; lon: number }[]): number {
  if (points.length < 3) return 0;
  const avgLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const latRad = avgLat * Math.PI / 180;
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos(latRad);

  const xy = points.map((p) => [p.lon * metersPerDegLon, p.lat * metersPerDegLat]);
  let area = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2 / 10000;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour12: false });
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(2)} km`;
}

function numberedIcon(n: number, color: string): L.DivIcon {
  return L.divIcon({
    className: 'map-marker',
    html: `<span style="background:${color}">${n}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -16],
  });
}

async function getPlotGroups(): Promise<PlotGroup[]> {
  const [plots, rawPhotos] = await Promise.all([getAllPlots(), getAllPhotos()]);
  const photos = rawPhotos
    .filter((p): p is OrderedPhoto => typeof p.id === 'number')
    .sort((a, b) => a.id - b.id);

  const groups: PlotGroup[] = [];
  for (const plot of plots) {
    if (plot.id === undefined) continue;
    const plotPhotos = photos.filter((p) => p.plotId === plot.id);
    if (plotPhotos.length > 0) groups.push({ plot, photos: plotPhotos });
  }
  return groups;
}

function computeGroupSegments(photos: OrderedPhoto[]): { segments: RouteSegment[]; total: number } {
  const segments: RouteSegment[] = [];
  let total = 0;

  for (let i = 1; i < photos.length; i++) {
    const meters = getDistanceMeters(photos[i - 1].lat, photos[i - 1].lon, photos[i].lat, photos[i].lon);
    segments.push({ label: `Ponto ${i} → Ponto ${i + 1}`, meters });
    total += meters;
  }

  if (photos.length >= 3) {
    const meters = getDistanceMeters(
      photos[photos.length - 1].lat, photos[photos.length - 1].lon,
      photos[0].lat, photos[0].lon
    );
    segments.push({ label: `Ponto ${photos.length} → Ponto 1 (fechamento)`, meters });
    total += meters;
  }

  return { segments, total };
}

function offlineStatus(text: string, autoHideMs?: number): void {
  const status = el('map-offline-status');
  status.innerText = text;
  status.classList.remove('hidden');
  if (autoHideMs) setTimeout(() => status.classList.add('hidden'), autoHideMs);
}

function wireOfflineEvents(layer: TileLayerOffline): void {
  layer.on('savestart', () => {
    offlineDownloadInProgress = true;
    offlineStatus('Baixando mapa para uso offline…');
  });
  layer.on('savetileend', (e) => {
    const status = e as unknown as { lengthSaved: number; lengthToBeSaved: number };
    offlineStatus(`Baixando mapa… ${status.lengthSaved}/${status.lengthToBeSaved}`);
  });
  layer.on('saveend', () => {
    offlineDownloadInProgress = false;
    offlineStatus('Área salva — funciona sem internet agora ✓', 2500);
  });
}

function ensureMap(): L.Map {
  if (mapInstance) return mapInstance;

  const streets = tileLayerOffline('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    crossOrigin: true,
    errorTileUrl: BLANK_TILE,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
  const satellite = tileLayerOffline('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    // Esri's free imagery isn't captured at full resolution everywhere; past zoom 17 many
    // areas have no tiles at all ("Map data not yet available"). Capping the native zoom
    // makes Leaflet upscale the deepest real tile instead of showing that blank tile.
    maxNativeZoom: 17,
    crossOrigin: true,
    errorTileUrl: BLANK_TILE,
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
  });
  // Google's public tile endpoint — imagery is often more current than Esri's, but it's not
  // the official Maps JavaScript API, so it must stay online-only: no caching, no offline
  // download (a plain L.tileLayer, not the offline-capable tileLayerOffline used above).
  const google = L.tileLayer('https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
    maxZoom: 20,
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
    errorTileUrl: BLANK_TILE,
    attribution: '&copy; Google',
  });

  mapInstance = L.map('map-container', { zoomControl: false, attributionControl: true, layers: [streets] });
  activeBaseLayer = streets;
  L.control.zoom({ position: 'bottomright' }).addTo(mapInstance);
  L.control.layers({ 'Ruas': streets, 'Satélite': satellite, 'Google (só online)': google }, undefined, { position: 'bottomright' }).addTo(mapInstance);

  mapInstance.on('baselayerchange', (e) => {
    if (e.layer === google) {
      // Not offline-capable — downloadCurrentArea() checks for this null and blocks with a toast.
      activeBaseLayer = null;
      offlineStatus('Mapa do Google é só online — não pode ser baixado para uso offline.', 3500);
      return;
    }
    activeBaseLayer = e.layer as TileLayerOffline;
    saveTilesControl?.setLayer(activeBaseLayer);
  });

  wireOfflineEvents(streets);
  wireOfflineEvents(satellite);
  // Mounting (rather than hand-wiring _map) is what makes the control's internal
  // _saveTiles()/_calculateTiles() work — Leaflet only sets Control#_map on addTo().
  // Its default button UI is hidden via CSS (.savetiles.leaflet-bar); we drive
  // the download from our own toolbar icon instead.
  saveTilesControl = savetiles(streets, {
    saveText: '',
    rmText: '',
    maxZoom: OFFLINE_MAX_ZOOM,
    saveWhatYouSee: true,
    confirm: null,
    confirmRemoval: null,
    parallel: 4,
  }).addTo(mapInstance);

  markersLayer = L.layerGroup().addTo(mapInstance);
  tracksLayer = L.layerGroup().addTo(mapInstance);
  return mapInstance;
}

function toggleButtonHtml(kind: 'plot' | 'track', id: number, hidden: boolean): string {
  return `<button type="button" class="map-summary-toggle${hidden ? ' hidden-item' : ''}" data-kind="${kind}" data-id="${id}" aria-label="Mostrar ou ocultar no mapa">${hidden ? EYE_OFF_ICON : EYE_ICON}</button>`;
}

// Restricts the map to a single saved plot/trail so opening "Mapa" never
// dumps every capture on top of each other — the picker screen calls this
// right before switching to the actual map screen.
async function selectSingleMapItem(kind: 'plot' | 'track', id: number): Promise<void> {
  const [groups, tracks] = await Promise.all([getPlotGroups(), getAllTracks()]);
  hiddenPlotIds.clear();
  hiddenTrackIds.clear();
  groups.forEach((g) => {
    if (g.plot.id !== undefined && !(kind === 'plot' && g.plot.id === id)) hiddenPlotIds.add(g.plot.id);
  });
  tracks.forEach((t) => {
    if (t.id !== undefined && !(kind === 'track' && t.id === id)) hiddenTrackIds.add(t.id);
  });
}

function showAllMapItems(): void {
  hiddenPlotIds.clear();
  hiddenTrackIds.clear();
}

export async function renderMapPicker(): Promise<void> {
  const [groups, tracks] = await Promise.all([getPlotGroups(), getAllTracks()]);
  const list = el('map-picker-list');
  const empty = el('map-picker-empty');
  list.innerHTML = '';

  if (groups.length === 0 && tracks.length === 0) {
    list.hidden = true;
    empty.hidden = false;
    return;
  }
  list.hidden = false;
  empty.hidden = true;

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'btn-pill btn-outline picker-all-btn';
  allBtn.innerText = 'Ver tudo junto no mapa';
  allBtn.dataset.action = 'all';
  list.appendChild(allBtn);

  groups.forEach((group, groupIdx) => {
    if (group.plot.id === undefined) return;
    const color = PLOT_COLORS[groupIdx % PLOT_COLORS.length];
    const statusLabel = group.plot.finalizedAt ? 'Finalizada' : 'Atual';
    const item = document.createElement('div');
    item.className = 'picker-item';
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.dataset.kind = 'plot';
    item.dataset.id = String(group.plot.id);
    item.dataset.name = group.plot.name;
    item.innerHTML = `
      <span class="picker-item-swatch" style="background:${color}"></span>
      <span class="picker-item-body">
        <span class="picker-item-name">${group.plot.name}</span>
        <span class="picker-item-sub">${group.photos.length === 1 ? '1 foto' : `${group.photos.length} fotos`}</span>
      </span>
      <span class="picker-item-type">Área<br>${statusLabel}</span>
      ${DELETE_BUTTON_HTML}`;
    list.appendChild(item);
  });

  tracks.forEach((track, trackIdx) => {
    if (track.id === undefined || track.points.length === 0) return;
    const color = track.color || TRACK_COLORS[trackIdx % TRACK_COLORS.length];
    const label = track.name || (track.kind === 'trail' ? 'Trilha' : 'Vídeo');
    const item = document.createElement('div');
    item.className = 'picker-item';
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.dataset.kind = 'track';
    item.dataset.id = String(track.id);
    item.dataset.name = label;
    item.innerHTML = `
      <span class="picker-item-swatch" style="background:${color}"></span>
      <span class="picker-item-body">
        <span class="picker-item-name">${label}</span>
        <span class="picker-item-sub">${track.points.length === 1 ? '1 ponto' : `${track.points.length} pontos`} · ${formatDateTime(track.datetime)}</span>
      </span>
      <span class="picker-item-type">${track.closed ? 'Área' : 'Trilha'}</span>
      ${DELETE_BUTTON_HTML}`;
    list.appendChild(item);
  });
}

async function renderSummaryPanel(): Promise<void> {
  const [groups, tracks] = await Promise.all([getPlotGroups(), getAllTracks()]);
  const list = el('map-summary-list');
  list.innerHTML = '';

  if (groups.length === 0 && tracks.length === 0) {
    list.innerHTML = '<div class="map-summary-empty">Capture pelo menos 2 pontos para ver as distâncias.</div>';
    return;
  }

  groups.forEach((group, groupIdx) => {
    if (group.plot.id === undefined) return;
    const color = PLOT_COLORS[groupIdx % PLOT_COLORS.length];
    const { segments, total } = computeGroupSegments(group.photos);
    const hectares = computePolygonAreaHectares(group.photos);
    const hidden = hiddenPlotIds.has(group.plot.id);

    const section = document.createElement('div');
    section.className = hidden ? 'map-summary-group is-hidden' : 'map-summary-group';

    const header = document.createElement('div');
    header.className = 'map-summary-group-header';
    const statusLabel = group.plot.finalizedAt ? 'Finalizada' : 'Atual';
    header.innerHTML = `<span class="map-summary-swatch" style="background:${color}"></span><span>${group.plot.name}</span><span class="map-summary-status">${statusLabel}</span>${toggleButtonHtml('plot', group.plot.id, hidden)}`;
    section.appendChild(header);

    if (segments.length === 0) {
      const note = document.createElement('div');
      note.className = 'map-summary-empty';
      note.innerText = 'Apenas 1 ponto — capture mais pra ver distâncias.';
      section.appendChild(note);
    } else {
      segments.forEach((seg) => {
        const row = document.createElement('div');
        row.className = 'map-summary-row';
        row.innerHTML = `<span>${seg.label}</span><span>${formatDistance(seg.meters)}</span>`;
        section.appendChild(row);
      });

      const totalRow = document.createElement('div');
      totalRow.className = 'map-summary-row map-summary-subtotal';
      totalRow.innerHTML = `<span>Total</span><span>${formatDistance(total)}</span>`;
      section.appendChild(totalRow);

      if (hectares > 0) {
        const areaRow = document.createElement('div');
        areaRow.className = 'map-summary-row map-summary-subtotal';
        areaRow.innerHTML = `<span>Área</span><span>${hectares.toFixed(2)} ha</span>`;
        section.appendChild(areaRow);
      }
    }

    list.appendChild(section);
  });

  tracks.forEach((track, trackIdx) => {
    if (track.id === undefined || track.points.length === 0) return;
    const color = track.color || TRACK_COLORS[trackIdx % TRACK_COLORS.length];
    const hidden = hiddenTrackIds.has(track.id);
    const label = track.name || (track.kind === 'trail' ? 'Trilha' : 'Vídeo');

    const section = document.createElement('div');
    section.className = hidden ? 'map-summary-group is-hidden' : 'map-summary-group';

    const header = document.createElement('div');
    header.className = 'map-summary-group-header';
    header.innerHTML = `<span class="map-summary-swatch" style="background:${color}"></span><span>${label}</span><span class="map-summary-status">${track.closed ? 'Área' : 'Rota'}</span>${toggleButtonHtml('track', track.id, hidden)}`;
    section.appendChild(header);

    const rows = [
      [track.points.length === 1 ? '1 ponto' : `${track.points.length} pontos`, ''],
      [track.closed ? 'Perímetro' : 'Distância', formatDistance(track.distance)],
      ['Duração', formatDuration(track.duration)],
      ['Vel. média', `${track.avgSpeed.toFixed(1)} km/h`],
    ];
    rows.forEach(([label2, value]) => {
      const row = document.createElement('div');
      row.className = 'map-summary-row';
      row.innerHTML = value ? `<span>${label2}</span><span>${value}</span>` : `<span>${label2}</span>`;
      section.appendChild(row);
    });

    if (track.closed && track.areaHectares) {
      const areaRow = document.createElement('div');
      areaRow.className = 'map-summary-row map-summary-subtotal';
      areaRow.innerHTML = `<span>Área</span><span>${track.areaHectares.toFixed(2)} ha</span>`;
      section.appendChild(areaRow);
    }

    list.appendChild(section);
  });
}

function drawPolylinePath(ctx: CanvasRenderingContext2D, points: L.Point[], color: string, width: number): void {
  if (points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.95;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
  ctx.restore();
}

function drawCircleMarker(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, label: string, textColor: string, fontSize: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 6;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = textColor;
  ctx.font = `800 ${fontSize}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y + 1);
  ctx.restore();
}

async function exportMapImage(): Promise<void> {
  const map = mapInstance;
  const mapEl = el('map-container');
  if (!map) return;

  map.closePopup();
  const zoomCtrl = document.querySelector<HTMLElement>('.leaflet-control-zoom');
  const layersCtrl = document.querySelector<HTMLElement>('.leaflet-control-layers');
  const markerPane = map.getPane('markerPane');
  const overlayPane = map.getPane('overlayPane');
  if (zoomCtrl) zoomCtrl.style.visibility = 'hidden';
  if (layersCtrl) layersCtrl.style.visibility = 'hidden';
  // html2canvas mis-renders anything Leaflet positions via CSS transform — markers AND
  // the SVG polylines both live in transformed panes — so we hide both for the capture
  // and redraw them ourselves afterward using Leaflet's own (accurate) pixel conversion.
  if (markerPane) markerPane.style.visibility = 'hidden';
  if (overlayPane) overlayPane.style.visibility = 'hidden';

  let mapCanvas: HTMLCanvasElement;
  try {
    mapCanvas = await html2canvas(mapEl, { useCORS: true, backgroundColor: '#0a0a0a', scale: 1 });
  } finally {
    if (zoomCtrl) zoomCtrl.style.visibility = '';
    if (layersCtrl) layersCtrl.style.visibility = '';
    if (markerPane) markerPane.style.visibility = '';
    if (overlayPane) overlayPane.style.visibility = '';
  }

  const [allGroups, allTracks] = await Promise.all([getPlotGroups(), getAllTracks()]);
  const groups = allGroups.filter((g) => g.plot.id === undefined || !hiddenPlotIds.has(g.plot.id));
  const tracks = allTracks.filter((t) => t.id === undefined || !hiddenTrackIds.has(t.id));

  const mapCtx = mapCanvas.getContext('2d');
  if (mapCtx) {
    groups.forEach((group, groupIdx) => {
      const color = PLOT_COLORS[groupIdx % PLOT_COLORS.length];
      if (group.photos.length > 1) {
        const linePts = group.photos.map((p) => map.latLngToContainerPoint([p.lat, p.lon]));
        drawPolylinePath(mapCtx, [...linePts, linePts[0]], color, 4);
      }
    });
    tracks.forEach((track, trackIdx) => {
      if (track.points.length < 2) return;
      const color = track.color || TRACK_COLORS[trackIdx % TRACK_COLORS.length];
      const trackPts = track.points.map((p) => map.latLngToContainerPoint([p.lat, p.lon]));
      const pathPts = track.closed ? [...trackPts, trackPts[0]] : trackPts;
      drawPolylinePath(mapCtx, pathPts, color, 4);
    });

    groups.forEach((group, groupIdx) => {
      const color = PLOT_COLORS[groupIdx % PLOT_COLORS.length];
      group.photos.forEach((photo, idx) => {
        const pt = map.latLngToContainerPoint([photo.lat, photo.lon]);
        drawCircleMarker(mapCtx, pt.x, pt.y, 14, color, String(idx + 1), '#0a0a0a', 12);
      });
    });
    tracks.forEach((track, trackIdx) => {
      if (track.points.length === 0) return;
      const color = track.color || TRACK_COLORS[trackIdx % TRACK_COLORS.length];
      track.points.forEach((point, idx) => {
        const pt = map.latLngToContainerPoint([point.lat, point.lon]);
        drawCircleMarker(mapCtx, pt.x, pt.y, 12, color, String(idx + 1), '#0a0a0a', 11);
      });
    });
  }

  // Compute the summary block height up front so the output canvas can fit everything.
  const padding = 20;
  const rowHeight = 22;
  const groupHeaderHeight = 30;
  const groupGap = 14;
  let summaryHeight = padding;
  const groupInfos = groups.map((group, groupIdx) => {
    const { segments, total } = computeGroupSegments(group.photos);
    const hectares = computePolygonAreaHectares(group.photos);
    const rows = Math.max(segments.length, 1) + (segments.length > 0 ? 1 : 0) + (hectares > 0 ? 1 : 0);
    summaryHeight += groupHeaderHeight + rows * rowHeight + groupGap;
    return { group, groupIdx, segments, total, hectares };
  });
  summaryHeight += padding;
  if (groups.length === 0) summaryHeight = padding + rowHeight + padding;

  const out = document.createElement('canvas');
  out.width = mapCanvas.width;
  out.height = mapCanvas.height + summaryHeight;
  const ctx = out.getContext('2d');
  if (!ctx) return;

  ctx.drawImage(mapCanvas, 0, 0);
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, mapCanvas.height, out.width, summaryHeight);

  let y = mapCanvas.height + padding;
  ctx.textBaseline = 'top';

  if (groupInfos.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '500 13px Inter, sans-serif';
    ctx.fillText('Nenhum ponto capturado ainda.', padding, y);
  }

  groupInfos.forEach(({ group, groupIdx, segments, total, hectares }) => {
    const color = PLOT_COLORS[groupIdx % PLOT_COLORS.length];
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(padding + 5, y + 10, 5, 0, 2 * Math.PI);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 15px Inter, sans-serif';
    ctx.fillText(group.plot.name, padding + 18, y);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '600 11px Inter, sans-serif';
    ctx.fillText(group.plot.finalizedAt ? 'FINALIZADA' : 'ATUAL', out.width - padding, y + 3);
    ctx.textAlign = 'left';
    y += groupHeaderHeight;

    ctx.font = '500 12.5px Inter, sans-serif';
    if (segments.length === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText('Apenas 1 ponto.', padding, y);
      y += rowHeight;
    } else {
      segments.forEach((seg) => {
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.fillText(seg.label, padding, y);
        ctx.textAlign = 'right';
        ctx.fillStyle = color;
        ctx.fillText(formatDistance(seg.meters), out.width - padding, y);
        ctx.textAlign = 'left';
        y += rowHeight;
      });

      ctx.font = '800 13px Inter, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText('Total', padding, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = color;
      ctx.fillText(formatDistance(total), out.width - padding, y);
      ctx.textAlign = 'left';
      y += rowHeight;

      if (hectares > 0) {
        ctx.font = '800 13px Inter, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.fillText('Área', padding, y);
        ctx.textAlign = 'right';
        ctx.fillStyle = color;
        ctx.fillText(`${hectares.toFixed(2)} ha`, out.width - padding, y);
        ctx.textAlign = 'left';
        y += rowHeight;
      }
    }

    y += groupGap;
  });

  const dataUrl = out.toDataURL('image/png');
  await saveFile(dataUrl, `geocamera_mapa_${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
}

export async function renderMap(): Promise<void> {
  const map = ensureMap();
  const empty = el('map-empty');
  const container = el('map-container');
  const countEl = el('map-count-value');

  const [groups, tracks] = await Promise.all([getPlotGroups(), getAllTracks()]);

  markersLayer?.clearLayers();
  tracksLayer?.clearLayers();

  const visibleGroups = groups.filter((g) => g.plot.id === undefined || !hiddenPlotIds.has(g.plot.id));
  const visibleTracks = tracks.filter((t) => t.id === undefined || !hiddenTrackIds.has(t.id));
  const totalPhotos = visibleGroups.reduce((s, g) => s + g.photos.length, 0);
  const countParts: string[] = [];
  if (totalPhotos > 0) countParts.push(totalPhotos === 1 ? '1 ponto' : `${totalPhotos} pontos`);
  if (visibleTracks.length > 0) countParts.push(visibleTracks.length === 1 ? '1 trilha' : `${visibleTracks.length} trilhas`);
  countEl.innerText = countParts.length > 0 ? countParts.join(' · ') : '0 pontos';

  await renderSummaryPanel();

  if (groups.length === 0 && tracks.length === 0) {
    empty.hidden = false;
    container.hidden = true;
    return;
  }
  empty.hidden = true;
  container.hidden = false;

  const allBoundsPoints: L.LatLngTuple[] = [];

  groups.forEach((group, groupIdx) => {
    if (group.plot.id !== undefined && hiddenPlotIds.has(group.plot.id)) return;
    const color = PLOT_COLORS[groupIdx % PLOT_COLORS.length];
    const latLngs: L.LatLngTuple[] = group.photos.map((p) => [p.lat, p.lon]);
    allBoundsPoints.push(...latLngs);

    group.photos.forEach((photo, idx) => {
      const marker = L.marker([photo.lat, photo.lon], { icon: numberedIcon(idx + 1, color) });
      const thumb = `<img src="${photo.dataUrl}" alt="" style="width:100%;border-radius:10px;margin-bottom:8px;display:block;">`;
      const addressLine = photo.address ? `<div class="map-popup-address">${photo.address}</div>` : '';
      marker.bindPopup(
        `<div class="map-popup">
          ${thumb}
          <div class="map-popup-title">${group.plot.name} · Ponto #${idx + 1}</div>
          ${addressLine}
          <div class="map-popup-coords">${photo.lat.toFixed(6)}, ${photo.lon.toFixed(6)}</div>
          <div class="map-popup-date">${formatDateTime(photo.datetime)}</div>
        </div>`
      );
      markersLayer?.addLayer(marker);
    });

    if (latLngs.length > 1) {
      const closedLoop = [...latLngs, latLngs[0]];
      const line = L.polyline(closedLoop, { color, weight: 4, opacity: 0.95 });
      markersLayer?.addLayer(line);
    }
  });

  tracks.forEach((track: TrackRecord, trackIdx) => {
    if (track.points.length === 0) return;
    if (track.id !== undefined && hiddenTrackIds.has(track.id)) return;
    const color = track.color || TRACK_COLORS[trackIdx % TRACK_COLORS.length];
    const trackLatLngs: L.LatLngTuple[] = track.points.map((p) => [p.lat, p.lon]);
    allBoundsPoints.push(...trackLatLngs);

    if (track.closed && trackLatLngs.length >= 3) {
      L.polygon(trackLatLngs, { color, weight: 4, opacity: 0.9, fillColor: color, fillOpacity: 0.15 }).addTo(tracksLayer as L.LayerGroup);
    } else {
      L.polyline(trackLatLngs, { color, weight: 4, opacity: 0.85 }).addTo(tracksLayer as L.LayerGroup);
    }

    const label = track.name || (track.kind === 'trail' ? 'Trilha' : 'Vídeo');

    track.points.forEach((point, idx) => {
      const isFirst = idx === 0;
      const isLast = idx === track.points.length - 1;
      const marker = L.marker([point.lat, point.lon], { icon: numberedIcon(idx + 1, color) });

      const lines = [`<div class="map-popup-title">${label} · Ponto #${idx + 1}</div>`];
      if (isFirst && track.startAddress) lines.push(`<div class="map-popup-address">${track.startAddress}</div>`);
      if (isLast && track.endAddress) lines.push(`<div class="map-popup-address">${track.endAddress}</div>`);
      lines.push(`<div class="map-popup-coords">${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}</div>`);
      lines.push(`<div class="map-popup-date">${formatDateTime(point.timestamp)}</div>`);
      const extras: string[] = [];
      if (point.alt !== null) extras.push(`alt. ${point.alt.toFixed(0)} m`);
      if (point.speed !== null) extras.push(`${point.speed.toFixed(1)} km/h`);
      if (extras.length > 0) lines.push(`<div class="map-popup-date">${extras.join(' · ')}</div>`);

      if (isLast) {
        const summaryParts = [formatDuration(track.duration), formatDistance(track.distance), `méd. ${track.avgSpeed.toFixed(1)} km/h`];
        if (track.closed && track.areaHectares) summaryParts.push(`${track.areaHectares.toFixed(2)} ha`);
        lines.push(`<div class="map-popup-date">${summaryParts.join(' · ')}</div>`);
      }

      marker.bindPopup(`<div class="map-popup">${lines.join('')}</div>`);
      tracksLayer?.addLayer(marker);
    });
  });

  if (allBoundsPoints.length === 1) {
    map.setView(allBoundsPoints[0], 16);
  } else if (allBoundsPoints.length > 1) {
    map.fitBounds(L.latLngBounds(allBoundsPoints), { padding: [44, 44], maxZoom: 17 });
  }

  setTimeout(() => map.invalidateSize(), 150);
}

function estimateTileCount(layer: TileLayerOffline, map: L.Map, maxZoom: number): number {
  const currentZoom = map.getZoom();
  const bounds = map.getBounds();
  let total = 0;
  for (let zoom = currentZoom; zoom <= maxZoom; zoom++) {
    const area = L.bounds(
      map.project(bounds.getNorthWest(), zoom),
      map.project(bounds.getSouthEast(), zoom)
    );
    total += layer.getTileUrls(area, zoom).length;
  }
  return total;
}

function downloadCurrentArea(): void {
  if (!mapInstance || !saveTilesControl) return;
  if (offlineDownloadInProgress) return;
  if (!activeBaseLayer) {
    offlineStatus('Mapa do Google é só online — troque para "Ruas" ou "Satélite" antes de baixar.', 4000);
    return;
  }

  if (mapInstance.getZoom() < 12) {
    offlineStatus('Dê mais zoom antes de baixar — escolha a região específica onde vai trabalhar (uma fazenda, um bairro).', 4000);
    return;
  }

  const estimate = estimateTileCount(activeBaseLayer, mapInstance, OFFLINE_MAX_ZOOM);
  if (estimate === 0) return;
  if (estimate > OFFLINE_MAX_TILES) {
    offlineStatus(`Área grande demais (${estimate.toLocaleString('pt-BR')} blocos). Dê mais zoom e baixe uma região menor por vez.`, 4000);
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (saveTilesControl as any)._saveTiles();
}

export function initMap(callbacks?: { onSelectItem?: () => void; onDataChange?: () => void }): void {
  el('map-picker-list').addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;

    const deleteBtn = target.closest('.picker-item-delete');
    if (deleteBtn) {
      const item = deleteBtn.closest<HTMLElement>('.picker-item');
      if (!item) return;
      const kind = item.dataset.kind === 'track' ? 'track' : 'plot';
      const id = Number(item.dataset.id);
      if (Number.isNaN(id)) return;
      pendingDelete = { kind, id, name: item.dataset.name || (kind === 'track' ? 'esta trilha' : 'esta área') };
      el('delete-confirm-message').innerText = `Excluir "${pendingDelete.name}"? ${kind === 'plot' ? 'As fotos dessa área também serão apagadas.' : 'Os pontos dessa trilha também serão apagados.'} Essa ação não pode ser desfeita.`;
      el('delete-confirm-modal').style.display = 'flex';
      return;
    }

    if (target.closest('.picker-all-btn')) {
      showAllMapItems();
      callbacks?.onSelectItem?.();
      return;
    }
    const item = target.closest<HTMLElement>('.picker-item');
    if (!item) return;
    const kind = item.dataset.kind === 'track' ? 'track' : 'plot';
    const id = Number(item.dataset.id);
    if (Number.isNaN(id)) return;
    await selectSingleMapItem(kind, id);
    callbacks?.onSelectItem?.();
  });

  el('delete-confirm-cancel-btn').addEventListener('click', () => {
    pendingDelete = null;
    el('delete-confirm-modal').style.display = 'none';
  });

  el('delete-confirm-ok-btn').addEventListener('click', async () => {
    if (!pendingDelete) return;
    const btn = el<HTMLButtonElement>('delete-confirm-ok-btn');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      if (pendingDelete.kind === 'plot') {
        await deletePlot(pendingDelete.id);
        hiddenPlotIds.delete(pendingDelete.id);
      } else {
        await deleteTrack(pendingDelete.id);
        hiddenTrackIds.delete(pendingDelete.id);
      }
      pendingDelete = null;
      btn.disabled = false;
      el('delete-confirm-modal').style.display = 'none';
      callbacks?.onDataChange?.();
      await renderMapPicker();
    } catch (err) {
      btn.disabled = false;
      el('delete-confirm-message').innerText = 'Não foi possível excluir: ' + (err instanceof Error ? err.message : String(err));
    }
  });

  el('map-count-btn').addEventListener('click', () => {
    el('map-summary').classList.toggle('hidden');
  });
  el('map-summary-close').addEventListener('click', () => {
    el('map-summary').classList.add('hidden');
  });
  el('map-export-btn').addEventListener('click', () => {
    exportMapImage();
  });
  el('map-offline-btn').addEventListener('click', downloadCurrentArea);

  el('map-summary-list').addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('.map-summary-toggle');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (Number.isNaN(id)) return;
    const set = btn.dataset.kind === 'plot' ? hiddenPlotIds : hiddenTrackIds;
    if (set.has(id)) set.delete(id);
    else set.add(id);
    renderMap();
  });
}
