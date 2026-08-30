import { el } from './dom';
import { addPhoto, deletePhoto, addTrack, getOrCreateActivePlot, finalizeActivePlot, updatePlot, getAllPhotos, type TrackPoint, type PlotRecord } from './db';
import { themeColor } from './theme';
import { saveFile } from './save-file';

interface CompassOrientationEvent extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
}

interface DeviceOrientationEventConstructorIOS {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

interface InitCameraOptions {
  onBack?: () => void;
  onPhotoChange?: () => void;
}

const TUTORIAL_SEEN_KEY = 'geocamera_compass_tutorial_seen';

// The camera/HUD only opens once the GPS fix is this precise (or the user taps
// "Continuar mesmo assim") — avoids capturing points like the (0,0) Null Island bug.
const MIN_CAPTURE_ACCURACY_METERS = 30;

// Video capture is shelved for now — focus is the photo flow. Flip this back on
// (and restore the mode-toggle visibility below) to bring video mode back.
const VIDEO_MODE_ENABLED = false;

let mediaStream: MediaStream | null = null;
let geoWatchId: number | null = null;
let orientationHandlerAttached = false;
let calibrationTimer: ReturnType<typeof setTimeout> | null = null;

let currentLat = 0;
let currentLon = 0;
let hasGpsFix = false;
let currentAlt: number | null = null;
let currentAcc = 0;
let currentHeading = 0;
let displayedHeading = 0;
let headingLocked = false;
let currentAddress = 'Buscando...';
let lastLat: number | null = null;
let lastLon: number | null = null;
let currentSavedPhotoId: number | null = null;
let activePlot: PlotRecord | null = null;
let pendingFinalizePlot: PlotRecord | null = null;
let cameraActivated = false;
let gpsWaitSkipTimer: ReturnType<typeof setTimeout> | null = null;

let onBackCallback: (() => void) | undefined;
let onPhotoChangeCallback: (() => void) | undefined;

type CameraMode = 'photo' | 'video';
let currentMode: CameraMode = 'photo';

let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let isRecording = false;
let isPaused = false;
let recordingStartTime = 0;
let pausedAccumulatedMs = 0;
let pauseStartedAt = 0;
let trackPoints: TrackPoint[] = [];
let trackSampleTimer: ReturnType<typeof setInterval> | null = null;
let recTimerInterval: ReturnType<typeof setInterval> | null = null;
let totalTrackDistance = 0;
let maxSpeedKmh = 0;
let videoPreviewObjectUrl: string | null = null;

const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const RESUME_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>';

function getDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function formatDistanceLabel(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(2)} km`;
}

function computePlotPerimeter(points: { lat: number; lon: number }[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += getDistanceMeters(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  if (points.length >= 3) {
    total += getDistanceMeters(points[points.length - 1].lat, points[points.length - 1].lon, points[0].lat, points[0].lon);
  }
  return total;
}

function computePlotAreaHectares(points: { lat: number; lon: number }[]): number {
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

async function fetchAddress(lat: number, lon: number): Promise<void> {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`);
    if (!res.ok) throw new Error('HTTP error');
    const data = await res.json();
    if (data && data.display_name) {
      currentAddress = data.display_name;
      el('address').innerText = currentAddress;
    }
  } catch {
    currentAddress = 'Endereço indisponível';
    el('address').innerText = currentAddress;
  }
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

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(2)} km`;
}

async function startCamera(): Promise<void> {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    const video = el<HTMLVideoElement>('video-feed');
    video.srcObject = mediaStream;
    return new Promise((resolve) => {
      video.onloadedmetadata = () => {
        video.play();
        resolve();
      };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error('Erro na Câmera: ' + message);
  }
}

function showGpsWaitModal(): void {
  el('gps-wait-modal').style.display = 'flex';
  el('gps-wait-skip-btn').classList.add('hidden');
  el('gps-wait-accuracy').innerText = '-- m';
  gpsWaitSkipTimer = setTimeout(() => {
    el('gps-wait-skip-btn').classList.remove('hidden');
  }, 8000);
}

function hideGpsWaitModal(): void {
  el('gps-wait-modal').style.display = 'none';
  if (gpsWaitSkipTimer) {
    clearTimeout(gpsWaitSkipTimer);
    gpsWaitSkipTimer = null;
  }
}

function startGeolocation(): void {
  if (!navigator.geolocation) throw new Error('Geolocalização não suportada');
  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      currentLat = pos.coords.latitude;
      currentLon = pos.coords.longitude;
      currentAlt = pos.coords.altitude;
      currentAcc = pos.coords.accuracy;
      hasGpsFix = true;

      el('coords').innerText = `LAT ${currentLat.toFixed(6)} · LON ${currentLon.toFixed(6)}`;
      el('altitude').innerText = `${currentAlt !== null ? currentAlt.toFixed(1) + ' m' : '--'}`;
      el('acc-chip').innerText = `${currentAcc.toFixed(1)} m`;

      if (!cameraActivated) {
        el('gps-wait-accuracy').innerText = `${currentAcc.toFixed(1)} m`;
        if (currentAcc <= MIN_CAPTURE_ACCURACY_METERS) {
          cameraActivated = true;
          activateCameraAfterGps();
        }
      }

      if (lastLat === null || lastLon === null || getDistanceMeters(lastLat, lastLon, currentLat, currentLon) > 10) {
        lastLat = currentLat;
        lastLon = currentLon;
        fetchAddress(currentLat, currentLon);
      }
    },
    () => { el('coords').innerText = 'SINAL GPS PERDIDO'; },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
  );
}

// Compass ------------------------------------------------------------
function getScreenAngle(): number {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  const legacyOrientation = (window as unknown as { orientation?: number }).orientation;
  if (typeof legacyOrientation === 'number') return legacyOrientation;
  return 0;
}

function shortestDelta(from: number, to: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function cardinalFromHeading(h: number): string {
  const dirs = ['N', 'NE', 'L', 'SE', 'S', 'SO', 'O', 'NO'];
  const idx = Math.round((((h % 360) + 360) % 360) / 45) % 8;
  return dirs[idx];
}

function setNeedle(heading: number): void {
  const needle = el('compass-needle');
  const delta = shortestDelta(((displayedHeading % 360) + 360) % 360, heading);
  displayedHeading += delta;
  needle.style.transform = `rotate(${displayedHeading}deg)`;
  el('heading-value').innerText = `${Math.round(heading)}°`;
  el('heading-cardinal').innerText = cardinalFromHeading(heading);
}

let absoluteEventSeen = false;

function processHeadingEvent(event: DeviceOrientationEvent): void {
  const compassEvent = event as CompassOrientationEvent;
  let heading: number | null = null;

  if (typeof compassEvent.webkitCompassHeading === 'number' && !isNaN(compassEvent.webkitCompassHeading)) {
    heading = compassEvent.webkitCompassHeading;
  } else if (event.alpha !== null && event.alpha !== undefined) {
    const screenAngle = getScreenAngle();
    heading = 360 - event.alpha - screenAngle;
  }

  if (heading !== null && !isNaN(heading)) {
    heading = ((heading % 360) + 360) % 360;
    currentHeading = heading;

    if (!headingLocked) {
      headingLocked = true;
      el('compass-container').classList.remove('unavailable');
      if (calibrationTimer) { clearTimeout(calibrationTimer); calibrationTimer = null; }

      if (el('tutorial-modal').style.display === 'flex') {
        setTutorialStatus(true);
        setTimeout(completeTutorial, 1100);
      }
    }
    setNeedle(heading);
  }
}

function handleAbsoluteOrientation(event: DeviceOrientationEvent): void {
  // Some browsers fire an initial "absolute" event with no real sensor data yet
  // (alpha is null). Only treat the absolute source as alive once it reports a
  // usable reading — otherwise this permanently (and wrongly) disables the
  // plain-event fallback below.
  if (event.alpha !== null && event.alpha !== undefined) {
    absoluteEventSeen = true;
  }
  processHeadingEvent(event);
}

function handleRelativeOrientation(event: DeviceOrientationEvent): void {
  const compassEvent = event as CompassOrientationEvent;
  // iOS only ever fires the plain event, carrying true heading in webkitCompassHeading.
  const isIOSCompass = typeof compassEvent.webkitCompassHeading === 'number';
  // Some Android/Firefox builds flag true-north data on the plain event instead of
  // firing a separate "deviceorientationabsolute" event.
  const isFlaggedAbsolute = event.absolute === true;
  // Many Android WebViews advertise "deviceorientationabsolute" support (the feature
  // check passes) but never actually dispatch it on the device. Until we've seen a
  // real absolute event, accept the plain (possibly relative) reading so the compass
  // isn't stuck waiting forever for an event that will never arrive.
  if (isIOSCompass || isFlaggedAbsolute || !absoluteEventSeen) {
    processHeadingEvent(event);
  }
}

function requestOrientation(): void {
  el('compass-container').classList.add('unavailable');
  calibrationTimer = setTimeout(() => {
    if (!headingLocked) el('compass-container').classList.add('unavailable');
  }, 3000);

  const attach = () => {
    window.addEventListener('deviceorientationabsolute', handleAbsoluteOrientation as EventListener, true);
    window.addEventListener('deviceorientation', handleRelativeOrientation, true);
    orientationHandlerAttached = true;
  };

  const iosDeviceOrientation = DeviceOrientationEvent as unknown as DeviceOrientationEventConstructorIOS;
  if (typeof iosDeviceOrientation.requestPermission === 'function') {
    iosDeviceOrientation.requestPermission().then((res) => {
      if (res === 'granted') attach();
    }).catch(console.error);
  } else {
    attach();
  }
}
// ---------------------------------------------------------------------

function updateClock(): void {
  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeStr = now.toLocaleTimeString('pt-BR', { hour12: false });
  const clockEl = document.getElementById('clock-text');
  if (clockEl) clockEl.innerText = `${dateStr} ${timeStr}`;
  requestAnimationFrame(updateClock);
}

function showError(msg: string): void {
  el('error-message').innerText = msg;
  el('error-modal').style.display = 'flex';
  el('permission-modal').style.display = 'none';
  hideGpsWaitModal();
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string): void {
  const toast = el('camera-toast');
  toast.innerText = message;
  toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2800);
}

const CALIBRATED_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

function setTutorialStatus(calibrated: boolean): void {
  const status = el('tutorial-status');
  status.classList.toggle('calibrated', calibrated);
  status.innerHTML = calibrated
    ? `${CALIBRATED_ICON}Bússola calibrada`
    : '<span class="status-dot"></span>Calibrando…';
}

function showTutorial(): void {
  setTutorialStatus(headingLocked);
  el('tutorial-modal').style.display = 'flex';
}

function hideTutorial(): void {
  el('tutorial-modal').style.display = 'none';
}

function completeTutorial(): void {
  hideTutorial();
  localStorage.setItem(TUTORIAL_SEEN_KEY, '1');
}

async function handleCapture(): Promise<void> {
  if (!hasGpsFix) {
    showToast('Aguardando sinal de GPS… espere as coordenadas aparecerem antes de capturar.');
    return;
  }

  const video = el<HTMLVideoElement>('video-feed');
  const canvas = el<HTMLCanvasElement>('capture-canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const scale = canvas.height / 800;
  const hudWidth = 360 * scale;
  const hudHeight = 150 * scale;
  const paddingX = 18 * scale;
  const paddingY = 110 * scale;
  const hudX = paddingX;
  const hudY = canvas.height - hudHeight - paddingY;
  const radius = 12 * scale;

  const accentColor = themeColor('--accent', '#FFB100');
  const dangerColor = themeColor('--danger', '#FF4D4F');

  ctx.fillStyle = 'rgba(10, 10, 10, 0.7)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = 1 * scale;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(hudX, hudY, hudWidth, hudHeight, radius);
  else ctx.rect(hudX, hudY, hudWidth, hudHeight);
  ctx.fill();
  ctx.stroke();

  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  const textX = hudX + 16 * scale;
  let textY = hudY + 16 * scale;

  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeStr = now.toLocaleTimeString('pt-BR', { hour12: false });

  ctx.font = `600 ${14 * scale}px "Inter", -apple-system, sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(`${dateStr}  ${timeStr}`, textX, textY); textY += 22 * scale;

  ctx.font = `700 ${14 * scale}px "Inter", -apple-system, sans-serif`;
  ctx.fillStyle = accentColor;
  ctx.fillText(`LAT ${currentLat.toFixed(6)} · LON ${currentLon.toFixed(6)}`, textX, textY); textY += 22 * scale;

  ctx.font = `500 ${14 * scale}px "Inter", -apple-system, sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(`ALT ${currentAlt !== null ? currentAlt.toFixed(1) + ' m' : '--'}   ACC ${currentAcc.toFixed(1)} m`, textX, textY); textY += 22 * scale;

  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `500 ${11 * scale}px "Inter", -apple-system, sans-serif`;
  ctx.save();
  ctx.beginPath();
  ctx.rect(textX, textY, hudWidth - 95 * scale - 16 * scale, 15 * scale);
  ctx.clip();
  ctx.fillText(currentAddress, textX, textY);
  ctx.restore();

  const compassRadius = 36 * scale;
  const compassX = hudX + hudWidth - compassRadius - 16 * scale;
  const compassY = hudY + hudHeight / 2;

  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1.5 * scale;
  ctx.beginPath();
  ctx.arc(compassX, compassY, compassRadius, 0, 2 * Math.PI);
  ctx.globalAlpha = 0.6;
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.font = `700 ${12 * scale}px "Inter", -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = dangerColor;
  ctx.fillText('N', compassX, compassY - compassRadius + 11 * scale);
  ctx.fillStyle = accentColor;
  ctx.fillText('S', compassX, compassY + compassRadius - 11 * scale);
  ctx.fillText('L', compassX + compassRadius - 11 * scale, compassY);
  ctx.fillText('O', compassX - compassRadius + 11 * scale, compassY);

  ctx.save();
  ctx.translate(compassX, compassY);
  ctx.rotate(currentHeading * Math.PI / 180);

  ctx.fillStyle = dangerColor;
  ctx.beginPath();
  ctx.moveTo(-4 * scale, 0);
  ctx.lineTo(0, -compassRadius + 8 * scale);
  ctx.lineTo(4 * scale, 0);
  ctx.fill();

  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.moveTo(-4 * scale, 0);
  ctx.lineTo(0, compassRadius - 8 * scale);
  ctx.lineTo(4 * scale, 0);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, 0, 3 * scale, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();

  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);

  if (!activePlot) activePlot = await getOrCreateActivePlot();

  currentSavedPhotoId = await addPhoto({
    plotId: activePlot.id as number,
    dataUrl,
    datetime: now.toISOString(),
    lat: currentLat,
    lon: currentLon,
    alt: currentAlt,
    acc: currentAcc,
    heading: currentHeading,
    address: currentAddress,
  });
  onPhotoChangeCallback?.();
  await refreshPlotIndicator();

  el<HTMLImageElement>('preview-img').src = dataUrl;
  el('preview-datetime').innerText = `${dateStr} ${timeStr}`;
  el('preview-coords').innerText = `${currentLat.toFixed(5)}, ${currentLon.toFixed(5)}`;
  el('preview-modal').style.display = 'flex';

  const fileName = `geocamera_${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}.jpg`;
  el<HTMLButtonElement>('download-btn').onclick = () => {
    saveFile(dataUrl, fileName);
  };
}

// Video mode -----------------------------------------------------------
function setMode(mode: CameraMode): void {
  if (isRecording) return;
  currentMode = mode;

  document.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  el('capture-btn').classList.toggle('video-mode', mode === 'video');
  el('speed-row').hidden = mode !== 'video';
  el('distance-row').hidden = mode !== 'video';
  el('plot-indicator').classList.toggle('hidden', mode !== 'photo');
}

async function refreshPlotIndicator(): Promise<void> {
  activePlot = await getOrCreateActivePlot();
  const photos = await getAllPhotos();
  const count = photos.filter((p) => p.plotId === activePlot?.id).length;
  el('plot-indicator-text').innerText = `${activePlot.name} · ${count === 1 ? '1 ponto' : `${count} pontos`}`;
}

function pickVideoMimeType(): string | undefined {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return undefined;
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

function updateRecTimerDisplay(): void {
  const elapsedMs = Date.now() - recordingStartTime - pausedAccumulatedMs;
  el('rec-timer').innerText = formatDuration(elapsedMs / 1000);
}

function sampleTrackPoint(): void {
  if (currentAcc > 30) return; // discard noisy fixes per calibration guidance

  const point: TrackPoint = {
    timestamp: new Date().toISOString(),
    lat: currentLat,
    lon: currentLon,
    alt: currentAlt,
    acc: currentAcc,
    speed: null,
  };

  const last = trackPoints[trackPoints.length - 1];
  if (last) {
    const deltaMeters = getDistanceMeters(last.lat, last.lon, point.lat, point.lon);
    const deltaSeconds = (new Date(point.timestamp).getTime() - new Date(last.timestamp).getTime()) / 1000;
    totalTrackDistance += deltaMeters;
    if (deltaSeconds > 0) {
      const speedKmh = (deltaMeters / 1000) / (deltaSeconds / 3600);
      point.speed = speedKmh;
      maxSpeedKmh = Math.max(maxSpeedKmh, speedKmh);
      el('speed-value').innerText = `${speedKmh.toFixed(1)} km/h`;
    }
  }

  trackPoints.push(point);
  el('distance-value').innerText = `${formatDistance(totalTrackDistance)} · ${trackPoints.length} pontos`;
}

async function startRecording(): Promise<void> {
  if (!mediaStream || isRecording) return;

  if (typeof MediaRecorder === 'undefined') {
    showError('Gravação de vídeo não é suportada neste navegador.');
    return;
  }

  const mimeType = pickVideoMimeType();
  mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
  recordedChunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = finalizeRecording;
  mediaRecorder.start(1000);

  trackPoints = [];
  totalTrackDistance = 0;
  maxSpeedKmh = 0;
  pausedAccumulatedMs = 0;
  recordingStartTime = Date.now();
  isRecording = true;
  isPaused = false;

  sampleTrackPoint();
  trackSampleTimer = setInterval(sampleTrackPoint, 3000);
  recTimerInterval = setInterval(updateRecTimerDisplay, 1000);
  updateRecTimerDisplay();

  el('rec-indicator').classList.remove('hidden');
  el('mode-toggle').classList.add('hidden');
  el('pause-btn').classList.remove('hidden');
  el('pause-btn').innerHTML = PAUSE_ICON;
  el('capture-btn-stop-icon').classList.remove('hidden');
  el('speed-value').innerText = '0 km/h';
  el('distance-value').innerText = '0 m · 1 ponto';
}

function pauseRecording(): void {
  if (!isRecording || isPaused) return;
  mediaRecorder?.pause();
  isPaused = true;
  pauseStartedAt = Date.now();
  if (trackSampleTimer) { clearInterval(trackSampleTimer); trackSampleTimer = null; }
  el('pause-btn').innerHTML = RESUME_ICON;
}

function resumeRecording(): void {
  if (!isRecording || !isPaused) return;
  mediaRecorder?.resume();
  isPaused = false;
  pausedAccumulatedMs += Date.now() - pauseStartedAt;
  trackSampleTimer = setInterval(sampleTrackPoint, 3000);
  el('pause-btn').innerHTML = PAUSE_ICON;
}

function stopRecording(): void {
  if (!isRecording) return;
  mediaRecorder?.stop();
  isRecording = false;
  isPaused = false;

  if (trackSampleTimer) { clearInterval(trackSampleTimer); trackSampleTimer = null; }
  if (recTimerInterval) { clearInterval(recTimerInterval); recTimerInterval = null; }

  el('rec-indicator').classList.add('hidden');
  el('mode-toggle').classList.remove('hidden');
  el('pause-btn').classList.add('hidden');
  el('capture-btn-stop-icon').classList.add('hidden');
}

function discardRecordingSilently(): void {
  if (!isRecording) return;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
  }
  isRecording = false;
  isPaused = false;
  if (trackSampleTimer) { clearInterval(trackSampleTimer); trackSampleTimer = null; }
  if (recTimerInterval) { clearInterval(recTimerInterval); recTimerInterval = null; }
}

async function finalizeRecording(): Promise<void> {
  const durationSeconds = (Date.now() - recordingStartTime - pausedAccumulatedMs) / 1000;
  const blob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || 'video/webm' });

  const avgSpeed = totalTrackDistance > 0 && durationSeconds > 0
    ? (totalTrackDistance / 1000) / (durationSeconds / 3600)
    : 0;

  const first = trackPoints[0];
  const last = trackPoints[trackPoints.length - 1];
  const [startAddress, endAddress] = first && last
    ? await Promise.all([geocodeOnce(first.lat, first.lon), geocodeOnce(last.lat, last.lon)])
    : ['Endereço indisponível', 'Endereço indisponível'];

  const trackSnapshot = trackPoints.slice();

  el<HTMLVideoElement>('video-preview-player').src = '';
  if (videoPreviewObjectUrl) URL.revokeObjectURL(videoPreviewObjectUrl);
  videoPreviewObjectUrl = URL.createObjectURL(blob);
  el<HTMLVideoElement>('video-preview-player').src = videoPreviewObjectUrl;

  el('vstat-duration').innerText = formatDuration(durationSeconds);
  el('vstat-distance').innerText = formatDistance(totalTrackDistance);
  el('vstat-avg-speed').innerText = `${avgSpeed.toFixed(1)} km/h`;
  el('vstat-max-speed').innerText = `${maxSpeedKmh.toFixed(1)} km/h`;
  el('video-preview-modal').style.display = 'flex';

  el<HTMLButtonElement>('video-save-btn').onclick = async () => {
    await addTrack({
      kind: 'video',
      name: `Vídeo ${new Date(recordingStartTime).toLocaleDateString('pt-BR')}`,
      color: '#4A9EFF',
      closed: false,
      videoBlob: blob,
      datetime: new Date(recordingStartTime).toISOString(),
      duration: durationSeconds,
      distance: totalTrackDistance,
      avgSpeed,
      maxSpeed: maxSpeedKmh,
      points: trackSnapshot,
      startAddress,
      endAddress,
    });
    closeVideoPreview();
    onPhotoChangeCallback?.();
  };

  el<HTMLButtonElement>('video-download-btn').onclick = () => {
    saveFile(blob, `geocamera_video_${new Date(recordingStartTime).toISOString().replace(/[:.]/g, '-')}.webm`);
  };
}

function closeVideoPreview(): void {
  el('video-preview-modal').style.display = 'none';
  el<HTMLVideoElement>('video-preview-player').pause();
  el<HTMLVideoElement>('video-preview-player').src = '';
  if (videoPreviewObjectUrl) {
    URL.revokeObjectURL(videoPreviewObjectUrl);
    videoPreviewObjectUrl = null;
  }
}
// ---------------------------------------------------------------------

async function checkPermissionsGranted(): Promise<boolean> {
  if (!navigator.permissions?.query) return false;
  try {
    const [cam, geo] = await Promise.all([
      navigator.permissions.query({ name: 'camera' as PermissionName }),
      navigator.permissions.query({ name: 'geolocation' as PermissionName }),
    ]);
    return cam.state === 'granted' && geo.state === 'granted';
  } catch {
    return false;
  }
}

async function beginCameraSession(): Promise<void> {
  try {
    el('permission-modal').style.display = 'none';
    cameraActivated = false;
    showGpsWaitModal();
    startGeolocation();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function activateCameraAfterGps(): Promise<void> {
  try {
    await startCamera();
    requestOrientation();
    hideGpsWaitModal();
    el('top-bar').style.display = 'flex';
    el('hud-overlay').style.display = 'flex';
    el('capture-shell').classList.remove('hidden');
    if (VIDEO_MODE_ENABLED) el('mode-toggle').classList.remove('hidden');
    setMode('photo');
    await refreshPlotIndicator();

    if (!localStorage.getItem(TUTORIAL_SEEN_KEY)) {
      setTimeout(showTutorial, 600);
    }
  } catch (err) {
    cameraActivated = false;
    showError(err instanceof Error ? err.message : String(err));
  }
}

async function maybeAutoStartCamera(): Promise<void> {
  const granted = await checkPermissionsGranted();
  // Guard against a race with a manual tap on "Começar" that may have already fired.
  if (granted && el('permission-modal').style.display === 'flex') {
    await beginCameraSession();
  }
}

export function resetCameraUI(): void {
  el('permission-modal').style.display = 'flex';
  el('error-modal').style.display = 'none';
  el('preview-modal').style.display = 'none';
  el('tutorial-modal').style.display = 'none';
  el('video-preview-modal').style.display = 'none';
  el('plot-finalized-modal').style.display = 'none';
  el('plot-name-modal').style.display = 'none';
  hideGpsWaitModal();
  el('camera-toast').classList.add('hidden');
  el('top-bar').style.display = 'none';
  el('hud-overlay').style.display = 'none';
  el('capture-shell').classList.add('hidden');
  el('mode-toggle').classList.add('hidden');
  el('rec-indicator').classList.add('hidden');
  el('pause-btn').classList.add('hidden');
  el('capture-btn-stop-icon').classList.add('hidden');
  el('plot-indicator').classList.add('hidden');
  headingLocked = false;
  displayedHeading = 0;
  currentSavedPhotoId = null;
  activePlot = null;
  pendingFinalizePlot = null;
  cameraActivated = false;
  el('compass-container').classList.add('unavailable');
  setMode('photo');
  maybeAutoStartCamera();
}

export function stopCamera(): void {
  discardRecordingSilently();
  closeVideoPreview();

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (geoWatchId !== null) {
    navigator.geolocation.clearWatch(geoWatchId);
    geoWatchId = null;
  }
  if (orientationHandlerAttached) {
    window.removeEventListener('deviceorientationabsolute', handleAbsoluteOrientation as EventListener, true);
    window.removeEventListener('deviceorientation', handleRelativeOrientation, true);
    orientationHandlerAttached = false;
  }
  if (calibrationTimer) { clearTimeout(calibrationTimer); calibrationTimer = null; }
  absoluteEventSeen = false;
  hasGpsFix = false;
  lastLat = null;
  lastLon = null;
  hideGpsWaitModal();
}

export function initCamera({ onBack, onPhotoChange }: InitCameraOptions = {}): void {
  onBackCallback = onBack;
  onPhotoChangeCallback = onPhotoChange;

  requestAnimationFrame(updateClock);

  el('camera-back-btn').addEventListener('click', () => {
    onBackCallback?.();
  });

  el('start-btn').addEventListener('click', beginCameraSession);

  el('compass-help-btn').addEventListener('click', showTutorial);

  el('tutorial-dismiss-btn').addEventListener('click', completeTutorial);

  document.querySelectorAll<HTMLButtonElement>('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode as CameraMode | undefined;
      if (mode) setMode(mode);
    });
  });

  el('plot-finalize-btn').addEventListener('click', async () => {
    const btn = el<HTMLButtonElement>('plot-finalize-btn');
    if (btn.disabled) return;
    const finishedPlot = activePlot ?? await getOrCreateActivePlot();
    pendingFinalizePlot = finishedPlot;
    const nameInput = el<HTMLInputElement>('plot-name-input');
    nameInput.value = finishedPlot.name;
    el('plot-name-modal').style.display = 'flex';
    setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
  });

  el('plot-name-cancel-btn').addEventListener('click', () => {
    pendingFinalizePlot = null;
    el('plot-name-modal').style.display = 'none';
  });

  el('plot-name-confirm-btn').addEventListener('click', async () => {
    const plot = pendingFinalizePlot;
    if (!plot) return;
    const btn = el<HTMLButtonElement>('plot-name-confirm-btn');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const typedName = el<HTMLInputElement>('plot-name-input').value.trim();
      const finalName = typedName || plot.name;
      if (finalName !== plot.name && plot.id !== undefined) {
        await updatePlot({ ...plot, name: finalName });
      }

      const finishedPhotos = (await getAllPhotos())
        .filter((p) => p.plotId === plot.id)
        .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

      await finalizeActivePlot();
      activePlot = null;
      pendingFinalizePlot = null;
      onPhotoChangeCallback?.();
      btn.disabled = false;
      el('plot-name-modal').style.display = 'none';

      const perimeter = computePlotPerimeter(finishedPhotos);
      const hectares = computePlotAreaHectares(finishedPhotos);
      const parts = [finishedPhotos.length === 1 ? '1 ponto' : `${finishedPhotos.length} pontos`];
      if (perimeter > 0) parts.push(formatDistanceLabel(perimeter));
      if (hectares > 0) parts.push(`${hectares.toFixed(2)} ha`);

      el('plot-finalized-title').innerText = `${finalName} finalizada`;
      el('plot-finalized-summary').innerText = parts.join(' · ');
      el('plot-finalized-modal').style.display = 'flex';
    } catch (err) {
      btn.disabled = false;
      showError('Não foi possível finalizar a área: ' + (err instanceof Error ? err.message : String(err)));
    }
  });

  el('plot-finalized-ok-btn').addEventListener('click', () => {
    el('plot-finalized-modal').style.display = 'none';
    onBackCallback?.();
  });

  el('gps-wait-skip-btn').addEventListener('click', () => {
    if (cameraActivated) return;
    cameraActivated = true;
    activateCameraAfterGps();
  });

  el('capture-btn').addEventListener('click', () => {
    if (currentMode === 'photo') {
      handleCapture();
    } else if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  el('pause-btn').addEventListener('click', () => {
    if (isPaused) resumeRecording();
    else pauseRecording();
  });

  el('retake-btn').addEventListener('click', async () => {
    if (currentSavedPhotoId !== null) {
      await deletePhoto(currentSavedPhotoId);
      currentSavedPhotoId = null;
      onPhotoChangeCallback?.();
      await refreshPlotIndicator();
    }
    el('preview-modal').style.display = 'none';
  });

  el('keep-btn').addEventListener('click', () => {
    currentSavedPhotoId = null;
    el('preview-modal').style.display = 'none';
  });

  el('video-discard-btn').addEventListener('click', closeVideoPreview);
}
