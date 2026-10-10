// IndexedDB persistence: projects and photos (image blobs + GPS metadata).

const DB_NAME = 'geospotting-camera';
const DB_VERSION = 1;
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('projects', { keyPath: 'id' });
      const photos = db.createObjectStore('photos', { keyPath: 'id' });
      photos.createIndex('projectId', 'projectId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

const uid = () => crypto.randomUUID();

export async function listProjects() {
  const projects = await done((await store('projects')).getAll());
  const index = (await store('photos')).index('projectId');
  await Promise.all(projects.map(async (p) => { p.photoCount = await done(index.count(p.id)); }));
  return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id) {
  return done((await store('projects')).get(id));
}

export async function createProject(name) {
  const now = Date.now();
  const project = { id: uid(), name, createdAt: now, updatedAt: now, seq: 0 };
  await done((await store('projects', 'readwrite')).put(project));
  return project;
}

export async function updateProject(project) {
  project.updatedAt = Date.now();
  await done((await store('projects', 'readwrite')).put(project));
  return project;
}

export async function deleteProject(id) {
  const tx = (await open()).transaction(['projects', 'photos'], 'readwrite');
  tx.objectStore('projects').delete(id);
  const keys = await done(tx.objectStore('photos').index('projectId').getAllKeys(id));
  keys.forEach((k) => tx.objectStore('photos').delete(k));
  return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}

/** Adds a photo and bumps the project's sequence counter atomically. */
export async function addPhoto(projectId, photo) {
  const tx = (await open()).transaction(['projects', 'photos'], 'readwrite');
  const project = await done(tx.objectStore('projects').get(projectId));
  project.seq = (project.seq || 0) + 1;
  project.updatedAt = Date.now();
  const record = { ...photo, id: uid(), projectId, seq: project.seq };
  tx.objectStore('projects').put(project);
  tx.objectStore('photos').put(record);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  return record;
}

/** Removes every project and photo. */
export async function deleteAll() {
  const tx = (await open()).transaction(['projects', 'photos'], 'readwrite');
  tx.objectStore('projects').clear();
  tx.objectStore('photos').clear();
  return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}

export async function countPhotos() {
  return done((await store('photos')).count());
}

export async function listPhotos(projectId) {
  const photos = await done((await store('photos')).index('projectId').getAll(projectId));
  return photos.sort((a, b) => a.seq - b.seq);
}

export async function getPhoto(id) {
  return done((await store('photos')).get(id));
}

export async function deletePhoto(id) {
  await done((await store('photos', 'readwrite')).delete(id));
}

export async function updatePhoto(photo) {
  await done((await store('photos', 'readwrite')).put(photo));
  return photo;
}
