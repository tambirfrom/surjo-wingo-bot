'use strict';

/**
 * config/index.js
 * ---------------------------------------------------------------------
 * Single source of truth for runtime configuration.
 *
 * - Loads and validates environment variables once, at process start.
 * - Fails fast (process.exit) if anything critical is missing, instead
 *   of letting the bot boot into a half-broken state.
 * - Every other module should `require('../config')` rather than
 *   touching `process.env` directly — this keeps secrets centralized
 *   and makes it trivial to audit what the app actually depends on.
 * ---------------------------------------------------------------------
 */

require('dotenv').config();

/** Helper: read a required env var or crash with a clear message. */
function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    // Fail loudly at boot rather than throwing confusing errors later
    // deep inside a Telegram callback handler.
    console.error(`[CONFIG] Missing required environment variable: ${name}`);
    console.error('[CONFIG] Copy .env.example to .env and fill in real values.');
    process.exit(1);
  }
  return value.trim();
}

/** Helper: read an optional env var with a fallback default. */
function optional(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

/** Parse the comma-separated OWNER_IDS into an array of numeric IDs. */
function parseOwnerIds(raw) {
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));

  if (ids.length < 1 || ids.some((id) => Number.isNaN(id))) {
    console.error('[CONFIG] OWNER_IDS must be a comma-separated list of numeric Telegram user IDs.');
    process.exit(1);
  }
  return ids;
}

const OWNER_IDS = parseOwnerIds(required('OWNER_IDS'));

const config = {
  env: optional('NODE_ENV', 'production'),
  timezone: optional('TIMEZONE', 'Asia/Kolkata'),

  telegram: {
    botToken: required('BOT_TOKEN'),
    botUsername: required('BOT_USERNAME'),
  },

  imgbb: {
    apiKey: required('IMGBB_API_KEY'),
    uploadEndpoint: 'https://api.imgbb.com/1/upload',
  },

  firebase: {
    serviceAccountPath: required('FIREBASE_SERVICE_ACCOUNT_PATH'),
    databaseURL: required('FIREBASE_DATABASE_URL'),
  },

  // Both IDs get full, equal, non-restrictive admin privileges.
  ownerIds: OWNER_IDS,

  wingo: {
    url30s: optional(
      'WINGO_30S_URL',
      'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json'
    ),
    url60s: optional(
      'WINGO_60S_URL',
      'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json'
    ),
    // How long to wait before retrying a failed scrape, per spec.
    retryDelayMs: 5000,
  },

  templates: {
    url30s: optional(
      'TEMPLATE_30S_URL',
      'https://i.ibb.co.com/zTGv53Tc/file-00000000a354720688a7e68df8dcdf33.png'
    ),
    url60s: optional(
      'TEMPLATE_60S_URL',
      'https://i.ibb.co.com/tTY42fr3/file-000000003ec072098f7bce248691cc08.png'
    ),
  },

  // Default reward values — all overridable live from the admin panel,
  // these are just safe fallbacks if the DB node doesn't exist yet.
  defaults: {
    forceJoinRewardPerChannel: 5,
    referralCommission: 10,
    minRedeemPoints: 100,
  },

  /** Canonical Firebase Realtime Database paths used across the app. */
  dbPaths: {
    users: 'users',
    settings: 'settings',
    startMessage: 'settings/start_message',
    videoConfig: 'settings/video_config',
    requiredChannels: 'settings/required_channels',
    signalGroups: 'settings/signal_groups',
    signalTargets: 'settings/signal_targets',
    assignmentConfig: 'settings/assignment_config',
    admins: 'admins',
    verifyRequests: 'admin/verify_requests',
    withdrawRequests: 'admin/withdraw_requests',
    errorLog: 'admin/error_log',
    analyticsEngine: 'admin/analytics_engine',
  },
};

/** Convenience helper used throughout handlers/services. */
config.isOwner = (telegramUserId) => config.ownerIds.includes(Number(telegramUserId));

module.exports = config;
