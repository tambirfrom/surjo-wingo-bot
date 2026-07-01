'use strict';

/**
 * bot.js
 * ---------------------------------------------------------------------
 * Main entry point. Responsibilities, in order:
 *
 *   1. Load config (which validates all required env vars and exits
 *      cleanly with a clear message if anything is missing).
 *   2. Initialize Firebase (config/firebase.js runs on require).
 *   3. Create the single TelegramBot polling instance.
 *   4. Register user-facing flows, admin flows, and start the WinGo
 *      automation engine.
 *   5. Install global safety nets: unhandled promise rejections,
 *      uncaught exceptions, and graceful shutdown on SIGINT/SIGTERM
 *      (important for VPS process managers like PM2/systemd).
 *
 * Run with:  node bot.js
 * Recommended for production:  pm2 start bot.js --name wingo-bot
 * ---------------------------------------------------------------------
 */

const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');

// Initializing this module has the side effect of connecting to
// Firebase — requiring it early surfaces any credential/connectivity
// problems immediately at boot, before we start polling Telegram.
require('./config/firebase');

const db = require('./services/database');
const { registerUserFlows } = require('./handlers/userFlows');
const { registerAdminFlows, startWingoAutomation } = require('./handlers/adminAndAutomation');

/* ===================================================================
 *  Bot instance
 * =================================================================== */

const bot = new TelegramBot(config.telegram.botToken, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 },
  },
});

console.log(`[BOT] Starting in ${config.env} mode...`);
console.log(`[BOT] Registered owner IDs: ${config.ownerIds.join(', ')}`);

/* ===================================================================
 *  Verify bot identity + username matches config (catches a common
 *  deployment mistake: BOT_USERNAME in .env not matching the actual
 *  token's bot, which silently breaks every referral link generated).
 * =================================================================== */
bot
  .getMe()
  .then((me) => {
    console.log(`[BOT] Connected as @${me.username} (ID: ${me.id})`);
    if (me.username.toLowerCase() !== config.telegram.botUsername.toLowerCase()) {
      console.warn(
        `[BOT] WARNING: BOT_USERNAME in .env is "${config.telegram.botUsername}" but the token ` +
          `actually belongs to "@${me.username}". Referral links will be wrong until you fix this.`
      );
    }
  })
  .catch((err) => {
    console.error('[BOT] Failed to verify bot identity — check BOT_TOKEN. Error:', err.message);
    process.exit(1);
  });

/* ===================================================================
 *  Register all handler modules
 * =================================================================== */

registerUserFlows(bot);
registerAdminFlows(bot);
console.log('[BOT] User flows and admin flows registered.');

startWingoAutomation(bot);
console.log('[BOT] WinGo automation engine started.');

/* ===================================================================
 *  Polling error handling — node-telegram-bot-api emits these on
 *  network hiccups, invalid tokens, or Telegram-side outages. Without
 *  a listener here, polling errors crash the process by default.
 * =================================================================== */

bot.on('polling_error', (err) => {
  console.error('[BOT] Polling error:', err.code || err.message);
  db.logError('polling_error', err.message).catch(() => {});
});

bot.on('webhook_error', (err) => {
  console.error('[BOT] Webhook error:', err.message);
});

/* ===================================================================
 *  Process-level safety nets
 * ===================================================================
 * A bot that stays up matters more than a bot that crashes loudly on
 * every unexpected error. We log everything to Firebase and stdout,
 * but do NOT exit the process on routine async errors — only on
 * unrecoverable startup failures (handled above) or explicit signals.
 * ------------------------------------------------------------------*/

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error('[BOT] Unhandled promise rejection:', message);
  db.logError('unhandled_rejection', message).catch(() => {});
});

process.on('uncaughtException', (err) => {
  console.error('[BOT] Uncaught exception:', err.stack || err.message);
  db.logError('uncaught_exception', err.stack || err.message).catch(() => {});
  // Uncaught synchronous exceptions can leave the process in an
  // undefined state — exit and let the process manager (PM2/systemd)
  // restart cleanly, rather than limping on.
  process.exit(1);
});

/* ===================================================================
 *  Graceful shutdown
 * =================================================================== */

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[BOT] Received ${signal}. Shutting down gracefully...`);
  try {
    await bot.stopPolling();
    console.log('[BOT] Polling stopped cleanly.');
  } catch (err) {
    console.error('[BOT] Error while stopping polling:', err.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('[BOT] Bot is fully online and polling for updates.');
