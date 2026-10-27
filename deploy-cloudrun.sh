#!/usr/bin/env bash
# Build and deploy LexCanvas to Cloud Run.
# Usage: ./deploy-cloudrun.sh [PROJECT_ID] [REGION] [SERVICE_NAME] [ENV_FILE]
# Requires: gcloud CLI authenticated as a project owner, Node.js >= 20, npm.
set -euo pipefail

PROJECT_ID="${1:-altredige}"
REGION="${2:-europe-west1}"
SERVICE_NAME="${3:-lexcanvas}"
ENV_FILE="${4:-cloudrun-env.yaml}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "❌ gcloud introuvable. Installez le Google Cloud SDK."
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ Fichier d'environnement introuvable : $ENV_FILE"
  exit 1
fi

ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)"
if [ -z "$ACTIVE_ACCOUNT" ]; then
  echo "❌ Aucun compte gcloud actif. Lancez : gcloud auth login"
  exit 1
fi

echo "=== LexCanvas — Cloud Run ==="
echo "Projet  : $PROJECT_ID"
echo "Région  : $REGION"
echo "Service : $SERVICE_NAME"
echo "Compte  : $ACTIVE_ACCOUNT"
echo ""

# The Dockerfile copies the prebuilt dist/, public/, data/ and prompts/.
echo "→ Installation et build local…"
npm ci
npm run build

echo "→ Activation des APIs…"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  --project "$PROJECT_ID"

if ! gcloud artifacts repositories describe cloud-run-source-deploy \
  --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "→ Création du dépôt Artifact Registry…"
  gcloud artifacts repositories create cloud-run-source-deploy \
    --repository-format=docker \
    --location "$REGION" \
    --project "$PROJECT_ID" \
    --description "Cloud Run source deploy images"
fi

echo "→ Déploiement…"
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 1 \
  --memory 512Mi \
  --min-instances 0 \
  --max-instances 10 \
  --concurrency 80 \
  --timeout 300 \
  --env-vars-file "$ENV_FILE" \
  --set-secrets "/secrets/firebase-service-account.json=firebase-service-account:latest,OPENROUTER_API_KEY=openrouter-api-key:latest"

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" --project "$PROJECT_ID" \
  --format='value(status.url)')"

echo ""
echo "✅ Déployé : $SERVICE_URL"
echo ""
echo "À faire une fois (ou après un nouveau hostname) :"
echo "  1. Firebase Console → Authentication → Settings → Authorized domains"
echo "     Ajouter : ${SERVICE_URL#https://}"
echo "  2. firebase deploy --only firestore:indexes --project $PROJECT_ID"
echo "  3. Vérifier : curl $SERVICE_URL/api/health"
