import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import html2canvas from 'html2canvas';
import { tileLayerOffline, savetiles, type TileLayerOffline, type ControlSaveTiles } from 'leaflet.offline';
import { el } from './dom';
import { getAllPhotos, getAllTracks, getAllPlots, type PhotoRecord, type TrackRecord, type PlotRecord } from './db';
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

function endpointIcon(symbol: string, color: string): L.DivIcon {
  return L.divIcon({
    className: 'map-endpoint',
    html: `<span style="background:${color}">${symbol}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -12],
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

  mapInstance = L.map('map-container', { zoomControl: false, attributionControl: true, layers: [streets] });
  activeBaseLayer = streets;
  L.control.zoom({ position: 'bottomright' }).addTo(mapInstance);
  L.control.layers({ 'Ruas': streets, 'Satélite': satellite }, undefined, { position: 'bottomright' }).addTo(mapInstance);

  mapInstance.on('baselayerchange', (e) => {
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

async function renderSummaryPanel(): Promise<void> {
  const groups = await getPlotGroups();
  const list = el('map-summary-list');
  list.innerHTML = '';

  if (groups.length === 0) {
    list.innerHTML = '<div class="map-summary-empty">Capture pelo menos 2 pontos para ver as distâncias.</div>';
    return;
  }

  groups.forEach((group, groupIdx) => {
    const color = PLOT_COLORS[groupIdx % PLOT_COLORS.length];
    const { segments, total } = computeGroupSegments(group.photos);
    const hectares = computePolygonAreaHectares(group.photos);

    const section = document.createElement('div');
    section.className = 'map-summary-group';

    const header = document.createElement('div');
    header.className = 'map-summary-group-header';
    const statusLabel = group.plot.finalizedAt ? 'Finalizada' : 'Atual';
    header.innerHTML = `<span class="map-summary-swatch" style="background:${color}"></span><span>${group.plot.name}</span><span class="map-summary-status">${statusLabel}</span>`;
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

  const [groups, tracks] = await Promise.all([getPlotGroups(), getAllTracks()]);

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
    tracks.forEach((track) => {
      if (track.points.length === 0) return;
      const first = track.points[0];
      const last = track.points[track.points.length - 1];
      const startPt = map.latLngToContainerPoint([first.lat, first.lon]);
      const endPt = map.latLngToContainerPoint([last.lat, last.lon]);
      drawCircleMarker(mapCtx, startPt.x, startPt.y, 11, '#2ECC71', '▶', '#ffffff', 10);
      drawCircleMarker(mapCtx, endPt.x, endPt.y, 11, '#FF4D4F', '■', '#ffffff', 10);
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

  const totalPhotos = groups.reduce((s, g) => s + g.photos.length, 0);
  const countParts: string[] = [];
  if (totalPhotos > 0) countParts.push(totalPhotos === 1 ? '1 ponto' : `${totalPhotos} pontos`);
  if (tracks.length > 0) countParts.push(tracks.length === 1 ? '1 trilha' : `${tracks.length} trilhas`);
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
    const color = track.color || TRACK_COLORS[trackIdx % TRACK_COLORS.length];
    const trackLatLngs: L.LatLngTuple[] = track.points.map((p) => [p.lat, p.lon]);
    allBoundsPoints.push(...trackLatLngs);

    if (track.closed && trackLatLngs.length >= 3) {
      L.polygon(trackLatLngs, { color, weight: 4, opacity: 0.9, fillColor: color, fillOpacity: 0.15 }).addTo(tracksLayer as L.LayerGroup);
    } else {
      L.polyline(trackLatLngs, { color, weight: 4, opacity: 0.85 }).addTo(tracksLayer as L.LayerGroup);
    }

    const first = track.points[0];
    const last = track.points[track.points.length - 1];
    const label = track.name || (track.kind === 'trail' ? 'Trilha' : 'Vídeo');

    const startMarker = L.marker([first.lat, first.lon], { icon: endpointIcon('▶', '#2ECC71') });
    startMarker.bindPopup(
      `<div class="map-popup">
        <div class="map-popup-title">${label} · início</div>
        <div class="map-popup-address">${track.startAddress || ''}</div>
        <div class="map-popup-coords">${first.lat.toFixed(6)}, ${first.lon.toFixed(6)}</div>
        <div class="map-popup-date">${formatDateTime(track.datetime)}</div>
      </div>`
    );
    tracksLayer?.addLayer(startMarker);

    const endStats = [formatDuration(track.duration), formatDistance(track.distance), `méd. ${track.avgSpeed.toFixed(1)} km/h`];
    if (track.closed && track.areaHectares) endStats.push(`${track.areaHectares.toFixed(2)} ha`);

    const endMarker = L.marker([last.lat, last.lon], { icon: endpointIcon('■', '#FF4D4F') });
    endMarker.bindPopup(
      `<div class="map-popup">
        <div class="map-popup-title">${label} · fim</div>
        <div class="map-popup-address">${track.endAddress || ''}</div>
        <div class="map-popup-coords">${last.lat.toFixed(6)}, ${last.lon.toFixed(6)}</div>
        <div class="map-popup-date">${endStats.join(' · ')}</div>
      </div>`
    );
    tracksLayer?.addLayer(endMarker);
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
  if (!mapInstance || !activeBaseLayer || !saveTilesControl) return;
  if (offlineDownloadInProgress) return;

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

export function initMap(): void {
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
}
