import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { cleanupStaleSessions } from './cleanup.js';

const targets = [path.resolve('.baileys'), path.resolve('.wwebjs_auth')];
let cleared = 0;

for (const dir of targets) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    cleanupStaleSessions();
    if (!fs.existsSync(dir)) break;

    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) break;
    } catch {
      console.log(`Session still locked (attempt ${attempt}/5), retrying...`);
      await sleep(1500);
    }
  }

  if (fs.existsSync(dir)) {
    console.error(`Could not clear ${path.basename(dir)} — a bot instance is still running. Stop it (Ctrl+C) and try again.`);
    process.exit(1);
  } else if (dir === path.resolve('.baileys') || dir === path.resolve('.wwebjs_auth')) {
    cleared++;
  }
}

if (cleared > 0) console.log('🗑️  Saved WhatsApp session cleared.');
else console.log('ℹ️  No saved WhatsApp session found.');
console.log('Now run "npm start" and link your WhatsApp again (QR or pairing code).');