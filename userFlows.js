'use strict';

/**
 * handlers/userFlows.js
 * ---------------------------------------------------------------------
 * All standard-user-facing conversation flows in one module:
 *
 *   - /start                        (Section 1.1)
 *   - Watch Tutorial Video          (Section 1.1)
 *   - Go to Homepage + Force Join   (Section 1.1)
 *   - Verify Entry (one-time bonus) (Section 1.1, exploit-safe)
 *   - Referrals dashboard           (Section 1.2)
 *   - Verify Profile (ImgBB)        (Section 1.3, fault-tolerant)
 *   - My Account Dashboard          (Section 1.5)
 *   - Transfer/Redeem Points        (Section 1.5, exploit-safe)
 *
 * Call `registerUserFlows(bot)` once from bot.js after the bot
 * instance is created.
 * ---------------------------------------------------------------------
 */

const config = require('../config');
const db = require('../services/database');
const { uploadToImgbb, checkForceJoinMembership } = require('../services/botServices');

/* ===================================================================
 *  Lightweight in-memory conversation state
 * ===================================================================
 * Multi-step flows (submit a screenshot, type a redeem amount) need
 * to remember "what is this user in the middle of doing". A full
 * external state store is overkill for a single bot process, so we
 * keep a Map keyed by Telegram user ID. If the process restarts,
 * users simply have to re-tap the menu button — no data is lost
 * because nothing here is financial state (that all lives in
 * Firebase via the transactional services/database.js layer).
 * ------------------------------------------------------------------*/
const SESSION = new Map();

const STATES = {
  AWAITING_SCREENSHOT: 'AWAITING_SCREENSHOT',
  AWAITING_REDEEM_AMOUNT: 'AWAITING_REDEEM_AMOUNT',
};

function setSession(userId, state, extra = {}) {
  SESSION.set(userId, { state, ...extra });
}
function getSession(userId) {
  return SESSION.get(userId) || null;
}
function clearSession(userId) {
  SESSION.delete(userId);
}

/* ===================================================================
 *  Callback data constants — keep all button payloads in one place
 *  so handlers and keyboard builders can never drift out of sync.
 * =================================================================== */
const CB = {
  WATCH_TUTORIAL: 'u:watch_tutorial',
  GO_HOME: 'u:go_home',
  VERIFY_ENTRY: 'u:verify_entry',
  HOME_REFERRALS: 'u:home_referrals',
  HOME_VERIFY_PROFILE: 'u:home_verify_profile',
  HOME_ACCOUNT: 'u:home_account',
  HOME_REDEEM: 'u:home_redeem',
  BACK_HOME: 'u:back_home',
};

/* ===================================================================
 *  Keyboard builders
 * =================================================================== */

function startKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🏠 Go to Homepage', callback_data: CB.GO_HOME }],
      [{ text: '🎬 Watch Tutorial Video', callback_data: CB.WATCH_TUTORIAL }],
    ],
  };
}

function forceJoinKeyboard(missingChannels) {
  const rows = missingChannels.map((ch) => [{ text: `➕ Join ${ch.name}`, url: ch.link || 'https://t.me' }]);
  rows.push([{ text: '✅ Verify Entry', callback_data: CB.VERIFY_ENTRY }]);
  return { inline_keyboard: rows };
}

function homeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🤝 Referrals', callback_data: CB.HOME_REFERRALS }],
      [{ text: '📤 Verify Profile', callback_data: CB.HOME_VERIFY_PROFILE }],
      [{ text: '👤 My Account', callback_data: CB.HOME_ACCOUNT }],
      [{ text: '💸 Transfer / Redeem Points', callback_data: CB.HOME_REDEEM }],
    ],
  };
}

function backHomeKeyboard() {
  return { inline_keyboard: [[{ text: '⬅️ Back to Homepage', callback_data: CB.BACK_HOME }]] };
}

/* ===================================================================
 *  Helper: route a user into the homepage, running the force-join
 *  gate first. Shared by /start's "Go to Homepage" button and by
 *  "Verify Entry" once a user passes.
 * =================================================================== */
async function routeToHomeOrForceJoin(bot, chatId, userId) {
  const result = await checkForceJoinMembership(bot, userId);

  if (!result.allJoined) {
    await bot.sendMessage(
      chatId,
      '⚠️ <b>Verification Required</b>\n\nPlease join all the channels below, then tap "Verify Entry".',
      { parse_mode: 'HTML', reply_markup: forceJoinKeyboard(result.missing) }
    );
    return;
  }

  await bot.sendMessage(chatId, '🏠 <b>Main Menu</b>\n\nChoose an option below:', {
    parse_mode: 'HTML',
    reply_markup: homeKeyboard(),
  });
}

/* ===================================================================
 *  /start
 * =================================================================== */

async function handleStart(bot, msg, match) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name || null;

  // /start payload carries the referrer's ID, per the referral link
  // format specified: https://t.me/BotUsername?start=UserID
  const payload = match && match[1] ? match[1].trim() : '';
  const referrerId = payload && /^\d+$/.test(payload) && Number(payload) !== userId ? Number(payload) : null;

  const existing = await db.getUser(userId);
  if (!existing) {
    await db.ensureUser(userId, { username, referredBy: referrerId });
  }

  const startMessage = await db.getValue(
    config.dbPaths.startMessage,
    '👋 Welcome! Use the buttons below to get started.'
  );

  await bot.sendMessage(chatId, startMessage, {
    parse_mode: 'HTML',
    reply_markup: startKeyboard(),
    disable_web_page_preview: true,
  });
}

/* ===================================================================
 *  Callback query dispatcher
 * =================================================================== */

async function handleCallbackQuery(bot, query) {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  // Always ack the callback quickly so Telegram doesn't show a
  // perpetual loading spinner on the button, even if downstream work
  // takes a moment.
  const ack = async (text) => {
    try {
      await bot.answerCallbackQuery(query.id, text ? { text, show_alert: false } : undefined);
    } catch (_) {
      /* non-fatal — query may have expired */
    }
  };

  try {
    switch (data) {
      case CB.WATCH_TUTORIAL: {
        await ack();
        const video = await db.getValue(config.dbPaths.videoConfig, null);
        if (!video || !video.url) {
          await bot.sendMessage(chatId, '🎬 Tutorial video is not configured yet. Please check back later.');
          return;
        }
        await bot.sendMessage(
          chatId,
          `🎬 <b>Tutorial</b>\n\n${video.description || 'Watch the full walkthrough here:'}\n${video.url}`,
          { parse_mode: 'HTML', disable_web_page_preview: false }
        );
        return;
      }

      case CB.GO_HOME:
      case CB.BACK_HOME: {
        await ack();
        await routeToHomeOrForceJoin(bot, chatId, userId);
        return;
      }

      case CB.VERIFY_ENTRY: {
        await ack('Checking your status...');
        const result = await checkForceJoinMembership(bot, userId);

        if (!result.allJoined) {
          await bot.sendMessage(
            chatId,
            '❌ You still haven\'t joined all required channels. Please join, then tap "Verify Entry" again.',
            { reply_markup: forceJoinKeyboard(result.missing) }
          );
          return;
        }

        // Exploit-safe one-time claim — safe to call even if the user
        // mashes this button repeatedly.
        const claim = await db.claimForceJoinBonus(userId, result.totalReward);

        if (claim.claimed) {
          await bot.sendMessage(
            chatId,
            `✅ Verified! You've been awarded <b>${result.totalReward} points</b>.\nYour new balance: <b>${claim.newBalance}</b>`,
            { parse_mode: 'HTML' }
          );
        } else {
          await bot.sendMessage(chatId, '✅ Verified! (Bonus was already claimed previously.)');
        }

        await routeToHomeOrForceJoin(bot, chatId, userId);
        return;
      }

      case CB.HOME_REFERRALS: {
        await ack();
        await sendReferralDashboard(bot, chatId, userId);
        return;
      }

      case CB.HOME_VERIFY_PROFILE: {
        await ack();
        await startVerifyProfileFlow(bot, chatId, userId);
        return;
      }

      case CB.HOME_ACCOUNT: {
        await ack();
        await sendAccountDashboard(bot, chatId, userId);
        return;
      }

      case CB.HOME_REDEEM: {
        await ack();
        await startRedeemFlow(bot, chatId, userId);
        return;
      }

      default:
        await ack();
        return;
    }
  } catch (err) {
    await db.logError('callback_query', `data=${data} userId=${userId} err=${err.message}`);
    await ack('Something went wrong. Please try again.');
  }
}

/* ===================================================================
 *  Section 1.2 — Referral dashboard
 * =================================================================== */

async function sendReferralDashboard(bot, chatId, userId) {
  const user = await db.getUser(userId);
  const allUsers = await db.getValue(config.dbPaths.users, {});

  const referredUsers = Object.values(allUsers || {}).filter(
    (u) => u && Number(u.referredBy) === Number(userId)
  );

  const totalSubJoins = referredUsers.length;
  const totalActiveClaimants = referredUsers.filter((u) => u.has_claimed_force_join_bonus).length;
  const totalVerified = referredUsers.filter((u) => u.isVerified).length;
  const aggregateRewardsEarned = referredUsers.filter((u) => u.is_referral_commission_paid).length
    * config.defaults.referralCommission;

  const link = `https://t.me/${config.telegram.botUsername}?start=${userId}`;

  const text =
    `🤝 <b>Your Referral Dashboard</b>\n\n` +
    `Copy your referral link and share it with friends. Once they complete verification, you will earn ` +
    `${config.defaults.referralCommission} reward points.\n\n` +
    `🔗 <code>${link}</code>\n\n` +
    `📊 <b>Live Stats</b>\n` +
    `• Total Sub-Joins: <b>${totalSubJoins}</b>\n` +
    `• Total Active Claimants: <b>${totalActiveClaimants}</b>\n` +
    `• Total Successfully Verified Users: <b>${totalVerified}</b>\n` +
    `• Aggregate Referral Rewards Earned: <b>${aggregateRewardsEarned}</b> points\n\n` +
    `Current balance: <b>${user ? user.balance : 0}</b> points`;

  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: backHomeKeyboard() });
}

/* ===================================================================
 *  Section 1.3 — Verify Profile (assignment + ImgBB screenshot)
 * =================================================================== */

async function startVerifyProfileFlow(bot, chatId, userId) {
  const assignment = await db.getValue(config.dbPaths.assignmentConfig, {});
  const portalLink = assignment.portalLink || 'https://example.com/register';
  const minValue = assignment.minValue != null ? assignment.minValue : 'N/A';

  await bot.sendMessage(
    chatId,
    `📝 <b>Verify Your Profile</b>\n\n` +
      `Register an account using the link below, perform the minimum assignment configuration ` +
      `(<b>${minValue}</b>), and submit your assignment confirmation screenshot.\n\n` +
      `🔗 ${portalLink}\n\n` +
      `📸 Now send your confirmation screenshot as a photo.`,
    { parse_mode: 'HTML', disable_web_page_preview: true }
  );

  setSession(userId, STATES.AWAITING_SCREENSHOT, { chatId });
}

/** Called from bot.js's generic photo handler when a user is in this flow. */
async function handlePhotoSubmission(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const session = getSession(userId);

  if (!session || session.state !== STATES.AWAITING_SCREENSHOT) {
    return false; // not in this flow — let other handlers ignore/handle it
  }

  try {
    // Telegram sends multiple resolutions; take the highest-res variant.
    const photos = msg.photo;
    const best = photos[photos.length - 1];

    const fileLink = await bot.getFileLink(best.file_id);
    const axios = require('axios');
    const response = await axios.get(fileLink, { responseType: 'arraybuffer', timeout: 15000 });
    const buffer = Buffer.from(response.data);

    const upload = await uploadToImgbb(buffer, `verify_${userId}_${Date.now()}.jpg`);

    if (!upload.ok) {
      await bot.sendMessage(chatId, `❌ ${upload.userMessage}`);
      // Deliberately keep the session active so the user can just
      // resend a photo without re-navigating the menu.
      return true;
    }

    const user = await db.getUser(userId);
    const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name || `User ${userId}`;
    const submittedAt = new Date().toLocaleString('en-US', { timeZone: config.timezone });

    await db.pushVerifyRequest({
      userId,
      username,
      imageUrl: upload.url,
      submittedAtLocal: submittedAt,
    });

    clearSession(userId);

    await bot.sendMessage(
      chatId,
      '✅ Your screenshot has been submitted for review. You will be notified once an admin approves it.',
      { reply_markup: backHomeKeyboard() }
    );

    // Alert dispatch to both Master Owner IDs, per spec.
    for (const ownerId of config.ownerIds) {
      try {
        await bot.sendPhoto(ownerId, upload.url, {
          caption:
            `📥 <b>New Verification Request</b>\n\n` +
            `User: ${username} (ID: ${userId})\n` +
            `Submitted: ${submittedAt}`,
          parse_mode: 'HTML',
        });
      } catch (err) {
        await db.logError('owner_alert', `ownerId=${ownerId} err=${err.message}`);
      }
    }

    return true;
  } catch (err) {
    await db.logError('verify_profile_photo', `userId=${userId} err=${err.message}`);
    await bot.sendMessage(chatId, '❌ Upload failed. Please try again or submit a lower-resolution file.');
    return true;
  }
}

/* ===================================================================
 *  Section 1.5 — Account dashboard + Redeem flow
 * =================================================================== */

async function sendAccountDashboard(bot, chatId, userId) {
  const user = await db.getUser(userId);
  if (!user) {
    await bot.sendMessage(chatId, 'Please send /start first.');
    return;
  }

  const text =
    `👤 <b>My Account Dashboard</b>\n\n` +
    `💰 Balance: <b>${user.balance}</b> points\n` +
    `✅ Verified: <b>${user.isVerified ? 'Yes' : 'No'}</b>\n` +
    `🎁 Force-Join Bonus Claimed: <b>${user.has_claimed_force_join_bonus ? 'Yes' : 'No'}</b>\n` +
    `🤝 Total Referrals: <b>${user.totalReferrals || 0}</b>\n` +
    `📅 Joined: <b>${new Date(user.joinedAt).toLocaleDateString('en-US', { timeZone: config.timezone })}</b>`;

  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: backHomeKeyboard() });
}

async function startRedeemFlow(bot, chatId, userId) {
  const user = await db.getUser(userId);
  const balance = user ? user.balance : 0;
  const minRedeem = config.defaults.minRedeemPoints;

  if (balance < minRedeem) {
    await bot.sendMessage(
      chatId,
      `⚠️ You need at least <b>${minRedeem}</b> points to redeem. Your current balance: <b>${balance}</b>.`,
      { parse_mode: 'HTML', reply_markup: backHomeKeyboard() }
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    `💸 <b>Redeem Points</b>\n\nYour current balance is <b>${balance}</b> points.\n` +
      `Please type how many points you'd like to redeem (numbers only).`,
    { parse_mode: 'HTML' }
  );

  setSession(userId, STATES.AWAITING_REDEEM_AMOUNT, { chatId });
}

/** Called from bot.js's generic text handler when a user is in this flow. */
async function handleRedeemAmountText(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const session = getSession(userId);

  if (!session || session.state !== STATES.AWAITING_REDEEM_AMOUNT) {
    return false;
  }

  const text = (msg.text || '').trim();
  const amount = Number(text);

  if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
    await bot.sendMessage(chatId, '❌ Please enter a valid whole number of points.');
    return true; // stay in this flow, let them retry
  }

  // Server-side, transaction-validated check — this is the actual
  // exploit-prevention boundary, not the UI-level balance shown above
  // (which could be stale by the time the user types their amount).
  const result = await db.reserveRedemption(userId, amount);

  if (!result.ok) {
    if (result.reason === 'INSUFFICIENT_BALANCE') {
      await bot.sendMessage(chatId, '❌ Insufficient balance for point redemption.');
    } else {
      await bot.sendMessage(chatId, '❌ Could not process your redemption right now. Please try again later.');
    }
    clearSession(userId);
    return true;
  }

  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name || `User ${userId}`;

  await db.pushWithdrawRequest({
    userId,
    username,
    amount,
    balanceAfterReserve: result.newBalance,
  });

  clearSession(userId);

  await bot.sendMessage(
    chatId,
    `✅ Redemption request for <b>${amount}</b> points has been submitted for admin review.\n` +
      `Remaining balance: <b>${result.newBalance}</b>`,
    { parse_mode: 'HTML', reply_markup: backHomeKeyboard() }
  );

  return true;
}

/* ===================================================================
 *  Registration entrypoint
 * =================================================================== */

function registerUserFlows(bot) {
  bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
    handleStart(bot, msg, match).catch(async (err) => {
      await db.logError('handleStart', `userId=${msg.from.id} err=${err.message}`);
    });
  });

  bot.on('callback_query', (query) => {
    handleCallbackQuery(bot, query).catch(async (err) => {
      await db.logError('handleCallbackQuery', `err=${err.message}`);
    });
  });

  // Generic photo handler — only acts if the user is mid-flow.
  bot.on('photo', (msg) => {
    handlePhotoSubmission(bot, msg).catch(async (err) => {
      await db.logError('handlePhotoSubmission', `userId=${msg.from.id} err=${err.message}`);
    });
  });

  // Generic text handler — only acts if the user is mid-flow. Ignores
  // slash-commands so it never swallows other command handlers.
  bot.on('message', (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    handleRedeemAmountText(bot, msg).catch(async (err) => {
      await db.logError('handleRedeemAmountText', `userId=${msg.from.id} err=${err.message}`);
    });
  });
}

module.exports = {
  registerUserFlows,
  // exported for reuse by handlers/adminFlows.js in a later batch
  CB,
  homeKeyboard,
  backHomeKeyboard,
  routeToHomeOrForceJoin,
};
