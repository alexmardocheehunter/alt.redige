/**
 * Vérifie la chaîne d'authentification Firebase de bout en bout, sans navigateur.
 *
 * 1. crée un jeton custom pour un utilisateur de test ;
 * 2. l'échange contre un ID token via l'API Identity Toolkit (clé web publique) ;
 * 3. vérifie l'ID token avec le même `FirebaseTokenVerifier` que le serveur ;
 * 4. supprime l'utilisateur de test.
 *
 * Prérequis :
 *   FIREBASE_PROJECT_ID=altredige
 *   FIREBASE_SERVICE_ACCOUNT=/chemin/compte-de-service.json
 *   FIREBASE_WEB_API_KEY=...   (clé web publique, Console → Paramètres du projet)
 *
 * Usage : npm run verif-auth
 *
 * Aucun jeton n'est affiché ni journalisé.
 */
import { readFileSync } from 'node:fs';
import { applicationDefault, cert, initializeApp, type Credential } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { loadEnvFile } from '../src/env.js';
import { FirebaseTokenVerifier } from '../src/middleware/auth.js';

loadEnvFile();

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
let projectId = process.env.FIREBASE_PROJECT_ID?.trim() || undefined;
const webApiKey = process.env.FIREBASE_WEB_API_KEY?.trim();

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
  console.error('Ajoutez-la à .env (elle est publique), puis relancez npm run verif-auth.');
  process.exit(1);
}

console.log('\n═══ Vérification Firebase / authentification ═══\n');
console.log('Projet     :', projectId);
console.log('Identité   :', source);
console.log('');

const uid = `verif-${Date.now()}`;
let testUserCreated = false;
let exitCode = 0;

const timer = setTimeout(() => {
  console.error('Délai dépassé (45 s) : Firebase Auth injoignable depuis cette machine.');
  process.exit(1);
}, 45_000);

try {
  const app = initializeApp({ credential, projectId });
  const auth = getAuth(app);

  const customToken = await auth.createCustomToken(uid);

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(webApiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      signal: AbortSignal.timeout(20_000),
    },
  );

  const payload = await response.json().catch(() => ({})) as {
    idToken?: unknown;
    localId?: unknown;
    error?: { message?: string };
  };

  if (!response.ok) {
    console.error(`Échec de l’échange du jeton custom : HTTP ${response.status}`);
    console.error(`Code Firebase : ${payload.error?.message ?? 'inconnu'}`);
    console.error('Vérifiez que Firebase Authentication est activé et que la clé web est correcte.');
    exitCode = 1;
  } else {
    testUserCreated = true;
    const idToken = typeof payload.idToken === 'string' ? payload.idToken : null;
    if (!idToken) {
      console.error('Réponse sans idToken.');
      exitCode = 1;
    } else {
      console.log('Jeton custom : créé');
      console.log('Échange      : ok');

      const verifier = new FirebaseTokenVerifier((token) => auth.verifyIdToken(token));
      const result = await verifier.verify(idToken);
      if (!result.ok) {
        console.error(`Vérification : échec (${result.reason ?? 'inconnu'})`);
        exitCode = 1;
      } else if (result.identity !== uid) {
        console.error('Vérification : uid inattendu.');
        exitCode = 1;
      } else {
        console.log('Vérification : ok (uid conforme)');
        console.log('\nVerdict : AUTH OK\n');
      }
    }
  }
} catch (error) {
  console.error('Échec :', error instanceof Error ? error.message : String(error));
  exitCode = 1;
} finally {
  clearTimeout(timer);
  if (testUserCreated) {
    try {
      const auth = getAuth();
      await auth.deleteUser(uid);
      console.log('Utilisateur de test supprimé.');
    } catch {
      console.error(`Attention : l’utilisateur de test ${uid} n’a pas pu être supprimé.`);
      exitCode = 1;
    }
  }
}

process.exit(exitCode);
