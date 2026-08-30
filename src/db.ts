export interface PhotoRecord {
  id?: number;
  plotId: number;
  dataUrl: string;
  datetime: string;
  lat: number;
  lon: number;
  alt: number | null;
  acc: number;
  heading: number;
  address: string;
}

export interface TrackPoint {
  timestamp: string;
  lat: number;
  lon: number;
  alt: number | null;
  acc: number;
  speed: number | null;
}

export interface TrackRecord {
  id?: number;
  kind: 'video' | 'trail';
  name: string;
  color: string;
  closed: boolean;
  areaHectares?: number;
  videoBlob?: Blob;
  datetime: string;
  duration: number;
  distance: number;
  avgSpeed: number;
  maxSpeed: number;
  points: TrackPoint[];
  startAddress: string;
  endAddress: string;
}

export interface PlotRecord {
  id?: number;
  name: string;
  createdAt: string;
  finalizedAt: string | null;
}

const DB_NAME = 'geocamera-db';
const DB_VERSION = 3;
const PHOTO_STORE = 'photos';
const TRACK_STORE = 'tracks';
const PLOT_STORE = 'plots';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;

      if (!db.objectStoreNames.contains(PHOTO_STORE)) {
        const store = db.createObjectStore(PHOTO_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('datetime', 'datetime');
      }
      if (!db.objectStoreNames.contains(TRACK_STORE)) {
        const store = db.createObjectStore(TRACK_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('datetime', 'datetime');
      }
      if (!db.objectStoreNames.contains(PLOT_STORE)) {
        const store = db.createObjectStore(PLOT_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('createdAt', 'createdAt');
      }

      // Migrate photos captured before "areas" existed into a single default area.
      if (event.oldVersion < 3 && event.oldVersion > 0 && tx) {
        const plotStore = tx.objectStore(PLOT_STORE);
        const addPlotReq = plotStore.add({ name: 'Área 1', createdAt: new Date().toISOString(), finalizedAt: null });
        addPlotReq.onsuccess = () => {
          const defaultPlotId = addPlotReq.result as number;
          const photoStore = tx.objectStore(PHOTO_STORE);
          const cursorReq = photoStore.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
              const record = cursor.value;
              if (record.plotId === undefined) {
                record.plotId = defaultPlotId;
                cursor.update(record);
              }
              cursor.continue();
            }
          };
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function addPhoto(record: Omit<PhotoRecord, 'id'>): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, 'readwrite');
    const req = tx.objectStore(PHOTO_STORE).add(record);
    req.onsuccess = () => resolve(req.result as number);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllPhotos(): Promise<PhotoRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, 'readonly');
    const req = tx.objectStore(PHOTO_STORE).getAll();
    req.onsuccess = () => resolve((req.result as PhotoRecord[]).sort((a, b) => (b.id ?? 0) - (a.id ?? 0)));
    req.onerror = () => reject(req.error);
  });
}

export async function deletePhoto(id: number): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, 'readwrite');
    const req = tx.objectStore(PHOTO_STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function countPhotos(): Promise<number> {
  const photos = await getAllPhotos();
  return photos.length;
}

export async function addTrack(record: Omit<TrackRecord, 'id'>): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRACK_STORE, 'readwrite');
    const req = tx.objectStore(TRACK_STORE).add(record);
    req.onsuccess = () => resolve(req.result as number);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllTracks(): Promise<TrackRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRACK_STORE, 'readonly');
    const req = tx.objectStore(TRACK_STORE).getAll();
    req.onsuccess = () => resolve((req.result as TrackRecord[]).sort((a, b) => (b.id ?? 0) - (a.id ?? 0)));
    req.onerror = () => reject(req.error);
  });
}

export async function deleteTrack(id: number): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TRACK_STORE, 'readwrite');
    const req = tx.objectStore(TRACK_STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function addPlot(record: Omit<PlotRecord, 'id'>): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PLOT_STORE, 'readwrite');
    const req = tx.objectStore(PLOT_STORE).add(record);
    req.onsuccess = () => resolve(req.result as number);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllPlots(): Promise<PlotRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PLOT_STORE, 'readonly');
    const req = tx.objectStore(PLOT_STORE).getAll();
    req.onsuccess = () => resolve((req.result as PlotRecord[]).sort((a, b) => (a.id ?? 0) - (b.id ?? 0)));
    req.onerror = () => reject(req.error);
  });
}

export async function updatePlot(record: PlotRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PLOT_STORE, 'readwrite');
    const req = tx.objectStore(PLOT_STORE).put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getOrCreateActivePlot(): Promise<PlotRecord> {
  const plots = await getAllPlots();
  const active = plots.find((p) => p.finalizedAt === null);
  if (active) return active;
  const name = `Área ${plots.length + 1}`;
  const createdAt = new Date().toISOString();
  const id = await addPlot({ name, createdAt, finalizedAt: null });
  return { id, name, createdAt, finalizedAt: null };
}

export async function finalizeActivePlot(): Promise<void> {
  const plots = await getAllPlots();
  const active = plots.find((p) => p.finalizedAt === null);
  if (active) {
    await updatePlot({ ...active, finalizedAt: new Date().toISOString() });
  }
}
