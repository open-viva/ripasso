// store.js persistenza leggera su file, zero dipendenze.
// salva piani già generati e preferenze di studio per studente

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');

export const DEFAULT_PREFERENCES = {
  avoid_days: [], // sottoinsieme di lun mar mer gio ven sab dom
  preferred_time: 'indifferente', // mattina | pomeriggio | sera | indifferente
  notes: '',
};

function fileFor(studentId) {
  const hash = createHash('sha256').update(String(studentId)).digest('hex').slice(0, 40);
  return path.join(DATA_DIR, `${hash}.json`);
}

export async function loadStore(studentId) {
  try {
    const raw = await readFile(fileFor(studentId), 'utf8');
    const data = JSON.parse(raw);
    return {
      preferences: { ...DEFAULT_PREFERENCES, ...(data.preferences || {}) },
      plans: data.plans && typeof data.plans === 'object' ? data.plans : {},
    };
  } catch {
    return { preferences: { ...DEFAULT_PREFERENCES }, plans: {} };
  }
}

export async function saveStore(studentId, data) {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  const body = JSON.stringify({
    preferences: data.preferences || DEFAULT_PREFERENCES,
    plans: data.plans || {},
  });
  await writeFile(fileFor(studentId), body, 'utf8');
}
