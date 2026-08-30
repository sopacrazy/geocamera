import { el } from './dom';
import { addTrack, type TrackPoint } from './db';

const TRAIL_COLORS = ['#4A9EFF', '#FF9F4A', '#B26AFF', '#FF4D6A', '#4AD9C0', '#D4A017'];
const MIN_ACCURACY_METERS = 30;
const MIN_INTERVAL_M = 5;
const MAX_INTERVAL_M = 500;
const DEFAULT_INTERVAL_M = 10;

type FinalizeChoice = 'open' | 'closed';

interface TrailOnDoneOptions {
  onBack?: () => void;
  onSaved?: () => void;
}

let watchId: number | null = null;
let isTracking = false;
let isPaused = false;
let hasGpsFix = false;

let intervalMeters = DEFAULT_INTERVAL_M;
let trailName = '';
let trailColor = TRAIL_COLORS[0];

let points: TrackPoint[] = [];
let accumulatedSinceLastPoint = 0;
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

function updateIntervalLabel(): void {
  el('trail-interval-label').innerText = `Registrar 1 ponto a cada ${intervalMeters} m`;
}

function showSetupScreen(): void {
  intervalMeters = DEFAULT_INTERVAL_M;
  trailName = '';
  el<HTMLInputElement>('trail-interval-slider').value = String(intervalMeters);
  el<HTMLInputElement>('trail-interval-input').value = String(intervalMeters);
  el<HTMLInputElement>('trail-name-input').value = '';
  el<HTMLInputElement>('trail-name-input').placeholder = defaultTrailName();
  updateIntervalLabel();
}

function clampInterval(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_INTERVAL_M;
  return Math.min(MAX_INTERVAL_M, Math.max(MIN_INTERVAL_M, Math.round(value / 5) * 5));
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

function registerPoint(): void {
  const point: TrackPoint = {
    timestamp: new Date().toISOString(),
    lat: currentLat,
    lon: currentLon,
    alt: currentAlt,
    acc: currentAcc,
    speed: null,
  };

  const last = points[points.length - 1];
  if (last) {
    const deltaMeters = getDistanceMeters(last.lat, last.lon, point.lat, point.lon);
    const deltaSeconds = (new Date(point.timestamp).getTime() - new Date(last.timestamp).getTime()) / 1000;
    totalDistance += deltaMeters;
    if (deltaSeconds > 0) {
      const speedKmh = (deltaMeters / 1000) / (deltaSeconds / 3600);
      point.speed = speedKmh;
      maxSpeedKmh = Math.max(maxSpeedKmh, speedKmh);
    }
  }

  points.push(point);
  updateLiveStats();
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

  if (points.length === 0) {
    registerPoint();
    updateLiveStats();
    return;
  }

  const last = points[points.length - 1];
  const deltaFromLast = getDistanceMeters(last.lat, last.lon, currentLat, currentLon);
  accumulatedSinceLastPoint = deltaFromLast;

  if (accumulatedSinceLastPoint >= intervalMeters) {
    registerPoint();
    accumulatedSinceLastPoint = 0;
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

  points = [];
  accumulatedSinceLastPoint = 0;
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
  points = [];
  el('trail-signal-warning').classList.add('hidden');
  el('trail-toast').classList.add('hidden');
}

// ---------- Finalize flow ----------

function openFinalizeModal(): void {
  if (points.length < 2) {
    const remaining = 2 - points.length;
    showTrailToast(
      points.length === 0
        ? 'Ainda sem pontos registrados. A precisão do GPS pode estar ruim demais (veja o card "Precisão GPS") — pontos só contam com precisão melhor que 30 m.'
        : `Faltam ${remaining} ponto${remaining > 1 ? 's' : ''} para poder finalizar (mínimo de 2).`
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

  const durationSeconds = (Date.now() - startTime - pausedAccumulatedMs) / 1000;
  let distance = totalDistance;
  if (closed && points.length >= 3) {
    const first = points[0];
    const last = points[points.length - 1];
    distance += getDistanceMeters(last.lat, last.lon, first.lat, first.lon);
  }
  const avgSpeed = distance > 0 && durationSeconds > 0 ? (distance / 1000) / (durationSeconds / 3600) : 0;
  const areaHectares = closed ? computeAreaHectares(points) : 0;

  const first = points[0];
  const last = points[points.length - 1];
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
    startAddress,
    endAddress,
  });

  const straightLine = getDistanceMeters(first.lat, first.lon, last.lat, last.lon);
  const parts = [
    `${points.length} pontos`,
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

  const slider = el<HTMLInputElement>('trail-interval-slider');
  const numberInput = el<HTMLInputElement>('trail-interval-input');
  slider.addEventListener('input', () => {
    intervalMeters = clampInterval(Number(slider.value));
    numberInput.value = String(intervalMeters);
    updateIntervalLabel();
  });
  numberInput.addEventListener('change', () => {
    intervalMeters = clampInterval(Number(numberInput.value));
    slider.value = String(intervalMeters);
    numberInput.value = String(intervalMeters);
    updateIntervalLabel();
  });

  el('trail-start-btn').addEventListener('click', () => {
    if (!navigator.geolocation) return;
    startTracking();
  });

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
