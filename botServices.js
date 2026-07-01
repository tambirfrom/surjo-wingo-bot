'use strict';

/**
 * services/botServices.js
 * ---------------------------------------------------------------------
 * Combines two categories of low-level integrations that the user
 * flow and admin handlers both depend on:
 *
 *   1. ImgBB upload  — sends a screenshot buffer to ImgBB with strict
 *      fault tolerance (oversized payloads, dropped connections,
 *      timeouts must never crash the bot process).
 *
 *   2. Telegram helpers — Force Join membership checking against
 *      configured channels, and chat-ID resolution for the admin
 *      "Manage Strategy Groups" feature (public usernames, private
 *      t.me/c/ links, and raw handles all normalize to a numeric
 *      Telegram chat ID, e.g. -100xxxxxxxxxx for channels/groups).
 * ---------------------------------------------------------------------
 */

const axios = require('axios');
const FormData = require('form-data');
const config = require('../config');
const db = require('./database');

/* ===================================================================
 *  1. ImgBB UPLOAD SERVICE
 * =================================================================== */

/**
 * Uploads an image buffer to ImgBB.
 *
 * Returns: { ok: true, url, displayUrl } on success
 *          { ok: false, userMessage } on any failure — the caller can
 *          forward `userMessage` straight to the Telegram user without
 *          ever needing to know what went wrong internally.
 *
 * This function intentionally never throws — every failure path is
 * caught and converted into a structured, user-safe result, matching
 * the "Robust Fault Tolerance" requirement.
 */
async function uploadToImgbb(buffer, filename = 'screenshot.jpg') {
  try {
    // Defensive size guard BEFORE we even attempt the network call.
    // ImgBB's free tier hard-caps uploads at 32MB; Telegram photos are
    // virtually never this large, but documents-as-photos can be.
    const MAX_BYTES = 32 * 1024 * 1024;
    if (!buffer || buffer.length === 0) {
      return { ok: false, userMessage: 'Upload failed. The received file was empty. Please try again.' };
    }
    if (buffer.length > MAX_BYTES) {
      return {
        ok: false,
        userMessage: 'Upload failed. Please try again or submit a lower-resolution file.',
      };
    }

    const form = new FormData();
    form.append('image', buffer, { filename });

    const response = await axios.post(config.imgbb.uploadEndpoint, form, {
      params: { key: config.imgbb.apiKey },
      headers: form.getHeaders(),
      timeout: 20000, // 20s — prevents a hung connection from blocking the bot indefinitely
      maxContentLength: MAX_BYTES,
      maxBodyLength: MAX_BYTES,
    });

    const data = response && response.data && response.data.data;
    if (!data || !data.url) {
      await db.logError('imgbb_upload', 'Malformed ImgBB response: ' + JSON.stringify(response.data));
      return { ok: false, userMessage: 'Upload failed. Please try again or submit a lower-resolution file.' };
    }

    return { ok: true, url: data.url, displayUrl: data.display_url || data.url };
  } catch (err) {
    // Covers: payload-too-large from server side, ECONNRESET, ETIMEDOUT,
    // DNS failures, 4xx/5xx from ImgBB, malformed multipart, etc.
    const reason = err.response
      ? `ImgBB responded ${err.response.status}`
      : err.code || err.message;
    await db.logError('imgbb_upload', reason);
    return {
      ok: false,
      userMessage: 'Upload failed. Please try again or submit a lower-resolution file.',
    };
  }
}

/* ===================================================================
 *  2. FORCE-JOIN MEMBERSHIP CHECKING
 * =================================================================== */

/** Telegram membership statuses that count as "still in the channel". */
const ACTIVE_MEMBER_STATUSES = new Set(['member', 'administrator', 'creator']);

/**
 * Checks a user's live membership status against every channel listed
 * in settings/required_channels.
 *
 * Required channel node shape:
 *   { name: 'Main Channel', link: 'https://t.me/...', chatId: '-100123...', reward: 5 }
 *
 * Returns:
 *   {
 *     allJoined: boolean,
 *     missing: [{ key, name, link }],     // channels the user has NOT joined
 *     totalReward: number,                // sum of reward across ALL required channels
 *   }
 */
async function checkForceJoinMembership(bot, userId) {
  const channels = await db.getValue(config.dbPaths.requiredChannels, {});
  const entries = Object.entries(channels || {});

  if (entries.length === 0) {
    // No force-join requirement configured — treat as fully passed.
    return { allJoined: true, missing: [], totalReward: 0 };
  }

  const missing = [];
  let totalReward = 0;

  for (const [key, channel] of entries) {
    totalReward += Number(channel.reward) || 0;

    if (!channel.chatId) {
      // Misconfigured channel (admin never resolved its chat ID) —
      // don't silently let users bypass it; flag it as missing and
      // log for admin attention rather than crashing the check loop.
      missing.push({ key, name: channel.name || 'Unknown Channel', link: channel.link || '' });
      continue;
    }

    try {
      const member = await bot.getChatMember(channel.chatId, userId);
      if (!ACTIVE_MEMBER_STATUSES.has(member.status)) {
        missing.push({ key, name: channel.name || 'Unknown Channel', link: channel.link || '' });
      }
    } catch (err) {
      // Common causes: bot isn't an admin in the channel, user has
      // never started a conversation context with that chat, channel
      // was deleted, etc. We fail "closed" (treat as not-joined)
      // rather than silently granting access on an API error.
      await db.logError(
        'force_join_check',
        `chatId=${channel.chatId} userId=${userId} err=${err.message}`
      );
      missing.push({ key, name: channel.name || 'Unknown Channel', link: channel.link || '' });
    }
  }

  return { allJoined: missing.length === 0, missing, totalReward };
}

/* ===================================================================
 *  3. CHAT ID RESOLUTION  (admin "Manage Strategy Groups" feature)
 * =================================================================== */

/**
 * Normalizes any of the following inputs into a real, numeric
 * Telegram chat ID the Bot API can broadcast to:
 *   - "@publicusername"
 *   - "https://t.me/publicusername"
 *   - "https://t.me/c/1234567890/100"   (private channel/group link)
 *   - a raw numeric ID already (e.g. "-1001234567890")
 *
 * Returns: { ok: true, chatId, title } or { ok: false, reason }
 *
 * `reason` is a human-readable string the admin handler can relay
 * directly, e.g. "Bot is not a member of this chat."
 */
async function resolveChatId(bot, rawInput) {
  const input = String(rawInput).trim();

  try {
    // Case 1: private channel/group link → t.me/c/<internalId>/<msgId>
    // The internal ID needs a "-100" prefix to become a valid Bot API
    // chat ID for supergroups/channels.
    const privateMatch = input.match(/t\.me\/c\/(\d+)(?:\/\d+)?/i);
    if (privateMatch) {
      const internalId = privateMatch[1];
      const chatId = `-100${internalId}`;
      const chat = await bot.getChat(chatId);
      return { ok: true, chatId: String(chat.id), title: chat.title || chat.username || chatId };
    }

    // Case 2: public username, with or without an @ or full t.me/ URL.
    const publicMatch = input.match(/(?:t\.me\/|^@)([a-zA-Z0-9_]{5,})$/i);
    let usernameCandidate = null;
    if (publicMatch) {
      usernameCandidate = publicMatch[1];
    } else if (/^[a-zA-Z0-9_]{5,}$/.test(input)) {
      // Bare handle with no @ and no URL prefix, e.g. "MyChannel"
      usernameCandidate = input;
    }

    if (usernameCandidate) {
      const chat = await bot.getChat(`@${usernameCandidate}`);
      return { ok: true, chatId: String(chat.id), title: chat.title || chat.username || usernameCandidate };
    }

    // Case 3: already a raw numeric chat ID (negative for groups/channels).
    if (/^-?\d+$/.test(input)) {
      const chat = await bot.getChat(input);
      return { ok: true, chatId: String(chat.id), title: chat.title || input };
    }

    return { ok: false, reason: 'Could not parse this as a username, link, or chat ID.' };
  } catch (err) {
    // Most common real-world cause per spec: bot isn't a member/admin
    // of the destination, or the chat doesn't exist / is private and
    // unreachable without an invite.
    const reason =
      err.response && err.response.body && err.response.body.description
        ? err.response.body.description
        : err.message;
    return {
      ok: false,
      reason: `Bot lacks membership or administrative access to this destination (${reason}).`,
    };
  }
}

/**
 * Verifies the bot has admin rights in a resolved chat — used before
 * activating broadcast delivery to a new target, since posting will
 * silently fail otherwise.
 */
async function verifyBotIsAdmin(bot, chatId) {
  try {
    const me = await bot.getMe();
    const member = await bot.getChatMember(chatId, me.id);
    return member.status === 'administrator' || member.status === 'creator';
  } catch (err) {
    return false;
  }
}

module.exports = {
  uploadToImgbb,
  checkForceJoinMembership,
  resolveChatId,
  verifyBotIsAdmin,
  ACTIVE_MEMBER_STATUSES,
};
