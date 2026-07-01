'use strict';

/**
 * config/firebase.js
 * ---------------------------------------------------------------------
 * Initializes the Firebase Admin SDK exactly once and exports the
 * shared `db` (Realtime Database) handle for the rest of the app.
 *
 * The service account key is loaded from a file on disk
 * (FIREBASE_SERVICE_ACCOUNT_PATH), not pasted into source code or
 * environment variables directly. On a VPS, store that file outside
 * the project directory (e.g. /etc/secrets/firebase-key.json) with
 * restrictive permissions:
 *
 *   sudo mkdir -p /etc/secrets
 *   sudo mv firebase-key.json /etc/secrets/firebase-key.json
 *   sudo chmod 600 /etc/secrets/firebase-key.json
 *   sudo chown <app-user>:<app-user> /etc/secrets/firebase-key.json
 * ---------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const config = require('./index');

function loadServiceAccount() {
  const resolvedPath = path.resolve(config.firebase.serviceAccountPath);

  if (!fs.existsSync(resolvedPath)) {
    console.error(`[FIREBASE] Service account file not found at: ${resolvedPath}`);
    console.error('[FIREBASE] Set FIREBASE_SERVICE_ACCOUNT_PATH in .env to the correct location.');
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[FIREBASE] Failed to read/parse service account JSON:', err.message);
    process.exit(1);
  }
}

let app;
try {
  const serviceAccount = loadServiceAccount();
  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: config.firebase.databaseURL,
  });
  console.log('[FIREBASE] Admin SDK initialized successfully.');
} catch (err) {
  console.error('[FIREBASE] Initialization failed:', err.message);
  process.exit(1);
}

const db = admin.database();

// Surface low-level connection state changes for observability —
// helps distinguish "Firebase is down" from "our code is broken"
// when debugging production issues.
const connectedRef = db.ref('.info/connected');
connectedRef.on('value', (snap) => {
  if (snap.val() === true) {
    console.log('[FIREBASE] Realtime Database connection established.');
  } else {
    console.warn('[FIREBASE] Realtime Database connection lost — SDK will auto-reconnect.');
  }
});

module.exports = { admin, app, db };
