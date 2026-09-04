import { el } from './dom';
import { addTrack, type TrackPoint } from './db';

const TRAIL_COLORS = ['#4A9EFF', '#FF9F4A', '#B26AFF', '#FF4D6A', '#4AD9C0', '#D4A017'];
const MIN_ACCURACY_METERS = 30;
// The continuous path only records a new sample once you've moved at least this far —
// otherwise standing still would pile up hundreds of near-identical points.
const PATH_MIN_INTERVAL_METERS = 3;

type FinalizeChoice = 'open' | 'closed';

interface TrailOnDoneOptions {
  onBack?: () => void;
  onSaved?: () => void;
}

let watchId: number | null = null;
let isTracking = false;
let isPaused = false;
let hasGpsFix = false;

let trailName = '';
let trailColor = TRAIL_COLORS[0];

// The real walked route, sampled automatically and continuously — draws the actual path
// on the map (curves, not straight lines) and is what distance/area are computed from.
let path: TrackPoint[] = [];
// Manually marked waypoints — the user taps "Marcar ponto" to drop one; shown as numbered
// markers on the map, independent of the automatic path sampling above.
let points: TrackPoint[] = [];
let totalDistance = 0;
let maxSpeedKmh = 0;

let startTime = 0;
let pausedAccumulatedMs = 0;
let pauseStartedAt = 0;
let timerInterval: ReturnType<typeof setInterval> | null = null;

let currentLat = 0;
let currentLon = 0;
let currentAlt: number | null = null;
let currentAcc = 0;

let selectedFinalizeChoice: FinalizeChoice | null = null;
let onBackCallback: (() => void) | undefined;
let onSavedCallback: (() => void) | undefined;
let trailColorIndex = 0;

function getDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function computeAreaHectares(pts: { lat: number; lon: number }[]): number {
  if (pts.length < 3) return 0;
  const avgLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const latRad = avgLat * Math.PI / 180;
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos(latRad);
  const xy = pts.map((p) => [p.lon * metersPerDegLon, p.lat * metersPerDegLat]);
  let area = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2 / 10000;
}

function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(2)} km`;
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showTrailToast(message: string): void {
  const toast = el('trail-toast');
  toast.innerText = message;
  toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

function defaultTrailName(): string {
  const now = new Date();
  const date = now.toLocaleDateString('pt-BR');
  const time = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `Trilha ${date} ${time}`;
}

async function geocodeOnce(lat: number, lon: number): Promise<string> {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`);
    if (!res.ok) throw new Error('HTTP error');
    const data = await res.json();
    return data?.display_name ?? 'Endereço indisponível';
  } catch {
    return 'Endereço indisponível';
  }
}

// ---------- Setup screen ----------

function showSetupScreen(): void {
  trailName = '';
  el<HTMLInputElement>('trail-name-input').value = '';
  el<HTMLInputElement>('trail-name-input').placeholder = defaultTrailName();
}

// ---------- Active tracking screen ----------

function accuracyColorClass(acc: number): string {
  if (acc <= 10) return 'good';
  if (acc <= MIN_ACCURACY_METERS) return 'ok';
  return 'bad';
}

function updateTimerDisplay(): void {
  const elapsedMs = Date.now() - startTime - pausedAccumulatedMs;
  el('trail-timer').innerText = formatDuration(elapsedMs / 1000);
}

function updateLiveStats(): void {
  el('trail-point-count').innerText = points.length === 1 ? '1 ponto' : `${points.length} pontos`;
  el('trail-distance').innerText = formatDistance(totalDistance);
  el('trail-coords').innerText = hasGpsFix
    ? `${currentLat.toFixed(6)}, ${currentLon.toFixed(6)}`
    : '--.------, --.------';
  el('trail-altitude').innerText = currentAlt !== null ? `${currentAlt.toFixed(1)} m` : '--';

  const accEl = el('trail-accuracy');
  accEl.innerText = hasGpsFix ? `${currentAcc.toFixed(1)} m` : '-- m';
  accEl.className = `trail-stat-value acc-${hasGpsFix ? accuracyColorClass(currentAcc) : 'bad'}`;
}

function addPathPoint(lat: number, lon: number, alt: number | null, acc: number): void {
  const timestamp = new Date().toISOString();
  const point: TrackPoint = { timestamp, lat, lon, alt, acc, speed: null };

  const last = path[path.length - 1];
  if (last) {
    const deltaMeters = getDistanceMeters(last.lat, last.lon, lat, lon);
    const deltaSeconds = (new Date(timestamp).getTime() - new Date(last.timestamp).getTime()) / 1000;
    totalDistance += deltaMeters;
    if (deltaSeconds > 0) {
      const speedKmh = (deltaMeters / 1000) / (deltaSeconds / 3600);
      point.speed = speedKmh;
      maxSpeedKmh = Math.max(maxSpeedKmh, speedKmh);
    }
  }

  path.push(point);
}

function renderMarksList(): void {
  const panel = el('trail-marks-panel');
  const list = el('trail-marks-list');

  if (points.length === 0) {
    panel.hidden = true;
    list.innerHTML = '';
    return;
  }

  panel.hidden = false;
  list.innerHTML = points
    .map((point, idx) => {
      const num = idx + 1;
      let value = 'Início';
      if (idx > 0) {
        const prev = points[idx - 1];
        value = formatDistance(getDistanceMeters(prev.lat, prev.lon, point.lat, point.lon));
      }
      return `<div class="trail-marks-item"><span class="trail-marks-num">${num}</span><span class="trail-marks-value">${value}</span></div>`;
    })
    .join('');
  list.scrollTop = list.scrollHeight;
}

function markPoint(): void {
  if (!isTracking || isPaused) return;
  if (!hasGpsFix) {
    showTrailToast('Aguardando sinal de GPS antes de marcar o ponto.');
    return;
  }
  if (currentAcc > MIN_ACCURACY_METERS) {
    showTrailToast(`Precisão do GPS muito baixa agora (${currentAcc.toFixed(0)} m). Aguarde melhorar antes de marcar.`);
    return;
  }

  points.push({
    timestamp: new Date().toISOString(),
    lat: currentLat,
    lon: currentLon,
    alt: currentAlt,
    acc: currentAcc,
    speed: null,
  });
  updateLiveStats();
  renderMarksList();
  showTrailToast(`Ponto ${points.length} marcado.`);
}

function handlePosition(pos: GeolocationPosition): void {
  currentLat = pos.coords.latitude;
  currentLon = pos.coords.longitude;
  currentAlt = pos.coords.altitude;
  currentAcc = pos.coords.accuracy;
  hasGpsFix = true;

  el('trail-signal-warning').classList.add('hidden');

  if (currentAcc > MIN_ACCURACY_METERS) {
    updateLiveStats();
    return; // too noisy to count towards the trail
  }

  if (isPaused) {
    updateLiveStats();
    return;
  }

  const last = path[path.length - 1];
  if (!last || getDistanceMeters(last.lat, last.lon, currentLat, currentLon) >= PATH_MIN_INTERVAL_METERS) {
    addPathPoint(currentLat, currentLon, currentAlt, currentAcc);
  }

  updateLiveStats();
}

function handlePositionError(): void {
  el('trail-signal-warning').classList.remove('hidden');
}

function startTracking(): void {
  const nameInput = el<HTMLInputElement>('trail-name-input');
  trailName = nameInput.value.trim() || nameInput.placeholder || defaultTrailName();
  trailColor = TRAIL_COLORS[trailColorIndex % TRAIL_COLORS.length];
  trailColorIndex += 1;

  path = [];
  points = [];
  totalDistance = 0;
  maxSpeedKmh = 0;
  pausedAccumulatedMs = 0;
  hasGpsFix = false;
  isPaused = false;
  isTracking = true;
  startTime = Date.now();

  el('trail-name-display').innerText = trailName;
  el('trail-status-text').innerText = 'RASTREANDO...';
  el('trail-status-dot').classList.remove('paused');
  el('trail-pause-btn').innerText = 'Pausar';
  el('trail-signal-warning').classList.add('hidden');
  updateLiveStats();
  updateTimerDisplay();
  renderMarksList();

  timerInterval = setInterval(updateTimerDisplay, 1000);

  watchId = navigator.geolocation.watchPosition(handlePosition, handlePositionError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 15000,
  });
}

function togglePause(): void {
  if (!isTracking) return;
  isPaused = !isPaused;
  if (isPaused) {
    pauseStartedAt = Date.now();
    el('trail-status-text').innerText = 'PAUSADO';
    el('trail-status-dot').classList.add('paused');
    el('trail-pause-btn').innerText = 'Retomar';
  } else {
    pausedAccumulatedMs += Date.now() - pauseStartedAt;
    el('trail-status-text').innerText = 'RASTREANDO...';
    el('trail-status-dot').classList.remove('paused');
    el('trail-pause-btn').innerText = 'Pausar';
  }
}

function stopWatching(): void {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  isTracking = false;
  isPaused = false;
}

function resetActiveScreen(): void {
  stopWatching();
  path = [];
  points = [];
  el('trail-signal-warning').classList.add('hidden');
  el('trail-toast').classList.add('hidden');
  renderMarksList();
}

// ---------- Finalize flow ----------

function openFinalizeModal(): void {
  if (path.length < 2) {
    showTrailToast(
      'Ainda não há caminho suficiente registrado. A precisão do GPS pode estar ruim demais (veja o card "Precisão GPS") — o caminho só é gravado com precisão melhor que 30 m.'
    );
    return;
  }
  selectedFinalizeChoice = null;
  document.querySelectorAll<HTMLButtonElement>('.trail-choice-card').forEach((c) => c.classList.remove('selected'));
  el<HTMLButtonElement>('trail-finalize-save-btn').disabled = true;
  el('trail-finalize-choice').classList.remove('hidden');
  el('trail-finalize-summary').classList.add('hidden');
  el('trail-finalize-modal').style.display = 'flex';
}

function closeFinalizeModal(): void {
  el('trail-finalize-modal').style.display = 'none';
}

async function saveTrail(): Promise<void> {
  if (!selectedFinalizeChoice) return;
  const closed = selectedFinalizeChoice === 'closed';
  stopWatching();

  // Always end with a marked point at the final position, even if the user never tapped
  // "Marcar ponto" — so every saved trail has at least a start/end marker on the map.
  if (hasGpsFix) {
    const lastMark = points[points.length - 1];
    const samePosition = lastMark && getDistanceMeters(lastMark.lat, lastMark.lon, currentLat, currentLon) < 1;
    if (!samePosition) {
      points.push({
        timestamp: new Date().toISOString(),
        lat: currentLat,
        lon: currentLon,
        alt: currentAlt,
        acc: currentAcc,
        speed: null,
      });
    }
  }

  const durationSeconds = (Date.now() - startTime - pausedAccumulatedMs) / 1000;
  let distance = totalDistance;
  if (closed && path.length >= 3) {
    const first = path[0];
    const last = path[path.length - 1];
    distance += getDistanceMeters(last.lat, last.lon, first.lat, first.lon);
  }
  const avgSpeed = distance > 0 && durationSeconds > 0 ? (distance / 1000) / (durationSeconds / 3600) : 0;
  const areaHectares = closed ? computeAreaHectares(path) : 0;

  const first = path[0];
  const last = path[path.length - 1];
  const [startAddress, endAddress] = await Promise.all([
    geocodeOnce(first.lat, first.lon),
    geocodeOnce(last.lat, last.lon),
  ]);

  await addTrack({
    kind: 'trail',
    name: trailName,
    color: trailColor,
    closed,
    areaHectares: areaHectares > 0 ? areaHectares : undefined,
    datetime: new Date(startTime).toISOString(),
    duration: durationSeconds,
    distance,
    avgSpeed,
    maxSpeed: maxSpeedKmh,
    points,
    path,
    startAddress,
    endAddress,
  });

  const straightLine = getDistanceMeters(first.lat, first.lon, last.lat, last.lon);
  const parts = [
    points.length === 1 ? '1 ponto marcado' : `${points.length} pontos marcados`,
    closed ? `Perímetro: ${formatDistance(distance)}` : `Distância: ${formatDistance(distance)}`,
  ];
  if (!closed) parts.push(`Linha reta início-fim: ${formatDistance(straightLine)}`);
  parts.push(`Duração: ${formatDuration(durationSeconds)}`);
  parts.push(`Vel. média: ${avgSpeed.toFixed(1)} km/h`);
  if (closed && areaHectares > 0) parts.push(`Área: ${areaHectares.toFixed(2)} ha`);

  el('trail-summary-stats').innerHTML = parts.map((p) => `<div class="trail-summary-row">${p}</div>`).join('');
  el('trail-finalize-choice').classList.add('hidden');
  el('trail-finalize-summary').classList.remove('hidden');

  onSavedCallback?.();
}

// ---------- Public API ----------

export function resetTrailSetup(): void {
  showSetupScreen();
}

export function resetTrailActive(): void {
  resetActiveScreen();
  closeFinalizeModal();
}

export function initTrail({ onBack, onSaved }: TrailOnDoneOptions = {}): void {
  onBackCallback = onBack;
  onSavedCallback = onSaved;

  el('trail-setup-back-btn').addEventListener('click', () => onBackCallback?.());

  el('trail-start-btn').addEventListener('click', () => {
    if (!navigator.geolocation) return;
    startTracking();
  });

  el('trail-mark-btn').addEventListener('click', markPoint);

  el('trail-active-back-btn').addEventListener('click', () => {
    if (isTracking && !window.confirm('Sair sem salvar a trilha?')) return;
    resetActiveScreen();
    onBackCallback?.();
  });

  el('trail-pause-btn').addEventListener('click', togglePause);
  el('trail-finalize-btn').addEventListener('click', openFinalizeModal);

  document.querySelectorAll<HTMLButtonElement>('.trail-choice-card').forEach((card) => {
    card.addEventListener('click', () => {
      document.querySelectorAll<HTMLButtonElement>('.trail-choice-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedFinalizeChoice = card.dataset.choice as FinalizeChoice;
      el<HTMLButtonElement>('trail-finalize-save-btn').disabled = false;
    });
  });

  el('trail-finalize-cancel-btn').addEventListener('click', closeFinalizeModal);
  el('trail-finalize-save-btn').addEventListener('click', () => { saveTrail(); });
  el('trail-finalize-done-btn').addEventListener('click', () => {
    closeFinalizeModal();
    resetActiveScreen();
    onBackCallback?.();
  });
}
