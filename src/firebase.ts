/**
 * Firebase Admin initialisation.
 *
 * The server uses Firebase for two independent things:
 *  - verifying Google/Firebase ID tokens (authentication) ;
 *  - storing per-user contract histories in Firestore (optional).
 *
 * Initialisation is synchronous: reading the service-account file and creating
 * the SDK clients does not perform any network call. Credentials are never
 * logged.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
  type App as FirebaseApp,
  type ServiceAccount,
} from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { ConfigError, type AppConfig } from './config.js';

export interface FirebaseServices {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
}

/**
 * Returns the singleton Firebase app, creating it on first use.
 *
 * `FIREBASE_SERVICE_ACCOUNT` is the path to the JSON key of a service account.
 * When it is absent, the SDK falls back to Application Default Credentials
 * (useful on Google Cloud, not on a bare VPS).
 */
export function initFirebase(config: AppConfig): FirebaseServices {
  const existing = getApps()[0];
  if (existing) {
    return { app: existing, auth: getAuth(existing), db: getFirestore(existing) };
  }

  if (!config.firebaseProjectId) {
    throw new ConfigError(
      'FIREBASE_PROJECT_ID est obligatoire pour initialiser Firebase.',
    );
  }

  let credential;
  try {
    if (config.firebaseServiceAccount) {
      if (!existsSync(config.firebaseServiceAccount)) {
        throw new ConfigError(
          `Compte de service Firebase introuvable : ${config.firebaseServiceAccount}`,
        );
      }
      let account: ServiceAccount;
      try {
        account = JSON.parse(readFileSync(config.firebaseServiceAccount, 'utf8')) as ServiceAccount;
      } catch {
        throw new ConfigError(
          'Le fichier FIREBASE_SERVICE_ACCOUNT n’est pas un JSON valide.',
        );
      }
      credential = cert(account);
    } else {
      credential = applicationDefault();
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      'Impossible de charger les identifiants Firebase. Vérifiez FIREBASE_SERVICE_ACCOUNT ou les identifiants par défaut.',
    );
  }

  let app: FirebaseApp;
  try {
    app = initializeApp({ credential, projectId: config.firebaseProjectId });
  } catch {
    throw new ConfigError(
      'Impossible d’initialiser Firebase Admin. Vérifiez FIREBASE_PROJECT_ID et le compte de service.',
    );
  }
  return { app, auth: getAuth(app), db: getFirestore(app) };
}
