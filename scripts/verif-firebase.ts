/**
 * Vérifie l'accès Firestore du backend, sans toucher aux données réelles.
 *
 * Écrit un document `_health/verif`, le relit, puis le supprime. Si l'écriture
 * échoue, le compte de service, le projet ou le réseau sont en cause — avant
 * même de brancher les historiques.
 *
 * Prérequis (voir docs/FIREBASE.md) :
 *   FIREBASE_SERVICE_ACCOUNT=/chemin/vers/compte-de-service.json
 *   ou GOOGLE_APPLICATION_CREDENTIALS=/chemin/vers/compte-de-service.json
 *   FIREBASE_PROJECT_ID=altredige (facultatif si le JSON le contient)
 *
 * Usage : npm run verif-firebase
 */
import { readFileSync } from 'node:fs';
import { applicationDefault, cert, initializeApp, type Credential } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { loadEnvFile } from '../src/env.js';

loadEnvFile();

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
let projectId = process.env.FIREBASE_PROJECT_ID?.trim() || undefined;

let credential: Credential;
let source: string;

if (serviceAccountPath) {
  let json: { project_id?: string; client_email?: string };
  try {
    json = JSON.parse(readFileSync(serviceAccountPath, 'utf8')) as typeof json;
  } catch (error) {
    console.error(`\nImpossible de lire le compte de service : ${serviceAccountPath}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  projectId ??= json.project_id;
  credential = cert(json);
  source = `compte de service ${json.client_email ?? '(email inconnu)'}`;
} else if (adcPath) {
  credential = applicationDefault();
  source = `identifiants par défaut (${adcPath})`;
} else {
  console.error('\nAucun identifiant Firebase.');
  console.error('Définissez FIREBASE_SERVICE_ACCOUNT (chemin du JSON) ou');
  console.error('GOOGLE_APPLICATION_CREDENTIALS, puis relancez npm run verif-firebase.');
  console.error('La configuration web (apiKey, appId...) ne suffit pas côté serveur.');
  process.exit(1);
}

if (!projectId) {
  console.error('\nFIREBASE_PROJECT_ID est absent et le compte de service ne le fournit pas.');
  process.exit(1);
}

console.log('\n═══ Vérification Firebase / Firestore ═══\n');
console.log('Projet     :', projectId);
console.log('Identité   :', source);
console.log('');

const timer = setTimeout(() => {
  console.error('Délai dépassé (30 s) : Firestore injoignable depuis cette machine.');
  process.exit(1);
}, 30_000);

try {
  const app = initializeApp({ credential, projectId });
  const db = getFirestore(app);
  const ref = db.doc('_health/verif');

  await ref.set({ at: FieldValue.serverTimestamp(), service: 'lexcanvas' });
  const snapshot = await ref.get();
  const written = snapshot.exists && snapshot.get('service') === 'lexcanvas';
  await ref.delete();

  if (!written) {
    console.error('Écriture acceptée mais relecture incohérente.');
    process.exit(1);
  }

  console.log('Écriture   : ok');
  console.log('Relecture  : ok');
  console.log('Suppression: ok');
  console.log('\nVerdict : FIRESTORE OK\n');
  process.exit(0);
} catch (error) {
  const code = (error as { code?: number | string }).code;
  console.error('Échec :', error instanceof Error ? error.message : String(error));
  if (code === 5) console.error('Code 5 = NOT_FOUND : la base Firestore n’existe pas encore dans ce projet.');
  if (code === 7) console.error('Code 7 = PERMISSION_DENIED : le compte de service n’a pas le rôle Firestore.');
  if (code === 16) console.error('Code 16 = UNAUTHENTICATED : identifiants invalides ou expirés.');
  console.error('\nVerdict : FIRESTORE INDISPONIBLE\n');
  process.exit(1);
} finally {
  clearTimeout(timer);
}
