'use strict';

/**
 * services/database.js
 * ---------------------------------------------------------------------
 * Thin, opinionated wrapper around the Firebase Realtime Database.
 *
 * Why this file exists:
 *   Several requirements in the spec are explicit exploit-prevention
 *   rules — "this must run exactly once", "block duplicate payout if
 *   admin toggles approval back and forth", "never let a user redeem
 *   more points than they actually have". Those are race-condition
 *   bugs waiting to happen if written as naive read-then-write code
 *   (two simultaneous clicks can both read "false" before either
 *   write lands). Firebase `transaction()` solves this by re-running
 *   the update function against the latest server value if it detects
 *   a conflicting write, so every state-changing operation below is
 *   implemented as a transaction, not a get()+set() pair.
 * ---------------------------------------------------------------------
 */

const { db } = require('../config/firebase');
const config = require('../config');

/* ----------------------------------------------------------------- *
 *  Generic helpers
 * ----------------------------------------------------------------- */

/** Read a path once and return its value (or `fallback` if absent). */
async function getValue(path, fallback = null) {
  try {
    const snap = await db.ref(path).once('value');
    return snap.exists() ? snap.val() : fallback;
  } catch (err) {
    console.error(`[DB] getValue failed for "${path}":`, err.message);
    throw err;
  }
}

/** Write a value, fully replacing whatever was at that path. */
async function setValue(path, value) {
  try {
    await db.ref(path).set(value);
  } catch (err) {
    console.error(`[DB] setValue failed for "${path}":`, err.message);
    throw err;
  }
}

/** Shallow-merge an update into an existing object at `path`. */
async function updateValue(path, patch) {
  try {
    await db.ref(path).update(patch);
  } catch (err) {
    console.error(`[DB] updateValue failed for "${path}":`, err.message);
    throw err;
  }
}

/** Append a new child with an auto-generated key; returns that key. */
async function pushValue(path, value) {
  try {
    const ref = await db.ref(path).push(value);
    return ref.key;
  } catch (err) {
    console.error(`[DB] pushValue failed for "${path}":`, err.message);
    throw err;
  }
}

/**
 * Run an atomic transaction at `path`. `updateFn` receives the current
 * value (or null) and must return the new value to write, or
 * `undefined` to abort without writing.
 * Returns { committed, snapshot }.
 */
async function runTransaction(path, updateFn) {
  try {
    const result = await db.ref(path).transaction(updateFn);
    return result;
  } catch (err) {
    console.error(`[DB] transaction failed for "${path}":`, err.message);
    throw err;
  }
}

/* ----------------------------------------------------------------- *
 *  User profile management
 * ----------------------------------------------------------------- */

function userPath(userId) {
  return `${config.dbPaths.users}/${userId}`;
}

/** Fetch a user's full profile, or null if they've never interacted. */
async function getUser(userId) {
  return getValue(userPath(userId), null);
}

/**
 * Ensure a user node exists with sane defaults. Safe to call on every
 * /start — it never overwrites existing fields, only fills gaps.
 */
async function ensureUser(userId, { username = null, referredBy = null } = {}) {
  const path = userPath(userId);
  const existing = await getValue(path, null);
  if (existing) return existing;

  const newUser = {
    id: userId,
    username: username || null,
    balance: 0,
    isVerified: false,
    has_claimed_force_join_bonus: false,
    referredBy: referredBy || null,
    is_referral_commission_paid: false,
    joinedAt: Date.now(),
    totalReferrals: 0,
  };
  await setValue(path, newUser);
  return newUser;
}

/**
 * Atomically adjust a user's balance by `delta` (positive or negative).
 * Returns the resulting committed balance, or null if the transaction
 * was aborted (e.g. would-be-negative balance on a debit).
 */
async function adjustBalance(userId, delta) {
  const path = `${userPath(userId)}/balance`;
  const { committed, snapshot } = await runTransaction(path, (current) => {
    const currentBalance = typeof current === 'number' ? current : 0;
    const next = currentBalance + delta;
    // Guard rail: never let a transaction push balance below zero.
    if (next < 0) return; // undefined => abort, no write
    return next;
  });
  return committed ? snapshot.val() : null;
}

/* ----------------------------------------------------------------- *
 *  Exploit-prevention #1: Single force-join bonus claim
 * ----------------------------------------------------------------- */

/**
 * Atomically claims the force-join bonus for a user, exactly once,
 * regardless of how many times "Verify Entry" is clicked concurrently.
 *
 * Returns:
 *   { claimed: true,  newBalance }  if this call won the claim
 *   { claimed: false, newBalance }  if it was already claimed before
 */
async function claimForceJoinBonus(userId, rewardAmount) {
  const path = userPath(userId);
  let wonClaim = false;

  const { committed, snapshot } = await runTransaction(path, (user) => {
    if (!user) return; // user node doesn't exist yet — abort, caller should ensureUser first
    if (user.has_claimed_force_join_bonus === true) {
      // Already claimed — abort the transaction, no write, no double pay.
      return;
    }
    wonClaim = true;
    user.has_claimed_force_join_bonus = true;
    user.balance = (typeof user.balance === 'number' ? user.balance : 0) + rewardAmount;
    return user;
  });

  if (!committed || !wonClaim) {
    const current = await getUser(userId);
    return { claimed: false, newBalance: current ? current.balance : 0 };
  }
  return { claimed: true, newBalance: snapshot.val().balance };
}

/* ----------------------------------------------------------------- *
 *  Exploit-prevention #2: Referral commission double-payment lockout
 * ----------------------------------------------------------------- */

/**
 * Atomically pays a referral commission to `referrerId` for the
 * verification of `invitedUserId`, but ONLY the first time. If the
 * admin toggles the invited user's verification on/off repeatedly,
 * the lock on the invited user's own node prevents any repeat payout.
 *
 * Returns:
 *   { paid: true }   if commission was newly paid this call
 *   { paid: false }  if it was already paid previously (no-op)
 */
async function payReferralCommissionOnce(invitedUserId, referrerId, commissionAmount) {
  const lockPath = `${userPath(invitedUserId)}/is_referral_commission_paid`;
  let wonLock = false;

  // Step 1: atomically flip the lock flag on the INVITED user's node.
  // This is the single source of truth that prevents double payment —
  // it does not matter how many times the admin re-approves the user,
  // this transaction can only ever succeed once.
  const { committed } = await runTransaction(lockPath, (currentFlag) => {
    if (currentFlag === true) return; // already paid — abort
    wonLock = true;
    return true;
  });

  if (!committed || !wonLock) {
    return { paid: false };
  }

  // Step 2: lock acquired — now actually credit the referrer.
  await adjustBalance(referrerId, commissionAmount);

  // Step 3: bump the referrer's lifetime referral counter for stats.
  await runTransaction(`${userPath(referrerId)}/totalReferrals`, (current) => {
    return (typeof current === 'number' ? current : 0) + 1;
  });

  return { paid: true };
}

/* ----------------------------------------------------------------- *
 *  Exploit-prevention #3: Redemption cannot exceed actual balance
 * ----------------------------------------------------------------- */

/**
 * Atomically validates and reserves a redemption request: checks the
 * requested amount against the user's CURRENT server-side balance
 * (never trust a client-cached balance) and deducts it immediately so
 * it can't be double-spent while the admin reviews the request.
 *
 * Returns:
 *   { ok: true,  newBalance }
 *   { ok: false, reason: 'INSUFFICIENT_BALANCE' | 'USER_NOT_FOUND' }
 */
async function reserveRedemption(userId, requestedAmount) {
  const path = userPath(userId);
  let failReason = null;

  const { committed, snapshot } = await runTransaction(path, (user) => {
    if (!user) {
      failReason = 'USER_NOT_FOUND';
      return;
    }
    const balance = typeof user.balance === 'number' ? user.balance : 0;
    if (requestedAmount > balance) {
      failReason = 'INSUFFICIENT_BALANCE';
      return; // abort — do not deduct
    }
    user.balance = balance - requestedAmount;
    return user;
  });

  if (!committed) {
    return { ok: false, reason: failReason || 'UNKNOWN' };
  }
  return { ok: true, newBalance: snapshot.val().balance };
}

/** Refund a previously reserved redemption if the admin rejects it. */
async function refundRedemption(userId, amount) {
  return adjustBalance(userId, amount);
}

/* ----------------------------------------------------------------- *
 *  Admin queues (verify requests / withdraw requests)
 * ----------------------------------------------------------------- */

async function pushVerifyRequest(entry) {
  return pushValue(config.dbPaths.verifyRequests, {
    ...entry,
    status: 'pending',
    submittedAt: Date.now(),
  });
}

async function pushWithdrawRequest(entry) {
  return pushValue(config.dbPaths.withdrawRequests, {
    ...entry,
    status: 'pending',
    submittedAt: Date.now(),
  });
}

async function logError(scope, message) {
  try {
    await pushValue(config.dbPaths.errorLog, {
      scope,
      message: String(message).slice(0, 1000),
      at: Date.now(),
    });
  } catch (_) {
    // Logging must never throw and crash the caller.
  }
}

module.exports = {
  // generic
  getValue,
  setValue,
  updateValue,
  pushValue,
  runTransaction,
  // users
  getUser,
  ensureUser,
  adjustBalance,
  // exploit-safe operations
  claimForceJoinBonus,
  payReferralCommissionOnce,
  reserveRedemption,
  refundRedemption,
  // admin queues
  pushVerifyRequest,
  pushWithdrawRequest,
  logError,
};
