# LexCanvas — Cloud Run deployment

## Production service

| Item | Value |
|---|---|
| GCP project | `altredige` (number `586777695980`) |
| Region | `europe-west1` |
| Cloud Run service | `lexcanvas` |
| Canonical URL | `https://lexcanvas-657enh5l5q-ew.a.run.app` |
| Legacy URL | `https://lexcanvas-586777695980.europe-west1.run.app` |
| Runtime | Node 22 (`node:22-alpine`) |
| Port | `8080` |
| Request timeout | `300 s` |
| Authentication | Firebase Google (`AUTH_MODE=firebase`) |
| History | Firestore (`HISTORY_ENABLED=1`), 90-day TTL |
| Secrets | `openrouter-api-key`, `firebase-service-account` |

Both Cloud Run hostnames are authorized in Firebase Authentication.

## Prerequisites (once)

```bash
gcloud auth login
gcloud config set project altredige
```

Create the two Secret Manager secrets:

```bash
# No trailing newline: use -n.
printf '%s' 'sk-or-v1-...' | gcloud secrets create openrouter-api-key \
  --data-file=- --project altredige

gcloud secrets create firebase-service-account \
  --data-file=/path/to/altredige-firebase-adminsdk.json \
  --project altredige
```

Grant the Cloud Run runtime service account read access:

```bash
PROJECT_NUMBER=586777695980
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud secrets add-iam-policy-binding openrouter-api-key \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor" \
  --project altredige

gcloud secrets add-iam-policy-binding firebase-service-account \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/secretmanager.secretAccessor" \
  --project altredige
```

## Deploy (every release)

```bash
chmod +x deploy-cloudrun.sh
./deploy-cloudrun.sh altredige europe-west1 lexcanvas
```

The script:

1. installs dependencies and runs `npm run build`;
2. enables the required APIs;
3. builds the image from `Dockerfile` with Cloud Build;
4. deploys with `cloudrun-env.yaml` and the two secrets.

Non-secret configuration lives in `cloudrun-env.yaml`:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `AUTH_MODE` | `firebase` |
| `HISTORY_ENABLED` | `1` |
| `TRUST_PROXY` | `1` |
| `FIREBASE_PROJECT_ID` | `altredige` |
| `FIREBASE_SERVICE_ACCOUNT` | `/secrets/firebase-service-account.json` |
| `LLM_MODELS` | `dots-studio/dots-3-note-preview:free,nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3.5-lightning:free,nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free` |
| `LLM_SAFETY_MODEL` | `nvidia/nemotron-3.5-content-safety:free` |
| `MAX_OUTPUT_TOKENS` | `16000` |
| `SAFETY_CHECK` | `1` |
| `ALLOWED_ORIGIN` | `https://altredige.web.app,https://altredige.firebaseapp.com` |
| `PUBLIC_API_BASE` | `https://lexcanvas-657enh5l5q-ew.a.run.app` |

`OPENROUTER_API_KEY` is injected as an environment secret. The Firebase service
account is mounted as a file at `/secrets/firebase-service-account.json`; the
application expects a path, not the JSON content.

## Post-deploy (first deploy or new hostname)

```bash
# Firestore composite indexes / field overrides
firebase deploy --only firestore:indexes --project altredige
```

Add the Cloud Run hostname(s) to Firebase Authentication:

> Firebase Console → Authentication → Settings → Authorized domains
> Add `lexcanvas-657enh5l5q-ew.a.run.app` and
> `lexcanvas-586777695980.europe-west1.run.app`.

Verify:

```bash
curl https://lexcanvas-657enh5l5q-ew.a.run.app/api/health
# {"ok":true,"contract_version":"1.1","model":"dots-studio/dots-3-note-preview:free"}

HISTORY_TEST_URL=https://lexcanvas-657enh5l5q-ew.a.run.app npm run verif-history
```

Real Google sign-in must be clicked once in a browser with a real account:
the popup is served by `altredige.firebaseapp.com` and needs the Cloud Run origin
in the authorized domains above. The `Cross-Origin-Opener-Policy:
same-origin-allow-popups` header required by `signInWithPopup` is set in
`src/app.ts`.

## Firebase Hosting (public entry point)

Firebase Hosting is the public entry point:

- `https://altredige.web.app` (and the equivalent
  `https://altredige.firebaseapp.com`) is served through the Hosting rewrite to
  the Cloud Run service `lexcanvas` in `europe-west1`.
- The page HTML is the same file served by Cloud Run; the Hosting rewrite only
  forwards the HTTP response. The CSP nonce therefore keeps working.
- **The API is not proxied through Hosting.** Firebase Hosting buffers SSE
  responses, which breaks `/api/chat`. The served page injects
  `PUBLIC_API_BASE` into `API_BASE`, so the browser calls Cloud Run directly.
  This is why `ALLOWED_ORIGIN` contains the Hosting domains: the API is
  cross-origin from the page.

Deploy Hosting after the Cloud Run release:

```bash
firebase deploy --only hosting --project altredige
```

The Hosting configuration lives in `firebase.json`; the public directory is
`hosting/` and only contains the fallback `404.html`. The `**` rewrite sends
every other request to Cloud Run. Never add an `index.html` to `hosting/`: the
static file would bypass the Cloud Run nonce CSP.

If the rewrite returns a permission error, grant the Firebase Hosting service
agent the Cloud Run Invoker role (the service is normally public, so this is
only needed if public access is removed):

```bash
PROJECT_NUMBER=586777695980
gcloud run services add-iam-policy-binding lexcanvas \
  --region=europe-west1 \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-firebasehosting.iam.gserviceaccount.com" \
  --role="roles/run.invoker" \
  --project=altredige
```

Verify the public entry point:

```bash
curl -I https://altredige.web.app/
# 200, content-type text/html, cross-origin-opener-policy: same-origin-allow-popups

curl -s https://altredige.web.app/api/health
# {"ok":true,...}

# CORS preflight for a direct call from the Hosting page.
curl -i -X OPTIONS https://lexcanvas-657enh5l5q-ew.a.run.app/api/chat \
  -H "Origin: https://altredige.web.app" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type"
# Access-Control-Allow-Origin: https://altredige.web.app
```

Add `altredige.web.app` and `altredige.firebaseapp.com` to Firebase
Authentication → Settings → Authorized domains if they are not already listed.
The final check is a real browser session on `https://altredige.web.app/`:
Google sign-in, streaming `/api/chat` (direct Cloud Run), history, and Word
export.

## Firestore TTL (history retention)

The deployed application writes `expires_at` on each history document. The TTL
policy must be created once in Firestore:

```bash
# Temporarily grant the Admin SDK account permission to manage TTL policies.
gcloud projects add-iam-policy-binding altredige \
  --member="serviceAccount:firebase-adminsdk-fbsvc@altredige.iam.gserviceaccount.com" \
  --role="roles/datastore.owner"

npm run setup-ttl

# Revoke after the policy is created.
gcloud projects remove-iam-policy-binding altredige \
  --member="serviceAccount:firebase-adminsdk-fbsvc@altredige.iam.gserviceaccount.com" \
  --role="roles/datastore.owner"
```

## Important implementation notes

- **Node 22 is required.** `firebase-admin@14.5.0` and its optional
  `@google-cloud/firestore` dependency require Node >= 22. Node 20 causes
  `npm ci` to skip `@google-cloud/firestore` and the container fails at startup
  with `Cannot find module '@google-cloud/firestore'`.
- **The image must contain `data/` and `prompts/`.** `data/templates/*.json`,
  `data/legal-sources.json` and `prompts/system.fr.md` are read at runtime.
  Without them, `/api/templates` is empty and `/api/chat` returns `llm_error`
  almost immediately.
- **Do not use `--set-env-vars` for the model chain.** gcloud parses `:` in
  `provider/model:free` as a dictionary separator. Use `--env-vars-file`.
- **Do not set `FIREBASE_SERVICE_ACCOUNT` to the secret value.** Mount the
  secret as a file and point the variable at the mount path.
- **`.gcloudignore` is mandatory.** gcloud falls back to `.gitignore`, which
  excludes `dist/`; the Docker build then fails with `stat dist: file does not
  exist`. The whitelist ships `dist/`, `public/`, `data/`, `prompts/`,
  `package*.json`, `Dockerfile` and `.dockerignore` only.
- **Cloud Build context** is filtered by `.dockerignore`; `dist`, `public`,
  `data` and `prompts` must stay included.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `llm_error` immediately, `steps: 0` | Missing `prompts/` or `data/` in the image. Rebuild with the Dockerfile copies. |
| `Cannot find module '@google-cloud/firestore'` | Base image is Node 20. Use `node:22-alpine`. |
| `Build failed: stat dist: file does not exist` | `.gcloudignore` missing/does not include `dist/`, or `npm run build` was not run. |
| `signInWithPopup` fails / `auth/unauthorized-domain` | Add the exact Cloud Run hostname to Firebase Auth authorized domains. |
| 401 on `/api/chat` or `/api/history` | Send `Authorization: Bearer <Firebase ID token>`; check `AUTH_MODE=firebase`. |
| History not saving | Check `HISTORY_ENABLED=1`, the mounted service-account secret, and Firestore rules (clients are denied; the Admin SDK bypasses rules). |
| Cold start too slow | Raise `--min-instances` to `1` (costs money) or keep the 300 s timeout. |
| TTL policy absent | Follow the Firestore TTL section above. |

## Deployment files

- `Dockerfile` — Node 22 Alpine, `dumb-init`, `dist/`, `public/`, `data/`,
  `prompts/`.
- `.dockerignore` — excludes dependencies, tests, docs and secrets from the
  Docker context.
- `.gcloudignore` — whitelist for `gcloud run deploy --source`.
- `cloudrun-env.yaml` — non-secret production environment.
- `deploy-cloudrun.sh` — build and deploy automation.
- `firebase.json` — Hosting rewrite to Cloud Run and Firestore configuration.
- `hosting/` — Firebase Hosting public fallback (`404.html` only).
- `DEPLOY-CLOUDRUN.md` — this document.
