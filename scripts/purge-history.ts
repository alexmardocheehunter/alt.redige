/**
 * Purge les historiques expirés sans la politique TTL Firestore.
 *
 * La politique TTL officielle exige l'offre Blaze (facturation activée). Sur
 * l'offre Spark, ce script applique la même conservation : il supprime les
 * documents `histories` dont `expires_at` est passé. Les lectures considèrent
 * déjà un document expiré comme absent ; ce script nettoie le stockage.
 *
 * Usage :
 *   npm run purge-history
 *   npm run purge-history -- --dry-run
 *
 * À planifier une fois par jour (cron, Task Scheduler, cron de l'hébergeur)
 * tant que le TTL Firestore n'est pas actif. Aucun contenu n'est lu ni affiché.
 */
import { existsSync, readFileSync } from 'node:fs';
import { applicationDefault, cert, initializeApp, type Credential } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { loadEnvFile } from '../src/env.js';

loadEnvFile();

const dryRun = process.argv.includes('--dry-run');
const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
let projectId = process.env.FIREBASE_PROJECT_ID?.trim() || undefined;

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

console.log('\n═══ Purge des historiques expirés ═══\n');
console.log('Projet   :', projectId);
console.log('Mode     :', dryRun ? 'simulation' : 'suppression');
console.log('');

const timer = setTimeout(() => {
  console.error('Délai dépassé (60 s).');
  process.exit(1);
}, 60_000);

try {
  const app = initializeApp({ credential, projectId });
  const db = getFirestore(app);
  const cutoff = Timestamp.now();
  let total = 0;
  let lastExpired = null;

  // Lots de 500 : la limite d'un batch Firestore. En simulation, le curseur
  // évite de compter plusieurs fois les mêmes documents puisqu'ils ne sont pas
  // supprimés.
  for (;;) {
    let query = db.collectionGroup('histories')
      .select('expires_at')
      .where('expires_at', '<=', cutoff)
      .orderBy('expires_at', 'asc')
      .limit(500);
    if (lastExpired) query = query.startAfter(lastExpired);

    const snapshot = await query.get();

    if (snapshot.empty) break;

    if (!dryRun) {
      const batch = db.batch();
      for (const doc of snapshot.docs) batch.delete(doc.ref);
      await batch.commit();
    }
    total += snapshot.size;
    lastExpired = snapshot.docs[snapshot.docs.length - 1];

    if (snapshot.size < 500) break;
  }

  console.log('Documents', dryRun ? 'à supprimer :' : 'supprimés    :', total);
  console.log(`\nVerdict : ${dryRun ? 'SIMULATION OK' : 'PURGE OK'}\n`);
  process.exit(0);
} catch (error) {
  console.error('Échec :', error instanceof Error ? error.message : String(error));
  const code = (error as { code?: number | string }).code;
  if (code === 9) {
    console.error('Code 9 = FAILED_PRECONDITION : un index de groupe de collections est peut-être requis.');
    console.error('Vérifiez firestore.indexes.json ou la console Firestore.');
  }
  console.error('\nVerdict : PURGE INDISPONIBLE\n');
  process.exit(1);
} finally {
  clearTimeout(timer);
}
