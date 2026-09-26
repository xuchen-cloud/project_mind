export interface HomeIdentityValue {
  cover: "alpine" | "forest" | "custom";
  customDataUrl?: string;
  positionX: number;
  positionY: number;
  icon: string;
}

const DATABASE_NAME = "project-mind-home-identity";
const STORE_NAME = "identities";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readHomeIdentity(key: string): Promise<HomeIdentityValue | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => {
      const value = request.result as HomeIdentityValue | undefined;
      if (!value || !["alpine", "forest", "custom"].includes(value.cover) || !Number.isFinite(value.positionX) || !Number.isFinite(value.positionY)) { resolve(null); return; }
      resolve({ ...value, positionX: Math.max(0, Math.min(100, value.positionX)), positionY: Math.max(0, Math.min(100, value.positionY)) });
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
    transaction.onabort = () => { database.close(); reject(transaction.error); };
  });
}

export async function writeHomeIdentity(key: string, value: HomeIdentityValue): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(value, key);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error); };
    transaction.onabort = () => { database.close(); reject(transaction.error); };
  });
}

export async function resizeHomeCover(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  if (file.size > 20 * 1024 * 1024) throw new Error("图片不能超过 20 MB");
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1800 / bitmap.width, 900 / bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法处理封面图片");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.84);
  } finally {
    bitmap.close();
  }
}
