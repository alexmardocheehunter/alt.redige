/**
 * Vérifie les routes d'historiques contre un serveur réel et Firestore.
 *
 * Prérequis :
 *   - le serveur tourne avec AUTH_MODE=firebase|hybrid et HISTORY_ENABLED=1 ;
 *   - HISTORY_TEST_URL (par défaut http://localhost:3123) ;
 *   - FIREBASE_PROJECT_ID, FIREBASE_SERVICE_ACCOUNT, FIREBASE_WEB_API_KEY.
 *
 * Le script crée un utilisateur Firebase de test, écrit un historique
 * technique, le relit, le liste, le supprime, puis nettoie l'utilisateur et
 * tout document résiduel. Aucun jeton n'est affiché.
 *
 * Usage : npm run verif-history
 */
import { existsSync, readFileSync } from 'node:fs';
import { applicationDefault, cert, initializeApp, type Credential } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { loadEnvFile } from '../src/env.js';

loadEnvFile();

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
let projectId = process.env.FIREBASE_PROJECT_ID?.trim() || undefined;
const webApiKey = process.env.FIREBASE_WEB_API_KEY?.trim();
const baseUrl = (process.env.HISTORY_TEST_URL?.trim() || 'http://localhost:3123').replace(/\/$/, '');

let credential: Credential;

if (serviceAccountPath) {
  if (!existsSync(serviceAccountPath)) {
    console.error(`\nCompte de service introuvable : ${serviceAccountPath}`);
    process.exit(1);
  }
  let json: { project_id?: string; client_email?: string };
  try {
    json = JSON.parse(readFileSync(serviceAccountPath, 'utf8')) as typeof json;
  } catch {
    console.error('\nLe fichier FIREBASE_SERVICE_ACCOUNT n’est pas un JSON valide.');
    process.exit(1);
  }
  projectId ??= json.project_id;
  credential = cert(json);
} else if (adcPath) {
  credential = applicationDefault();
} else {
  console.error('\nAucun identifiant Firebase.');
  console.error('Définissez FIREBASE_SERVICE_ACCOUNT (chemin du JSON), puis relancez.');
  process.exit(1);
}

if (!projectId) {
  console.error('\nFIREBASE_PROJECT_ID est absent et le compte de service ne le fournit pas.');
  process.exit(1);
}

if (!webApiKey) {
  console.error('\nFIREBASE_WEB_API_KEY est absent.');
  console.error('Récupérez la clé web dans la console Firebase :');
  console.error('Paramètres du projet → Général → Vos applications → Clé d’API Web.');
  process.exit(1);
}

console.log('\n═══ Vérification des historiques ═══\n');
console.log('Projet   :', projectId);
console.log('Serveur  :', baseUrl);
console.log('');

const app = initializeApp({ credential, projectId });
const auth = getAuth(app);
const db = getFirestore(app);
const uid = `verif-history-${Date.now()}`;
const historyId = `verif-${Date.now()}`;
let testUserCreated = false;
let exitCode = 1;

async function signIn(): Promise<string> {
  const customToken = await auth.createCustomToken(uid);
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(webApiKey!)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const payload = await response.json().catch(() => ({})) as {
    idToken?: unknown;
    error?: { message?: string };
  };
  if (!response.ok || typeof payload.idToken !== 'string') {
    throw new Error(`échange du jeton custom impossible (HTTP ${response.status}, ${payload.error?.message ?? 'sans détail'})`);
  }
  testUserCreated = true;
  return payload.idToken;
}

function historyUrl(id?: string): string {
  return id
    ? `${baseUrl}/api/history/${encodeURIComponent(id)}`
    : `${baseUrl}/api/history`;
}

async function call(path: string, idToken: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(15_000),
  });
}

async function bodyOf(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

const body = {
  title: 'Vérification technique',
  contract_type: 'verif',
  markdown: '# Vérification\n\nDocument technique, sans donnée personnelle.',
  version: 1,
  messages: [
    { role: 'user', content: 'Vérification technique.' },
    { role: 'assistant', content: 'Historique de test.' },
  ],
};

try {
  const idToken = await signIn();
  console.log('Authentification Firebase : ok');

  const putResponse = await call(historyUrl(historyId), idToken, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (putResponse.status !== 200) {
    console.error(`PUT : échec HTTP ${putResponse.status}`);
    console.error(JSON.stringify(await bodyOf(putResponse)));
    throw new Error('PUT');
  }
  const putPayload = await bodyOf(putResponse) as { id?: string; updated_at?: string };
  if (putPayload.id !== historyId || typeof putPayload.updated_at !== 'string') {
    throw new Error('PUT : réponse inattendue');
  }
  console.log('PUT      : ok');

  const listResponse = await call(historyUrl(), idToken);
  if (listResponse.status !== 200) {
    console.error(`GET liste : échec HTTP ${listResponse.status}`);
    throw new Error('GET liste');
  }
  const listPayload = await bodyOf(listResponse) as { items?: Array<{ id?: string }> };
  if (!Array.isArray(listPayload.items) || !listPayload.items.some((item) => item.id === historyId)) {
    throw new Error('GET liste : historique absent');
  }
  console.log('GET liste : ok');

  const getResponse = await call(historyUrl(historyId), idToken);
  if (getResponse.status !== 200) {
    console.error(`GET : échec HTTP ${getResponse.status}`);
    throw new Error('GET');
  }
  const record = await bodyOf(getResponse) as { title?: string; markdown?: string };
  if (record.title !== body.title || record.markdown !== body.markdown) {
    throw new Error('GET : contenu inattendu');
  }
  console.log('GET      : ok');

  const deleteResponse = await call(historyUrl(historyId), idToken, { method: 'DELETE' });
  if (deleteResponse.status !== 204) {
    console.error(`DELETE : échec HTTP ${deleteResponse.status}`);
    throw new Error('DELETE');
  }
  console.log('DELETE   : ok');

  const missingResponse = await call(historyUrl(historyId), idToken);
  if (missingResponse.status !== 404) {
    console.error(`GET après DELETE : HTTP ${missingResponse.status} (404 attendu)`);
    throw new Error('GET après DELETE');
  }
  console.log('GET 404  : ok');

  console.log('\nVerdict : HISTORIQUES OK\n');
  exitCode = 0;
} catch (error) {
  console.error('Échec :', error instanceof Error ? error.message : String(error));
  console.error('Vérifiez que le serveur tourne avec HISTORY_ENABLED=1 et AUTH_MODE=firebase|hybrid.');
} finally {
  // Nettoyage : document résiduel puis utilisateur de test.
  try {
    await db.doc(`users/${uid}/histories/${historyId}`).delete();
  } catch {
    console.error('Attention : le document de test n’a pas pu être supprimé.');
    exitCode = 1;
  }
  if (testUserCreated) {
    try {
      await auth.deleteUser(uid);
      console.log('Utilisateur de test supprimé.');
    } catch {
      console.error(`Attention : l’utilisateur de test ${uid} n’a pas pu être supprimé.`);
      exitCode = 1;
    }
  }
}

process.exit(exitCode);
