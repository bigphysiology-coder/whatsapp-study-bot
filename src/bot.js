import makeWASocket, { Browsers, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
import { handleCommand } from './commands.js';
import { restoreSchedules } from './scheduler.js';
import { cleanupStaleSessions } from '../scripts/cleanup.js';

const SESSION_DIR = path.resolve('.baileys');
const MAX_ATTEMPTS = parseInt(process.env.BOOT_MAX_ATTEMPTS || '8', 10);
const RETRY_DELAY_MS = parseInt(process.env.BOOT_RETRY_DELAY_MS || '5000', 10);

let currentSocket = null; // latest live socket — api routes through this
let reconnectAttempts = 0;
let logoutCycles = 0;
let startPromise = null;
let shuttingDown = false;
let seenMessageIds = new Set();

// Minimal adapter so commands.js / quiz.js / scheduler.js keep working unchanged.
const api = {
  sendMessage: async (jid, content) => {
    if (!currentSocket) throw new Error('Not connected yet');
    await currentSocket.sendMessage(jid, typeof content === 'string' ? { text: content } : content);
  },
};

function clearSavedSession() {
  cleanupStaleSessions();
  try {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  } catch {
    // The next boot's cleanup will retry if it's still locked.
  }
}

function getContentText(m) {
  const content = m.message;
  if (!content) return null;

  if (typeof content.conversation === 'string' && content.conversation) {
    return content.conversation.trim();
  }
  if (content.extendedTextMessage?.text) {
    return content.extendedTextMessage.text.trim();
  }
  for (const key of ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage']) {
    const caption = content[key]?.caption;
    if (typeof caption === 'string' && caption) return caption.trim();
  }
  return null;
}

async function tryPairingCode(sock, phone) {
  for (let i = 0; i < 10; i++) {
    try {
      const code = await sock.requestPairingCode(phone);
      console.log(`\n🔑 PAIRING CODE: ${code}\n   (WhatsApp → Settings → Linked devices → Link with phone number instead)\n`);
      return;
    } catch (err) {
      await sleep(2000);
    }
  }
}

async function boot() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  // Only send an explicit protocol version when pinned via env; the default is more stable.
  let version = process.env.BAILEYS_VERSION || undefined;

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'error' }),
    browser: Browsers.appropriate('Study Bot'),
    ...(version ? { version } : {}),
    syncFullHistory: false,
  });
  currentSocket = sock;

  sock.ev.on('creds.update', saveCreds);

  // Pairing code is opt-in (WHATSAPP_PAIRING=1 + WHATSAPP_NUMBER). Requesting it
  // at boot races the QR handshake and can wedge the connection, so QR is the default.
  const usePairing = process.env.WHATSAPP_PAIRING === '1' && Boolean(process.env.WHATSAPP_NUMBER);
  if (usePairing && !state.creds?.registered) {
    void tryPairingCode(sock, process.env.WHATSAPP_NUMBER);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (process.env.DEBUG_BAILEYS) {
      console.log('[debug] connection.update:', JSON.stringify({
        connection,
        statusCode: lastDisconnect?.error?.output?.statusCode,
        error: lastDisconnect?.error?.message,
        data: lastDisconnect?.error?.data,
      }));
    }

    if (qr) {
      console.log(
        usePairing
          ? '\n📱 Scan this QR code, or enter the pairing code below (WhatsApp → Linked devices):\n'
          : '\n📱 Scan this QR code with WhatsApp → Linked devices:\n'
      );
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      logoutCycles = 0;
      console.log('✅ Study Bot is ready!');

      try {
        const groups = await sock.groupFetchAllParticipating();
        console.log('\n📋 Your groups:');
        for (const group of Object.values(groups)) {
          console.log(`  ${group.subject ?? '<unnamed>'} → ${group.id}`);
        }
      } catch (err) {
        console.error('Could not list groups:', err?.message || err);
      }

      await restoreSchedules(api);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        logoutCycles++;
        console.log(`⚠️ WhatsApp logged the bot out (rejection ${logoutCycles})`);
        try {
          await sock.end();
        } catch {
          // ignore
        }
        clearSavedSession();

        // A few rejections in a row means WhatsApp is refusing new sessions for
        // this number right now — don't hammer the server.
        if (logoutCycles >= 2) {
          console.error(
            '\n❌ WhatsApp is refusing new sessions (2 rejections in a row).\n' +
            '   This is a rate-limit/temporary block at the WhatsApp protocol level, not a bug.\n' +
            '   Wait at least 24 hours before trying again — retries only extend the block.\n' +
            '   Then: `npm start` from a DIFFERENT network (e.g. phone hotspot) to bypass a flagged IP.'
          );
          return;
        }

        console.log('⏳ Waiting 60s before one more attempt...');
        await sleep(60000);
        void start();
        return;
      }

      reconnectAttempts++;
      if (reconnectAttempts > MAX_ATTEMPTS) {
        console.error('❌ Connection lost repeatedly — giving up. Restart with `npm start`.');
        return;
      }
      const isDnsBlip = lastDisconnect?.error?.output?.payload?.errno === -3008; // ENOTFOUND
      console.log(
        isDnsBlip
          ? `⚠️ DNS lookup for WhatsApp failed (flaky network resolver). Retrying in ${RETRY_DELAY_MS / 1000}s...`
          : `⚠️ Connection lost (reconnect ${reconnectAttempts}/${MAX_ATTEMPTS}) — retrying in ${RETRY_DELAY_MS / 1000}s...`
      );
      await sleep(RETRY_DELAY_MS);
      void start();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const m of messages) {
      try {
        if (m.key?.fromMe) continue;

        const remoteJid = m.key?.remoteJid;
        if (!remoteJid || !remoteJid.endsWith('@g.us')) continue;

        const body = getContentText(m);
        if (!body) continue;

        const msgId = m.key.id;
        if (seenMessageIds.has(msgId)) continue;
        seenMessageIds.add(msgId);
        if (seenMessageIds.size > 500) {
          seenMessageIds = new Set([...seenMessageIds].slice(-300));
        }

        const senderJid = m.key.participant || remoteJid;
        const phone = senderJid.split('@')[0].replace(/[^0-9]/g, '');
        const contact = {
          number: phone,
          pushname: m.pushName || '',
          name: m.pushName || phone,
        };

        const message = {
          from: remoteJid,
          body,
          react: async (emoji) => {
            await currentSocket.sendMessage(remoteJid, { react: { text: emoji, key: m.key } });
          },
        };

        await handleCommand(api, message, contact);
      } catch (err) {
        console.error('Message handler error:', err?.message || err);
      }
    }
  });

  return sock;
}

async function start() {
  if (startPromise || shuttingDown) return startPromise;

  startPromise = (async () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        cleanupStaleSessions();
        await boot();
        return;
      } catch (err) {
        console.error(`⚠️ Startup attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err?.message || err);
        if (attempt < MAX_ATTEMPTS) {
          console.log(`🔄 Retrying in ${RETRY_DELAY_MS / 1000}s...`);
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
    console.error('❌ Could not start the bot after multiple attempts.');
  })().finally(() => {
    startPromise = null;
  });

  return startPromise;
}

process.on('SIGINT', async () => {
  shuttingDown = true;
  try {
    await currentSocket?.end();
  } catch {
    // ignore
  }
  process.exit(0);
});

void start();