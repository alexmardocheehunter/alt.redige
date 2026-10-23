/**
 * Active la politique TTL Firestore sur `histories.expires_at`.
 *
 * **Prérequis : offre Blaze (facturation activée).** Sur l'offre Spark, Google
 * répond `403 — Project ... has billing disabled`. Dans ce cas, utiliser
 * `npm run purge-history` (à planifier) pour appliquer la conservation.
 *
 * Firestore applique le TTL à un **groupe de collections** ; la configuration
 * se fait sur le champ `expires_at` du groupe `histories`. La console Firebase
 * propose la même opération, mais ce script permet de la faire avec le compte
 * de service, sans `gcloud`.
 *
 * Usage : npm run setup-ttl
 *
 * Le script crée un document technique dans `users/_ttl_verif/histories` si le
 * champ n'existe pas encore, puis le supprime. Aucune donnée utilisateur n'est
 * lue ni modifiée.
 */
import { existsSync, readFileSync } from 'node:fs';
import { applicationDefault, cert, initializeApp, type Credential } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { GoogleAuth } from 'google-auth-library';
import { loadEnvFile } from '../src/env.js';

loadEnvFile();

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
let projectId = process.env.FIREBASE_PROJECT_ID?.trim() || undefined;

let credential: Credential;
let credentialJson: { client_email?: string; private_key?: string } | null = null;

if (serviceAccountPath) {
  if (!existsSync(serviceAccountPath)) {
    console.error(`\nCompte de service introuvable : ${serviceAccountPath}`);
    process.exit(1);
  }
  try {
    credentialJson = JSON.parse(readFileSync(serviceAccountPath, 'utf8')) as typeof credentialJson;
  } catch {
    console.error('\nLe fichier FIREBASE_SERVICE_ACCOUNT n’est pas un JSON valide.');
    process.exit(1);
  }
  projectId ??= (credentialJson as { project_id?: string }).project_id;
  credential = cert(credentialJson);
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

console.log('\n═══ Activation du TTL Firestore ═══\n');
console.log('Projet     :', projectId);
console.log('Champ      : histories.expires_at');
console.log('');

const resource = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}`
  + `/databases/${encodeURIComponent('(default)')}`
  + `/collectionGroups/${encodeURIComponent('histories')}`
  + `/fields/${encodeURIComponent('expires_at')}`;

let accessToken: string | null = null;
try {
  const googleAuth = credentialJson?.client_email && credentialJson?.private_key
    ? new GoogleAuth({
      credentials: {
        client_email: credentialJson.client_email,
        private_key: credentialJson.private_key,
      },
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    : new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  accessToken = await googleAuth.getAccessToken();
} catch (error) {
  console.error('Impossible d’obtenir un jeton OAuth :', error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (!accessToken) {
  console.error('Jeton OAuth vide.');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
};

async function patchTtl(): Promise<Response> {
  return fetch(`${resource}?updateMask=ttlConfig`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ ttlConfig: {} }),
    signal: AbortSignal.timeout(20_000),
  });
}

async function readTtl(): Promise<{ state?: string } | null> {
  const response = await fetch(resource, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) return null;
  const payload = await response.json() as { ttlConfig?: { state?: string } };
  return payload.ttlConfig ?? null;
}

const app = initializeApp({ credential, projectId });
const db = getFirestore(app);
const placeholder = db.doc('users/_ttl_verif/histories/placeholder');
let placeholderCreated = false;
let exitCode = 1;

try {
  let response = await patchTtl();

  if (response.status === 404) {
    // Le champ n'existe pas encore : un document portant `expires_at` dans le
    // groupe de collections permet à l'API Admin de créer la configuration.
    console.log('Champ absent : création d’un document technique…');
    await placeholder.set({
      expires_at: Timestamp.fromMillis(Date.now() + 24 * 60 * 60 * 1000),
      created_at: Timestamp.now(),
      purpose: 'ttl_setup',
    });
    placeholderCreated = true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    response = await patchTtl();
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: { message?: string } };
    const message = payload.error?.message ?? 'inconnu';
    console.error(`Échec HTTP ${response.status} : ${message}`);
    if (message.toLowerCase().includes('billing disabled')) {
      console.error('');
      console.error('La politique TTL Firestore exige l’offre Blaze (facturation activée).');
      console.error('Sur l’offre Spark, planifiez plutôt : npm run purge-history');
      console.error('La conservation de 90 jours reste appliquée par les lectures,');
      console.error('qui traitent un document expiré comme absent.');
    }
    exitCode = 1;
  } else {
    const payload = await response.json() as { ttlConfig?: { state?: string } };
    let state = payload.ttlConfig?.state ?? 'CREATING';
    console.log('Configuration demandée :', state);

    // Le passage à ACTIVE peut prendre quelques secondes.
    for (let attempt = 0; attempt < 10 && state !== 'ACTIVE'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const current = await readTtl();
      if (current?.state) state = current.state;
    }

    console.log('État final :', state);
    if (state === 'ACTIVE' || state === 'CREATING') {
      console.log('\nVerdict : TTL ACTIVÉ (ou en cours d’activation)\n');
      exitCode = 0;
    } else {
      console.error('\nVerdict : TTL NON ACTIVÉ\n');
      exitCode = 1;
    }
  }
} catch (error) {
  console.error('Échec :', error instanceof Error ? error.message : String(error));
  exitCode = 1;
} finally {
  if (placeholderCreated) {
    try {
      await placeholder.delete();
      console.log('Document technique supprimé.');
    } catch {
      console.error('Attention : le document technique n’a pas pu être supprimé.');
    }
  }
  process.exit(exitCode);
}
