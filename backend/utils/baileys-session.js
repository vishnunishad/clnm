/**
 * baileys-session.js
 * ──────────────────
 * Singleton WhatsApp session manager built on @whiskeysockets/baileys.
 *
 * Responsibilities:
 *   • Start / restart the Baileys socket
 *   • Generate real QR codes and broadcast them via SSE to connected browsers
 *   • Persist multi-file auth state to disk → survives server restarts
 *   • Update the `whatsapp_connections` DB row with live status / profile data
 *   • Provide sendMessage() used by whatsappController
 *   • Clean logout / disconnect
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
} = require('@whiskeysockets/baileys');

const qrcode  = require('qrcode');
const path    = require('path');
const fs      = require('fs');
const db      = require('../config/db');

// ── Constants ────────────────────────────────────────────────────────────────
const SESSION_DIR = path.join(__dirname, '..', 'sessions', 'wa-auth');

// ── State ─────────────────────────────────────────────────────────────────────
/** @type {import('@whiskeysockets/baileys').WASocket | null} */
let sock = null;

/** Whether we are in a deliberate logout (prevents auto-reconnect) */
let intentionalDisconnect = false;

/** SSE response objects waiting for QR / status events  */
const sseClients = new Set();

/** Last known QR base64 image (so late-connecting SSE clients get it immediately) */
let lastQrDataUrl = null;

// ── SSE helpers ───────────────────────────────────────────────────────────────

function broadcast(eventName, payload) {
  const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach((res) => {
    try { res.write(data); } catch (_) { /* client disconnected */ }
  });
}

/**
 * Register a new SSE response object.
 * Immediately sends last known QR if one exists.
 */
function registerSseClient(res) {
  sseClients.add(res);
  if (lastQrDataUrl) {
    res.write(`event: qr\ndata: ${JSON.stringify({ qr: lastQrDataUrl })}\n\n`);
  }
}

function unregisterSseClient(res) {
  sseClients.delete(res);
}

// ── Database helpers ──────────────────────────────────────────────────────────

async function updateDbStatus(fields) {
  try {
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    const vals = Object.values(fields);
    await db.query(`UPDATE whatsapp_connections SET ${sets} WHERE id = 1`, vals);
  } catch (err) {
    console.error('[Baileys] DB update error:', err.message);
  }
}

async function ensureSessionDir() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

// ── Core: start session ───────────────────────────────────────────────────────

async function startSession() {
  intentionalDisconnect = false;
  lastQrDataUrl = null;

  await ensureSessionDir();

  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, console),
    },
    printQRInTerminal: false,   // we handle QR ourselves
    browser: ['CLN Lending Suite', 'Chrome', '126.0'],
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 30000,
  });

  // ── Event: credentials updated ─────────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── Event: QR code ─────────────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // New QR available
    if (qr) {
      try {
        const dataUrl = await qrcode.toDataURL(qr, { width: 280, margin: 1 });
        lastQrDataUrl = dataUrl;
        broadcast('qr', { qr: dataUrl });
        await updateDbStatus({ status: 'Connecting', qr_code: qr });
        console.log('[Baileys] QR code generated — waiting for scan…');
      } catch (e) {
        console.error('[Baileys] QR generation error:', e.message);
      }
    }

    // ── Connected ─────────────────────────────────────────────────────────────
    if (connection === 'open') {
      lastQrDataUrl = null;
      console.log('[Baileys] ✅ WhatsApp session connected!');

      // Extract profile info from session credentials
      const me = sock.user;
      const rawPhone = me?.id ? me.id.split(':')[0].split('@')[0] : null;
      const profileName = me?.name || me?.verifiedName || 'WhatsApp User';
      const sessionId   = `cln-wa-${Date.now()}`;

      await updateDbStatus({
        status             : 'Connected',
        qr_code            : null,
        device_name        : profileName,
        device_phone       : rawPhone,
        session_id         : sessionId,
        last_connected_at  : new Date(),
        session_created_at : new Date(),
      });

      broadcast('connected', {
        status     : 'Connected',
        phone      : rawPhone ? `+${rawPhone}` : '—',
        name       : profileName,
        sessionId,
        connectedAt: new Date().toISOString(),
      });
    }

    // ── Disconnected ──────────────────────────────────────────────────────────
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`[Baileys] Connection closed. Code: ${statusCode}. Logged out: ${isLoggedOut}`);

      await updateDbStatus({
        status    : 'Disconnected',
        qr_code   : null,
        device_name: null,
        device_phone: null,
        session_id : null,
        last_connected_at: null,
      });

      broadcast('disconnected', { status: 'Disconnected', reason: statusCode });

      if (isLoggedOut) {
        // Remove saved credentials so next connect shows fresh QR
        clearSessionFiles();
      }

      // Auto-reconnect unless we intentionally disconnected or got logged out
      if (!intentionalDisconnect && !isLoggedOut) {
        console.log('[Baileys] Attempting auto-reconnect in 5s…');
        setTimeout(() => startSession(), 5000);
      }
    }
  });
}

// ── Logout / Disconnect ───────────────────────────────────────────────────────

async function logout() {
  intentionalDisconnect = true;
  lastQrDataUrl = null;

  if (sock) {
    try {
      await sock.logout();
    } catch (_) { /* ignore – socket might already be dead */ }
    sock = null;
  }

  clearSessionFiles();

  await updateDbStatus({
    status      : 'Disconnected',
    qr_code     : null,
    device_name : null,
    device_phone: null,
    session_id  : null,
    last_connected_at: null,
  });

  broadcast('disconnected', { status: 'Disconnected' });
}

function clearSessionFiles() {
  try {
    if (fs.existsSync(SESSION_DIR)) {
      const files = fs.readdirSync(SESSION_DIR);
      files.forEach((f) => fs.unlinkSync(path.join(SESSION_DIR, f)));
      console.log('[Baileys] Session files cleared.');
    }
  } catch (err) {
    console.error('[Baileys] Could not clear session files:', err.message);
  }
}

// ── Restart ───────────────────────────────────────────────────────────────────

async function restart() {
  intentionalDisconnect = true;
  if (sock) {
    try { sock.end(undefined); } catch (_) {}
    sock = null;
  }
  // Brief delay then reconnect
  setTimeout(() => startSession(), 1000);
}

// ── Send Message ──────────────────────────────────────────────────────────────

/**
 * Send a text message via the active Baileys session.
 * Returns { success, messageId } or throws on error.
 *
 * @param {string} phone  — digits only, with country code (e.g. "919876543210")
 * @param {string} text   — message body
 */
async function sendWhatsAppMessage(phone, text) {
  if (!sock) {
    throw new Error('WhatsApp session is not active. Please connect first.');
  }

  // Baileys JID format: "<phone>@s.whatsapp.net"
  const jid = `${phone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

  const sentMsg = await sock.sendMessage(jid, { text });
  return { success: true, messageId: sentMsg?.key?.id };
}

// ── Auto-restore on server startup ───────────────────────────────────────────
// If session files exist, start immediately (no QR needed)

async function initOnStartup() {
  await ensureSessionDir();
  const files = fs.existsSync(SESSION_DIR) ? fs.readdirSync(SESSION_DIR) : [];
  if (files.length > 0) {
    console.log('[Baileys] Found saved session — attempting auto-restore…');
    startSession().catch((err) => {
      console.error('[Baileys] Auto-restore failed:', err.message);
    });
  } else {
    console.log('[Baileys] No saved session found. Connect via Admin panel to pair.');
    // Ensure DB is in Disconnected state
    try {
      await updateDbStatus({ status: 'Disconnected', qr_code: null, device_name: null, device_phone: null, session_id: null });
    } catch (_) {}
  }
}

module.exports = {
  startSession,
  logout,
  restart,
  sendWhatsAppMessage,
  registerSseClient,
  unregisterSseClient,
  initOnStartup,
};
