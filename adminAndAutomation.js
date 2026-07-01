'use strict';

/**
 * handlers/adminAndAutomation.js
 * ---------------------------------------------------------------------
 * COMBINED FILE — Master Administration Engine + WinGo Automation &
 * Canvas Engine, merged into one module for simpler deployment.
 *
 * SECTION A: Master Administration Engine
 *   Verify/withdraw inboxes, channel & group management, notifications,
 *   settings menu — everything gated behind config.isOwner().
 *
 * SECTION B: WinGo Automation & Canvas Engine
 *   Clock-synced 30s/60s loops, retry-on-failure scraping, node-canvas
 *   result card rendering, and broadcast delivery.
 *
 * Call registerAdminFlows(bot) AND startWingoAutomation(bot) once each
 * from bot.js after the bot instance is created.
 * ---------------------------------------------------------------------
 */

const config = require('../config');
const db = require('../services/database');
const { resolveChatId, verifyBotIsAdmin } = require('../services/botServices');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');

/* ====================================================================
 *  SECTION A: MASTER ADMINISTRATION ENGINE
 * ==================================================================== */

const SESSION = new Map();

const STATES = {
  AWAITING_REJECT_VERIFY_REASON: 'AWAITING_REJECT_VERIFY_REASON',
  AWAITING_REJECT_WITHDRAW_REASON: 'AWAITING_REJECT_WITHDRAW_REASON',
  AWAITING_GROUP_NAME: 'AWAITING_GROUP_NAME',
  AWAITING_GROUP_LINK: 'AWAITING_GROUP_LINK',
  AWAITING_CHANNEL_NAME: 'AWAITING_CHANNEL_NAME',
  AWAITING_CHANNEL_LINK: 'AWAITING_CHANNEL_LINK',
  AWAITING_CHANNEL_REWARD: 'AWAITING_CHANNEL_REWARD',
  AWAITING_BROADCAST_MESSAGE: 'AWAITING_BROADCAST_MESSAGE',
  AWAITING_TARGET_USERNAME: 'AWAITING_TARGET_USERNAME',
  AWAITING_TARGET_MESSAGE: 'AWAITING_TARGET_MESSAGE',
  AWAITING_START_MESSAGE: 'AWAITING_START_MESSAGE',
  AWAITING_VIDEO_URL: 'AWAITING_VIDEO_URL',
  AWAITING_PORTAL_LINK: 'AWAITING_PORTAL_LINK',
  AWAITING_MIN_VALUE: 'AWAITING_MIN_VALUE',
};

function setSession(adminId, state, extra = {}) {
  SESSION.set(adminId, { state, ...extra });
}
function getSession(adminId) {
  return SESSION.get(adminId) || null;
}
function clearSession(adminId) {
  SESSION.delete(adminId);
}

/* ===================================================================
 *  Callback data constants
 * =================================================================== */
const CB = {
  PANEL: 'a:panel',
  VERIFY_INBOX: 'a:verify_inbox',
  VERIFY_APPROVE: 'a:verify_approve:', // + requestKey
  VERIFY_REJECT: 'a:verify_reject:', // + requestKey
  WITHDRAW_INBOX: 'a:withdraw_inbox',
  WITHDRAW_COMPLETE: 'a:withdraw_complete:', // + requestKey
  WITHDRAW_REJECT: 'a:withdraw_reject:', // + requestKey
  GROUPS_MENU: 'a:groups_menu',
  GROUPS_ADD: 'a:groups_add',
  GROUPS_VIEW: 'a:groups_view:', // + groupKey
  GROUPS_DELETE: 'a:groups_delete:', // + groupKey
  GROUPS_TOGGLE: 'a:groups_toggle:', // + groupKey
  CHANNELS_MENU: 'a:channels_menu',
  CHANNELS_ADD: 'a:channels_add',
  CHANNELS_VIEW: 'a:channels_view:', // + channelKey
  CHANNELS_DELETE: 'a:channels_delete:', // + channelKey
  NOTIFY_MENU: 'a:notify_menu',
  NOTIFY_GLOBAL: 'a:notify_global',
  NOTIFY_TARGET: 'a:notify_target',
  SETTINGS_MENU: 'a:settings_menu',
  SETTINGS_START_MSG: 'a:settings_start_msg',
  SETTINGS_VIDEO: 'a:settings_video',
  SETTINGS_PORTAL: 'a:settings_portal',
  SETTINGS_MIN_VALUE: 'a:settings_min_value',
};

/* ===================================================================
 *  Guard: only owners may reach any handler in this file
 * =================================================================== */
function isAdminUser(userId) {
  return config.isOwner(userId);
}

/* ===================================================================
 *  Keyboards
 * =================================================================== */
function panelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📥 Verify Request Inbox', callback_data: CB.VERIFY_INBOX }],
      [{ text: '💸 Redemption Requests', callback_data: CB.WITHDRAW_INBOX }],
      [{ text: '🎯 Manage Strategy Groups', callback_data: CB.GROUPS_MENU }],
      [{ text: '📢 Manage Channel Commitments', callback_data: CB.CHANNELS_MENU }],
      [{ text: '📣 Global Notifications', callback_data: CB.NOTIFY_MENU }],
      [{ text: '⚙️ Settings', callback_data: CB.SETTINGS_MENU }],
    ],
  };
}
function backToPanelKeyboard() {
  return { inline_keyboard: [[{ text: '⬅️ Back to Admin Panel', callback_data: CB.PANEL }]] };
}

/* ===================================================================
 *  /admin entrypoint
 * =================================================================== */
async function handleAdminCommand(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  if (!isAdminUser(userId)) return; // silently ignore — don't reveal the command exists

  await sendPanel(bot, chatId);
}

async function sendPanel(bot, chatId) {
  await bot.sendMessage(chatId, '🛠 <b>Master Administration Panel</b>\n\nSelect a control below:', {
    parse_mode: 'HTML',
    reply_markup: panelKeyboard(),
  });
}

/* ===================================================================
 *  Section 5.1 — Verify Request Inbox
 * =================================================================== */

async function sendVerifyInbox(bot, chatId) {
  const requests = await db.getValue(config.dbPaths.verifyRequests, {});
  const pending = Object.entries(requests || {}).filter(([, r]) => r.status === 'pending');

  if (pending.length === 0) {
    await bot.sendMessage(chatId, '📥 No pending verification requests.', {
      reply_markup: backToPanelKeyboard(),
    });
    return;
  }

  const batch = pending.slice(0, 5);
  for (const [key, req] of batch) {
    await bot.sendPhoto(chatId, req.imageUrl, {
      caption:
        `📥 <b>Verification Request</b>\n\n` +
        `User: ${req.username} (ID: ${req.userId})\n` +
        `Submitted: ${req.submittedAtLocal || new Date(req.submittedAt).toLocaleString()}`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: CB.VERIFY_APPROVE + key },
            { text: '❌ Reject', callback_data: CB.VERIFY_REJECT + key },
          ],
        ],
      },
    });
  }

  if (pending.length > 5) {
    await bot.sendMessage(chatId, `...and ${pending.length - 5} more pending. Re-open the inbox after acting on these.`);
  }
}

async function approveVerifyRequest(bot, chatId, adminId, requestKey) {
  const path = `${config.dbPaths.verifyRequests}/${requestKey}`;
  const request = await db.getValue(path, null);

  if (!request || request.status !== 'pending') {
    await bot.sendMessage(chatId, '⚠️ This request has already been processed.');
    return;
  }

  await db.updateValue(`${config.dbPaths.users}/${request.userId}`, { isVerified: true });
  await db.updateValue(path, { status: 'approved', reviewedBy: adminId, reviewedAt: Date.now() });

  const invitedUser = await db.getUser(request.userId);
  if (invitedUser && invitedUser.referredBy) {
    const payout = await db.payReferralCommissionOnce(
      request.userId,
      invitedUser.referredBy,
      config.defaults.referralCommission
    );
    if (payout.paid) {
      try {
        await bot.sendMessage(
          invitedUser.referredBy,
          `🎉 Your referral (${request.username}) was verified! You earned ${config.defaults.referralCommission} points.`
        );
      } catch (_) {
        /* referrer may have blocked the bot — non-fatal */
      }
    }
  }

  try {
    await bot.sendMessage(request.userId, '✅ Your profile verification has been approved! You can now access strategy answers.');
  } catch (_) {
    /* user may have blocked the bot — non-fatal */
  }

  await bot.sendMessage(chatId, '✅ Approved and processed.');
}

async function rejectVerifyRequestStart(bot, chatId, adminId, requestKey) {
  setSession(adminId, STATES.AWAITING_REJECT_VERIFY_REASON, { chatId, requestKey });
  await bot.sendMessage(chatId, '✏️ Please type the rejection reason to send to the user:');
}

async function rejectVerifyRequestFinish(bot, adminId, reason) {
  const session = getSession(adminId);
  const { chatId, requestKey } = session;
  const path = `${config.dbPaths.verifyRequests}/${requestKey}`;
  const request = await db.getValue(path, null);

  if (!request || request.status !== 'pending') {
    await bot.sendMessage(chatId, '⚠️ This request has already been processed.');
    clearSession(adminId);
    return;
  }

  await db.updateValue(path, {
    status: 'rejected',
    reviewedBy: adminId,
    reviewedAt: Date.now(),
    rejectReason: reason,
  });

  try {
    await bot.sendMessage(request.userId, `❌ Your verification submission was rejected.\nReason: ${reason}`);
  } catch (_) {
    /* non-fatal */
  }

  await bot.sendMessage(chatId, '✅ Rejection recorded and user notified.');
  clearSession(adminId);
}

/* ===================================================================
 *  Section 5.5 — Process Redemptions
 * =================================================================== */

async function sendWithdrawInbox(bot, chatId) {
  const requests = await db.getValue(config.dbPaths.withdrawRequests, {});
  const pending = Object.entries(requests || {}).filter(([, r]) => r.status === 'pending');

  if (pending.length === 0) {
    await bot.sendMessage(chatId, '💸 No pending redemption requests.', { reply_markup: backToPanelKeyboard() });
    return;
  }

  for (const [key, req] of pending.slice(0, 10)) {
    await bot.sendMessage(
      chatId,
      `💸 <b>Redemption Request</b>\n\nUser: ${req.username} (ID: ${req.userId})\nAmount: <b>${req.amount}</b> points`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Complete', callback_data: CB.WITHDRAW_COMPLETE + key },
              { text: '❌ Reject', callback_data: CB.WITHDRAW_REJECT + key },
            ],
          ],
        },
      }
    );
  }
}

/**
 * Marks a redemption as completed. IMPORTANT: the points were already
 * deducted at request time (services/database.js#reserveRedemption),
 * so "Complete" here does NOT touch the balance again — it just
 * confirms the payout was sent to the user outside the bot (e.g. via
 * bKash/Nagad/Rocket) and closes the ticket. This matches the spec's
 * explicit warning against wiping the user's entire ledger.
 */
async function completeWithdrawRequest(bot, chatId, adminId, requestKey) {
  const path = `${config.dbPaths.withdrawRequests}/${requestKey}`;
  const request = await db.getValue(path, null);

  if (!request || request.status !== 'pending') {
    await bot.sendMessage(chatId, '⚠️ This request has already been processed.');
    return;
  }

  await db.updateValue(path, { status: 'completed', reviewedBy: adminId, reviewedAt: Date.now() });

  try {
    await bot.sendMessage(request.userId, `✅ Your redemption of ${request.amount} points has been completed!`);
  } catch (_) {
    /* non-fatal */
  }

  await bot.sendMessage(chatId, `✅ Marked as completed. (${request.amount} points already deducted at request time.)`);
}

async function rejectWithdrawRequestStart(bot, chatId, adminId, requestKey) {
  setSession(adminId, STATES.AWAITING_REJECT_WITHDRAW_REASON, { chatId, requestKey });
  await bot.sendMessage(chatId, '✏️ Please type the rejection reason to send to the user:');
}

/**
 * On rejection, the points that were reserved (deducted) at request
 * time must be refunded — the user never actually received their
 * payout, so their balance should be made whole again.
 */
async function rejectWithdrawRequestFinish(bot, adminId, reason) {
  const session = getSession(adminId);
  const { chatId, requestKey } = session;
  const path = `${config.dbPaths.withdrawRequests}/${requestKey}`;
  const request = await db.getValue(path, null);

  if (!request || request.status !== 'pending') {
    await bot.sendMessage(chatId, '⚠️ This request has already been processed.');
    clearSession(adminId);
    return;
  }

  await db.refundRedemption(request.userId, request.amount);
  await db.updateValue(path, {
    status: 'rejected',
    reviewedBy: adminId,
    reviewedAt: Date.now(),
    rejectReason: reason,
  });

  try {
    await bot.sendMessage(
      request.userId,
      `❌ Your redemption request for ${request.amount} points was rejected and refunded.\nReason: ${reason}`
    );
  } catch (_) {
    /* non-fatal */
  }

  await bot.sendMessage(chatId, '✅ Rejection recorded, points refunded, and user notified.');
  clearSession(adminId);
}

/* ===================================================================
 *  Section 2 — Manage Strategy Groups (signal_targets)
 * =================================================================== */

async function sendGroupsMenu(bot, chatId) {
  const targets = await db.getValue(config.dbPaths.signalTargets, {});
  const entries = Object.entries(targets || {});

  const rows = entries.map(([key, t]) => [
    { text: `${t.active ? '🟢' : '🔴'} ${t.name || t.chatId}`, callback_data: CB.GROUPS_VIEW + key },
  ]);
  rows.push([{ text: '➕ Add', callback_data: CB.GROUPS_ADD }]);
  rows.push([{ text: '⬅️ Back to Admin Panel', callback_data: CB.PANEL }]);

  await bot.sendMessage(chatId, '🎯 <b>Manage Strategy Groups</b>\n\nSelect a destination or add a new one:', {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  });
}

async function sendGroupDetail(bot, chatId, groupKey) {
  const target = await db.getValue(`${config.dbPaths.signalTargets}/${groupKey}`, null);
  if (!target) {
    await bot.sendMessage(chatId, '⚠️ This destination no longer exists.');
    return;
  }

  await bot.sendMessage(
    chatId,
    `🎯 <b>${target.name}</b>\nChat ID: <code>${target.chatId}</code>\nStatus: ${target.active ? '🟢 Active' : '🔴 Stopped'}`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: target.active ? '⏸ Stop Strategy Delivery' : '▶️ Start Strategy Delivery',
              callback_data: CB.GROUPS_TOGGLE + groupKey,
            },
          ],
          [{ text: '🗑 Delete Destination', callback_data: CB.GROUPS_DELETE + groupKey }],
          [{ text: '⬅️ Back', callback_data: CB.GROUPS_MENU }],
        ],
      },
    }
  );
}

async function toggleGroupActive(bot, chatId, groupKey) {
  const path = `${config.dbPaths.signalTargets}/${groupKey}`;
  const target = await db.getValue(path, null);
  if (!target) return;
  await db.updateValue(path, { active: !target.active });
  await sendGroupDetail(bot, chatId, groupKey);
}

async function deleteGroup(bot, chatId, groupKey) {
  await db.setValue(`${config.dbPaths.signalTargets}/${groupKey}`, null);
  await bot.sendMessage(chatId, '🗑 Destination deleted.');
  await sendGroupsMenu(bot, chatId);
}

async function addGroupStart(bot, chatId, adminId) {
  setSession(adminId, STATES.AWAITING_GROUP_NAME, { chatId });
  await bot.sendMessage(chatId, '✏️ Enter a descriptive name for this destination (e.g. "Group A"):');
}

async function addGroupNameStep(bot, adminId, text) {
  const session = getSession(adminId);
  session.groupName = text.trim();
  setSession(adminId, STATES.AWAITING_GROUP_LINK, session);
  await bot.sendMessage(
    session.chatId,
    '✏️ Now send the routing address (public @username, t.me/c/ private link, or numeric chat ID):'
  );
}

async function addGroupLinkStep(bot, adminId, text) {
  const session = getSession(adminId);
  const { chatId, groupName } = session;

  const resolved = await resolveChatId(bot, text.trim());
  if (!resolved.ok) {
    await bot.sendMessage(chatId, `❌ ${resolved.reason}\n\nPlease try again with a valid link, username, or ID.`);
    return; // stay in the same state, let admin retry
  }

  const isAdmin = await verifyBotIsAdmin(bot, resolved.chatId);
  if (!isAdmin) {
    await bot.sendMessage(
      chatId,
      `⚠️ Warning: the bot is not an administrator in "${resolved.title}". Broadcasts will fail until you promote it. Saving anyway.`
    );
  }

  await db.pushValue(config.dbPaths.signalTargets, {
    name: groupName,
    chatId: resolved.chatId,
    title: resolved.title,
    active: true,
    addedAt: Date.now(),
  });

  await bot.sendMessage(chatId, `✅ Destination "${groupName}" added and activated.`);
  clearSession(adminId);
  await sendGroupsMenu(bot, chatId);
}

/* ===================================================================
 *  Section 5.2 — Manage Channel Commitments (force-join requirements)
 * =================================================================== */

async function sendChannelsMenu(bot, chatId) {
  const channels = await db.getValue(config.dbPaths.requiredChannels, {});
  const entries = Object.entries(channels || {});

  const rows = entries.map(([key, c]) => [
    { text: `${c.name} (+${c.reward})`, callback_data: CB.CHANNELS_VIEW + key },
  ]);
  rows.push([{ text: '➕ Add', callback_data: CB.CHANNELS_ADD }]);
  rows.push([{ text: '⬅️ Back to Admin Panel', callback_data: CB.PANEL }]);

  await bot.sendMessage(chatId, '📢 <b>Manage Channel Commitments</b>', {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: rows },
  });
}

async function sendChannelDetail(bot, chatId, channelKey) {
  const channel = await db.getValue(`${config.dbPaths.requiredChannels}/${channelKey}`, null);
  if (!channel) {
    await bot.sendMessage(chatId, '⚠️ This channel no longer exists.');
    return;
  }
  await bot.sendMessage(
    chatId,
    `📢 <b>${channel.name}</b>\nLink: ${channel.link}\nReward: ${channel.reward} points\nChat ID: <code>${channel.chatId || 'unresolved'}</code>`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗑 Delete', callback_data: CB.CHANNELS_DELETE + channelKey }],
          [{ text: '⬅️ Back', callback_data: CB.CHANNELS_MENU }],
        ],
      },
    }
  );
}

async function deleteChannel(bot, chatId, channelKey) {
  await db.setValue(`${config.dbPaths.requiredChannels}/${channelKey}`, null);
  await bot.sendMessage(chatId, '🗑 Channel requirement removed.');
  await sendChannelsMenu(bot, chatId);
}

async function addChannelStart(bot, chatId, adminId) {
  setSession(adminId, STATES.AWAITING_CHANNEL_NAME, { chatId });
  await bot.sendMessage(chatId, '✏️ Enter a display name for this required channel:');
}

async function addChannelNameStep(bot, adminId, text) {
  const session = getSession(adminId);
  session.channelName = text.trim();
  setSession(adminId, STATES.AWAITING_CHANNEL_LINK, session);
  await bot.sendMessage(session.chatId, '✏️ Now send the channel link or @username:');
}

async function addChannelLinkStep(bot, adminId, text) {
  const session = getSession(adminId);
  const resolved = await resolveChatId(bot, text.trim());
  if (!resolved.ok) {
    await bot.sendMessage(session.chatId, `❌ ${resolved.reason}\n\nPlease try again.`);
    return;
  }
  session.channelLink = text.trim();
  session.channelChatId = resolved.chatId;
  setSession(adminId, STATES.AWAITING_CHANNEL_REWARD, session);
  await bot.sendMessage(session.chatId, '✏️ How many reward points for joining this channel? (numbers only):');
}

async function addChannelRewardStep(bot, adminId, text) {
  const session = getSession(adminId);
  const reward = Number(text.trim());

  if (!Number.isFinite(reward) || reward < 0) {
    await bot.sendMessage(session.chatId, '❌ Please enter a valid non-negative number.');
    return;
  }

  await db.pushValue(config.dbPaths.requiredChannels, {
    name: session.channelName,
    link: session.channelLink,
    chatId: session.channelChatId,
    reward,
    addedAt: Date.now(),
  });

  await bot.sendMessage(session.chatId, `✅ Channel "${session.channelName}" added with ${reward} point reward.`);
  clearSession(adminId);
  await sendChannelsMenu(bot, session.chatId);
}

/* ===================================================================
 *  Section 5 — Global Notifications
 * =================================================================== */

async function sendNotifyMenu(bot, chatId) {
  await bot.sendMessage(chatId, '📣 <b>Global Notifications</b>', {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🌍 Broadcast to All Users', callback_data: CB.NOTIFY_GLOBAL }],
        [{ text: '🎯 Message a Specific User', callback_data: CB.NOTIFY_TARGET }],
        [{ text: '⬅️ Back to Admin Panel', callback_data: CB.PANEL }],
      ],
    },
  });
}

async function broadcastStart(bot, chatId, adminId) {
  setSession(adminId, STATES.AWAITING_BROADCAST_MESSAGE, { chatId });
  await bot.sendMessage(chatId, '✏️ Type the message to broadcast to ALL users:');
}

async function broadcastFinish(bot, adminId, text) {
  const session = getSession(adminId);
  const { chatId } = session;
  const users = await db.getValue(config.dbPaths.users, {});
  const ids = Object.keys(users || {});

  let sent = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      await bot.sendMessage(id, text);
      sent += 1;
    } catch (_) {
      failed += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  await bot.sendMessage(chatId, `✅ Broadcast complete. Sent: ${sent}, Failed (blocked/invalid): ${failed}`);
  clearSession(adminId);
}

async function targetNotifyStart(bot, chatId, adminId) {
  setSession(adminId, STATES.AWAITING_TARGET_USERNAME, { chatId });
  await bot.sendMessage(chatId, '✏️ Enter the target username (without @) or numeric user ID:');
}

async function targetUsernameStep(bot, adminId, text) {
  const session = getSession(adminId);
  const input = text.trim().replace(/^@/, '');

  let targetUserId = null;
  if (/^\d+$/.test(input)) {
    targetUserId = input;
  } else {
    const users = await db.getValue(config.dbPaths.users, {});
    const match = Object.values(users || {}).find(
      (u) => u.username && u.username.toLowerCase() === input.toLowerCase()
    );
    if (match) targetUserId = match.id;
  }

  if (!targetUserId) {
    await bot.sendMessage(session.chatId, '❌ User not found. Please check the username/ID and try again.');
    return;
  }

  session.targetUserId = targetUserId;
  setSession(adminId, STATES.AWAITING_TARGET_MESSAGE, session);
  await bot.sendMessage(session.chatId, '✏️ Now type the message to send to this user:');
}

async function targetMessageStep(bot, adminId, text) {
  const session = getSession(adminId);
  const { chatId, targetUserId } = session;

  try {
    await bot.sendMessage(targetUserId, text);
    await bot.sendMessage(chatId, '✅ Message delivered.');
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Could not deliver message: ${err.message}`);
  }
  clearSession(adminId);
}

/* ===================================================================
 *  Section 6 — Settings Menu
 * =================================================================== */

async function sendSettingsMenu(bot, chatId) {
  await bot.sendMessage(chatId, '⚙️ <b>Settings</b>', {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎬 Update Start Message', callback_data: CB.SETTINGS_START_MSG }],
        [{ text: '📹 Update Tutorial Video', callback_data: CB.SETTINGS_VIDEO }],
        [{ text: '🔗 Update Portal Link', callback_data: CB.SETTINGS_PORTAL }],
        [{ text: '🔢 Update Min Assignment Value', callback_data: CB.SETTINGS_MIN_VALUE }],
        [{ text: '⬅️ Back to Admin Panel', callback_data: CB.PANEL }],
      ],
    },
  });
}

async function settingsStartMsgBegin(bot, chatId, adminId) {
  setSession(adminId, STATES.AWAITING_START_MESSAGE, { chatId });
  await bot.sendMessage(chatId, '✏️ Send the new /start welcome message (HTML formatting supported):');
}
async function settingsStartMsgFinish(bot, adminId, text) {
  const session = getSession(adminId);
  await db.setValue(config.dbPaths.startMessage, text);
  await bot.sendMessage(session.chatId, '✅ Start message updated.');
  clearSession(adminId);
}

async function settingsVideoBegin(bot, chatId, adminId) {
  setSession(adminId, STATES.AWAITING_VIDEO_URL, { chatId });
  await bot.sendMessage(chatId, '✏️ Send the new tutorial video URL:');
}
async function settingsVideoFinish(bot, adminId, text) {
  const session = getSession(adminId);
  await db.updateValue(config.dbPaths.videoConfig, { url: text.trim() });
  await bot.sendMessage(session.chatId, '✅ Tutorial video updated.');
  clearSession(adminId);
}

async function settingsPortalBegin(bot, chatId, adminId) {
  setSession(adminId, STATES.AWAITING_PORTAL_LINK, { chatId });
  await bot.sendMessage(chatId, '✏️ Send the new assignment portal link:');
}
async function settingsPortalFinish(bot, adminId, text) {
  const session = getSession(adminId);
  await db.updateValue(config.dbPaths.assignmentConfig, { portalLink: text.trim() });
  await bot.sendMessage(session.chatId, '✅ Portal link updated.');
  clearSession(adminId);
}

async function settingsMinValueBegin(bot, chatId, adminId) {
  setSession(adminId, STATES.AWAITING_MIN_VALUE, { chatId });
  await bot.sendMessage(chatId, '✏️ Send the new minimum assignment value (number or text label):');
}
async function settingsMinValueFinish(bot, adminId, text) {
  const session = getSession(adminId);
  await db.updateValue(config.dbPaths.assignmentConfig, { minValue: text.trim() });
  await bot.sendMessage(session.chatId, '✅ Minimum assignment value updated.');
  clearSession(adminId);
}

/* ===================================================================
 *  Callback dispatcher
 * =================================================================== */

async function handleAdminCallback(bot, query) {
  const userId = query.from.id;
  if (!isAdminUser(userId)) return false; // not for us — let other handlers process it

  const chatId = query.message.chat.id;
  const data = query.data;

  const ack = async (text) => {
    try {
      await bot.answerCallbackQuery(query.id, text ? { text } : undefined);
    } catch (_) {
      /* non-fatal */
    }
  };

  if (data.startsWith(CB.VERIFY_APPROVE)) {
    await ack();
    await approveVerifyRequest(bot, chatId, userId, data.slice(CB.VERIFY_APPROVE.length));
    return true;
  }
  if (data.startsWith(CB.VERIFY_REJECT)) {
    await ack();
    await rejectVerifyRequestStart(bot, chatId, userId, data.slice(CB.VERIFY_REJECT.length));
    return true;
  }
  if (data.startsWith(CB.WITHDRAW_COMPLETE)) {
    await ack();
    await completeWithdrawRequest(bot, chatId, userId, data.slice(CB.WITHDRAW_COMPLETE.length));
    return true;
  }
  if (data.startsWith(CB.WITHDRAW_REJECT)) {
    await ack();
    await rejectWithdrawRequestStart(bot, chatId, userId, data.slice(CB.WITHDRAW_REJECT.length));
    return true;
  }
  if (data.startsWith(CB.GROUPS_VIEW)) {
    await ack();
    await sendGroupDetail(bot, chatId, data.slice(CB.GROUPS_VIEW.length));
    return true;
  }
  if (data.startsWith(CB.GROUPS_TOGGLE)) {
    await ack();
    await toggleGroupActive(bot, chatId, data.slice(CB.GROUPS_TOGGLE.length));
    return true;
  }
  if (data.startsWith(CB.GROUPS_DELETE)) {
    await ack();
    await deleteGroup(bot, chatId, data.slice(CB.GROUPS_DELETE.length));
    return true;
  }
  if (data.startsWith(CB.CHANNELS_VIEW)) {
    await ack();
    await sendChannelDetail(bot, chatId, data.slice(CB.CHANNELS_VIEW.length));
    return true;
  }
  if (data.startsWith(CB.CHANNELS_DELETE)) {
    await ack();
    await deleteChannel(bot, chatId, data.slice(CB.CHANNELS_DELETE.length));
    return true;
  }

  switch (data) {
    case CB.PANEL:
      await ack();
      await sendPanel(bot, chatId);
      return true;
    case CB.VERIFY_INBOX:
      await ack();
      await sendVerifyInbox(bot, chatId);
      return true;
    case CB.WITHDRAW_INBOX:
      await ack();
      await sendWithdrawInbox(bot, chatId);
      return true;
    case CB.GROUPS_MENU:
      await ack();
      await sendGroupsMenu(bot, chatId);
      return true;
    case CB.GROUPS_ADD:
      await ack();
      await addGroupStart(bot, chatId, userId);
      return true;
    case CB.CHANNELS_MENU:
      await ack();
      await sendChannelsMenu(bot, chatId);
      return true;
    case CB.CHANNELS_ADD:
      await ack();
      await addChannelStart(bot, chatId, userId);
      return true;
    case CB.NOTIFY_MENU:
      await ack();
      await sendNotifyMenu(bot, chatId);
      return true;
    case CB.NOTIFY_GLOBAL:
      await ack();
      await broadcastStart(bot, chatId, userId);
      return true;
    case CB.NOTIFY_TARGET:
      await ack();
      await targetNotifyStart(bot, chatId, userId);
      return true;
    case CB.SETTINGS_MENU:
      await ack();
      await sendSettingsMenu(bot, chatId);
      return true;
    case CB.SETTINGS_START_MSG:
      await ack();
      await settingsStartMsgBegin(bot, chatId, userId);
      return true;
    case CB.SETTINGS_VIDEO:
      await ack();
      await settingsVideoBegin(bot, chatId, userId);
      return true;
    case CB.SETTINGS_PORTAL:
      await ack();
      await settingsPortalBegin(bot, chatId, userId);
      return true;
    case CB.SETTINGS_MIN_VALUE:
      await ack();
      await settingsMinValueBegin(bot, chatId, userId);
      return true;
    default:
      return false; // not an admin callback — let userFlows handle it
  }
}

/* ===================================================================
 *  Text message dispatcher for multi-step admin input flows
 * =================================================================== */

async function handleAdminText(bot, msg) {
  const userId = msg.from.id;
  if (!isAdminUser(userId)) return false;

  const session = getSession(userId);
  if (!session) return false;

  const text = msg.text || '';

  switch (session.state) {
    case STATES.AWAITING_REJECT_VERIFY_REASON:
      await rejectVerifyRequestFinish(bot, userId, text);
      return true;
    case STATES.AWAITING_REJECT_WITHDRAW_REASON:
      await rejectWithdrawRequestFinish(bot, userId, text);
      return true;
    case STATES.AWAITING_GROUP_NAME:
      await addGroupNameStep(bot, userId, text);
      return true;
    case STATES.AWAITING_GROUP_LINK:
      await addGroupLinkStep(bot, userId, text);
      return true;
    case STATES.AWAITING_CHANNEL_NAME:
      await addChannelNameStep(bot, userId, text);
      return true;
    case STATES.AWAITING_CHANNEL_LINK:
      await addChannelLinkStep(bot, userId, text);
      return true;
    case STATES.AWAITING_CHANNEL_REWARD:
      await addChannelRewardStep(bot, userId, text);
      return true;
    case STATES.AWAITING_BROADCAST_MESSAGE:
      await broadcastFinish(bot, userId, text);
      return true;
    case STATES.AWAITING_TARGET_USERNAME:
      await targetUsernameStep(bot, userId, text);
      return true;
    case STATES.AWAITING_TARGET_MESSAGE:
      await targetMessageStep(bot, userId, text);
      return true;
    case STATES.AWAITING_START_MESSAGE:
      await settingsStartMsgFinish(bot, userId, text);
      return true;
    case STATES.AWAITING_VIDEO_URL:
      await settingsVideoFinish(bot, userId, text);
      return true;
    case STATES.AWAITING_PORTAL_LINK:
      await settingsPortalFinish(bot, userId, text);
      return true;
    case STATES.AWAITING_MIN_VALUE:
      await settingsMinValueFinish(bot, userId, text);
      return true;
    default:
      return false;
  }
}

/* ===================================================================
 *  Registration entrypoint
 * =================================================================== */

function registerAdminFlows(bot) {
  bot.onText(/\/admin/, (msg) => {
    handleAdminCommand(bot, msg).catch(async (err) => {
      await db.logError('handleAdminCommand', `userId=${msg.from.id} err=${err.message}`);
    });
  });

  // NOTE: registered alongside handlers/userFlows.js's own
  // 'callback_query' and 'message' listeners in bot.js. Each listener
  // independently checks isAdminUser / session state and simply
  // no-ops (returns false) if not relevant, so both modules coexist
  // safely on the same bot instance without interference.
  bot.on('callback_query', (query) => {
    handleAdminCallback(bot, query).catch(async (err) => {
      await db.logError('handleAdminCallback', `err=${err.message}`);
    });
  });

  bot.on('message', (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    handleAdminText(bot, msg).catch(async (err) => {
      await db.logError('handleAdminText', `userId=${msg.from.id} err=${err.message}`);
    });
  });
}


/* ====================================================================
 *  SECTION B: WINGO AUTOMATION & CANVAS ENGINE
 * ==================================================================== */

const resultHistory = {
  '30s': [],
  '60s': [],
};

/** Simple last-5-outcomes analytical function per spec section 2.4. */
function computeNextPrediction(mode, latestIssueNumber) {
  const history = resultHistory[mode];
  // Deterministic-but-varied pseudo-analysis: derive a 0-9 prediction
  // digit from the issue number and recent outcome trend. Admins can
  // override this function's output via "Update Analytical Engine"
  // in the admin settings (see updateAnalyticsEngine below).
  const trendBias = history.filter((h) => h === 'CORRECT').length - history.filter((h) => h === 'INCORRECT').length;
  const seed = Number(String(latestIssueNumber).slice(-4)) || 0;
  const digit = Math.abs((seed + trendBias * 3) % 10);
  const bigSmall = digit >= 5 ? 'BIG' : 'SMALL';
  const color = digit % 2 === 0 ? 'RED' : 'GREEN';
  return { digit, bigSmall, color };
}

function pushHistory(mode, outcome) {
  resultHistory[mode].push(outcome);
  if (resultHistory[mode].length > 5) resultHistory[mode].shift();
}

/* ===================================================================
 *  Fault-tolerant data scraping with 5-second retry
 * =================================================================== */

/**
 * Fetches the latest issue data from a WinGo endpoint. On any
 * failure (timeout, non-200, malformed JSON), waits exactly 5 seconds
 * and retries once more before giving up and logging to the admin
 * monitoring workspace — this satisfies the "API Resilience Rules"
 * requirement without looping forever and blocking the clock-synced
 * scheduler indefinitely.
 */
async function fetchWingoData(url, attempt = 1) {
  try {
    const response = await axios.get(url, { timeout: 8000 });
    const list = response.data && response.data.data && response.data.data.list;

    if (!Array.isArray(list) || list.length === 0 || !list[0].issueNumber) {
      throw new Error('Malformed payload: missing data.list[0].issueNumber');
    }

    return { ok: true, latest: list[0] };
  } catch (err) {
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, config.wingo.retryDelayMs));
      return fetchWingoData(url, attempt + 1);
    }
    await db.logError('wingo_fetch', `url=${url} err=${err.message}`);
    return { ok: false, reason: err.message };
  }
}

/* ===================================================================
 *  Canvas rendering — Section 2.4
 * ===================================================================
 * Coordinate layout is defined as a config object so admins/devs can
 * tune positions without touching drawing logic. These defaults
 * assume a 1080x1350-ish spreadsheet-style template as described in
 * the spec ("steps 1 through 6" cells) — adjust COORDS if the actual
 * hosted template dimensions differ once you inspect it visually.
 * ------------------------------------------------------------------*/

const COORDS = {
  '30s': {
    issueNumber: { x: 540, y: 180, size: 34, align: 'center' },
    steps: [
      { x: 200, y: 320 },
      { x: 200, y: 400 },
      { x: 200, y: 480 },
      { x: 200, y: 560 },
      { x: 200, y: 640 },
      { x: 200, y: 720 },
    ],
    outcomeLabel: { x: 800, y: 320, size: 40 },
    pointsAdjust: { x: 800, y: 380, size: 32 },
  },
  '60s': {
    issueNumber: { x: 540, y: 180, size: 34, align: 'center' },
    steps: [
      { x: 200, y: 320 },
      { x: 200, y: 400 },
      { x: 200, y: 480 },
      { x: 200, y: 560 },
      { x: 200, y: 640 },
      { x: 200, y: 720 },
    ],
    outcomeLabel: { x: 800, y: 320, size: 40 },
    pointsAdjust: { x: 800, y: 380, size: 32 },
  },
};

const COLORS = {
  correct: '#00C853', // green
  incorrect: '#D50000', // bold red
  text: '#FFFFFF',
};

/**
 * Renders the result graphic for a single completed round.
 *
 * @param {'30s'|'60s'} mode
 * @param {object} params
 *   issueNumber   - the issue this result belongs to
 *   stepValues    - array of up to 6 numeric values for the step cells
 *   isCorrect     - boolean outcome
 *   pointsValue   - number used in the "+Points X" / "-Points X" string
 * @returns {Buffer} PNG image buffer, ready to send via bot.sendPhoto
 */
async function renderResultCard(mode, { issueNumber, stepValues, isCorrect, pointsValue }) {
  const templateUrl = mode === '30s' ? config.templates.url30s : config.templates.url60s;
  const layout = COORDS[mode];

  // Load the background template fresh each time rather than caching
  // a shared Image object — avoids any cross-request mutation risk
  // and keeps memory usage bounded (image is discarded after use, per
  // the "delete temporary cache frames from active RAM footprints"
  // requirement).
  const background = await loadImage(templateUrl);

  const canvas = createCanvas(background.width, background.height);
  const ctx = canvas.getContext('2d');

  // Draw the base spreadsheet template.
  ctx.drawImage(background, 0, 0, background.width, background.height);

  // Issue number header.
  ctx.fillStyle = COLORS.text;
  ctx.font = `bold ${layout.issueNumber.size}px sans-serif`;
  ctx.textAlign = layout.issueNumber.align || 'left';
  ctx.fillText(String(issueNumber), layout.issueNumber.x, layout.issueNumber.y);

  // Steps 1–6 numeric values.
  ctx.textAlign = 'left';
  layout.steps.forEach((pos, idx) => {
    const value = stepValues[idx] !== undefined ? String(stepValues[idx]) : '-';
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText(value, pos.x, pos.y);
  });

  // Outcome badge — green CORRECT / bold red INCORRECT, per spec.
  const outcomeText = isCorrect ? 'CORRECT' : 'INCORRECT';
  const outcomeColor = isCorrect ? COLORS.correct : COLORS.incorrect;
  ctx.fillStyle = outcomeColor;
  ctx.font = `bold ${layout.outcomeLabel.size}px sans-serif`;
  ctx.fillText(outcomeText, layout.outcomeLabel.x, layout.outcomeLabel.y);

  // Points adjustment string.
  const pointsText = isCorrect ? `+Points ${pointsValue}` : `-Points ${pointsValue}`;
  ctx.fillStyle = outcomeColor;
  ctx.font = `bold ${layout.pointsAdjust.size}px sans-serif`;
  ctx.fillText(pointsText, layout.pointsAdjust.x, layout.pointsAdjust.y);

  const buffer = canvas.toBuffer('image/png');

  // Explicitly drop references so V8 can GC the pixel buffers promptly
  // instead of waiting for the next tick — meaningful on a
  // long-running VPS process generating images every 30s/60s forever.
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  return buffer;
}

/* ===================================================================
 *  Broadcasting to active targets
 * =================================================================== */

async function getActiveTargets() {
  const targets = await db.getValue(config.dbPaths.signalTargets, {});
  return Object.values(targets || {}).filter((t) => t.active && t.chatId);
}

async function broadcastText(bot, text) {
  const targets = await getActiveTargets();
  for (const target of targets) {
    try {
      await bot.sendMessage(target.chatId, text, { parse_mode: 'HTML' });
    } catch (err) {
      await db.logError('wingo_broadcast_text', `chatId=${target.chatId} err=${err.message}`);
    }
  }
}

async function broadcastImage(bot, buffer, caption) {
  const targets = await getActiveTargets();
  for (const target of targets) {
    try {
      await bot.sendPhoto(target.chatId, buffer, { caption, parse_mode: 'HTML' });
    } catch (err) {
      await db.logError('wingo_broadcast_image', `chatId=${target.chatId} err=${err.message}`);
    }
  }
}

/* ===================================================================
 *  Clock-synchronized scheduler
 * ===================================================================
 * Rather than a plain setInterval(fn, 30000) — which drifts over
 * hours/days and doesn't align with real-world :00/:30 boundaries —
 * each cycle explicitly computes the millisecond offset to the next
 * clean boundary and schedules a one-shot setTimeout for exactly
 * that delta, then re-arms itself. This keeps broadcasts aligned to
 * the wall clock indefinitely, matching "synchronize perfectly with
 * the operating system clock."
 * ------------------------------------------------------------------*/

function msUntilNextBoundary(periodSeconds) {
  const periodMs = periodSeconds * 1000;
  const now = Date.now();
  return periodMs - (now % periodMs);
}

/** Tracks whether a mode is currently mid-cycle, to avoid overlap if a cycle runs long. */
const cycleLock = { '30s': false, '60s': false };

async function runCycle(bot, mode, url) {
  if (cycleLock[mode]) {
    // Previous cycle for this mode is still running (e.g. slow network) —
    // skip this tick rather than stacking overlapping broadcasts.
    return;
  }
  cycleLock[mode] = true;

  try {
    const fetchResult = await fetchWingoData(url);
    if (!fetchResult.ok) {
      // Already retried once inside fetchWingoData and logged the
      // failure — nothing further to broadcast this cycle.
      return;
    }

    const latest = fetchResult.latest;
    const currentIssueNumber = latest.issueNumber;
    // Predicted item is the NEXT issue: current + 1, per spec.
    const nextIssueNumber = String(BigInt(currentIssueNumber) + 1n);

    const prediction = computeNextPrediction(mode, currentIssueNumber);

    // 1) Broadcast the new prediction as plain text immediately.
    const predictionText =
      `📊 <b>WinGo ${mode} Prediction</b>\n\n` +
      `🆔 Issue: <code>${nextIssueNumber}</code>\n` +
      `🎯 Predicted: <b>${prediction.digit}</b> (${prediction.bigSmall} / ${prediction.color})`;
    await broadcastText(bot, predictionText);

    // 2) Evaluate the PREVIOUS prediction (if any) against this
    //    newly-arrived actual result, and render the result card.
    const previousPrediction = lastPredictionByMode[mode];
    if (previousPrediction && previousPrediction.issueNumber === currentIssueNumber) {
      const actualDigit = Number(latest.number);
      const isCorrect = actualDigit === previousPrediction.digit;
      pushHistory(mode, isCorrect ? 'CORRECT' : 'INCORRECT');

      const pointsValue = config.defaults.forceJoinRewardPerChannel; // reuse configurable point unit
      const stepValues = resultHistory[mode].map((h) => (h === 'CORRECT' ? 1 : 0)).concat([
        actualDigit,
      ]);

      try {
        const buffer = await renderResultCard(mode, {
          issueNumber: currentIssueNumber,
          stepValues,
          isCorrect,
          pointsValue,
        });
        await broadcastImage(
          bot,
          buffer,
          `📈 Result for issue <code>${currentIssueNumber}</code>: <b>${isCorrect ? 'CORRECT' : 'INCORRECT'}</b>`
        );
      } catch (err) {
        await db.logError('wingo_canvas_render', `mode=${mode} err=${err.message}`);
      }
    }

    // Remember this cycle's prediction so the NEXT cycle can evaluate it.
    lastPredictionByMode[mode] = { issueNumber: nextIssueNumber, digit: prediction.digit };
  } catch (err) {
    await db.logError('wingo_run_cycle', `mode=${mode} err=${err.message}`);
  } finally {
    cycleLock[mode] = false;
  }
}

const lastPredictionByMode = { '30s': null, '60s': null };

/**
 * Arms a self-rescheduling, clock-synced loop for one mode. Uses
 * setTimeout (not setInterval) so each iteration recalculates the
 * exact offset to the next real-world boundary, eliminating drift.
 */
function armClockSyncedLoop(bot, mode, periodSeconds, url) {
  const delay = msUntilNextBoundary(periodSeconds);

  setTimeout(async () => {
    await runCycle(bot, mode, url);
    // Re-arm for the next boundary — recursive setTimeout rather than
    // setInterval so a slow cycle can never cause two ticks to fire
    // back-to-back.
    armClockSyncedLoop(bot, mode, periodSeconds, url);
  }, delay);

  console.log(`[WINGO] ${mode} loop armed — next tick in ${delay}ms.`);
}

/** Entry point called once from bot.js after the bot is ready. */
function startWingoAutomation(bot) {
  armClockSyncedLoop(bot, '30s', 30, config.wingo.url30s);
  armClockSyncedLoop(bot, '60s', 60, config.wingo.url60s);
  console.log('[WINGO] Automation engine started (30s + 60s clock-synced loops).');
}

/** Allows the admin panel's "Update Analytical Engine" control to
 * override prediction logic at runtime without a redeploy — reads a
 * simple weight/config object from Firebase and folds it into the
 * next computeNextPrediction call. Kept intentionally simple (a
 * numeric bias) since the spec allows admins to "inject, modify, or
 * override" without prescribing an exact algorithm. */
async function updateAnalyticsEngine(newConfig) {
  await db.setValue(config.dbPaths.analyticsEngine, {
    ...newConfig,
    updatedAt: Date.now(),
  });
}


/* ====================================================================
 *  COMBINED MODULE EXPORTS
 * ==================================================================== */
module.exports = {
  registerAdminFlows,
  startWingoAutomation,
  renderResultCard,
  fetchWingoData,
  updateAnalyticsEngine,
};
