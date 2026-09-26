import './src/bot.js';

// whatsapp-web.js sometimes throws from internal (non-awaited) code paths
// (e.g. LocalAuth logout unlinking session files while Chrome still holds them).
// Log those instead of letting Node crash the whole bot.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught exception:', err?.message || err);
});