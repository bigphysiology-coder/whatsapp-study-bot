import { startQuiz, cancelQuiz, isQuizActive, recordAnswer, getActiveSubject, setActiveSubject, listSubjects } from './quiz.js';
import { getLeaderboard, formatLeaderboard } from './leaderboard.js';
import { scheduleQuiz, cancelSchedule } from './scheduler.js';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

const QUIZ_DURATION = parseInt(process.env.QUIZ_DURATION_SECONDS || '120') * 1000;

export async function handleCommand(client, message, contact) {
  const chatId = message.from;
  const body = message.body.trim();
  const phone = contact.number;
  const name = contact.pushname || contact.name || phone;

  // --- Answer to active quiz (A/B/C/D) ---
  if (/^[abcd]$/i.test(body)) {
    const recorded = recordAnswer(phone, name, body.toUpperCase());
    if (recorded) {
      await message.react('✅');
    }
    return;
  }

  const lower = body.toLowerCase();

  // --- /quiz [optional seconds] ---
  if (lower.startsWith('/quiz')) {
    const parts = body.split(' ');
    let duration = QUIZ_DURATION;

    if (parts[1] && !isNaN(parts[1])) {
      duration = parseInt(parts[1]) * 1000;
    }

    await startQuiz(client, chatId, duration);
    return;
  }

  // --- /stop | /cancel | /end — stop the running quiz session ---
  if (lower === '/stop' || lower === '/cancel' || lower === '/end') {
    await cancelQuiz(client, chatId);
    return;
  }

  // --- /leaderboard ---
  if (lower === '/leaderboard' || lower === '/lb') {
    const rows = await getLeaderboard();
    const board = await formatLeaderboard(rows);
    await client.sendMessage(chatId, board);
    return;
  }

  // --- /schedule <day> <time> ---
  if (lower.startsWith('/schedule')) {
    const parts = body.split(' ');

    if (parts[1]?.toLowerCase() === 'cancel') {
      const label = parts[2] || null;
      const msg = await cancelSchedule(client, chatId, label);
      await client.sendMessage(chatId, msg);
      return;
    }

    if (parts.length < 3) {
      await client.sendMessage(
        chatId,
        '⚠️ Usage:\n`/schedule friday 9pm`\n`/schedule monday 20:00`\n`/schedule cancel` — cancel all\n`/schedule cancel friday-9pm` — cancel specific'
      );
      return;
    }

    const day = parts[1];
    const time = parts[2];
    const result = await scheduleQuiz(client, chatId, day, time);
    await client.sendMessage(chatId, result.message);
    return;
  }

  // --- /subject [name|list] ---
  if (lower === '/subject' || lower.startsWith('/subject ')) {
    const parts = body.split(' ');

    if (parts.length === 1) {
      const current = await getActiveSubject();
      await client.sendMessage(chatId, `📚 Active subject: *${current}*`);
      return;
    }

    if (parts[1].toLowerCase() === 'list') {
      const subjects = await listSubjects();
      if (subjects.length === 0) {
        await client.sendMessage(chatId, '📚 No subjects with stored questions yet.');
        return;
      }
      const activeSubject = await getActiveSubject();
      const list = subjects
        .map((s) => `${s.subject} — ${s.questions} questions${s.subject === activeSubject ? ' (active)' : ''}`)
        .join('\n');
      await client.sendMessage(chatId, `📚 *Available subjects:*\n\n${list}`);
      return;
    }

    const name = parts.slice(1).join(' ');
    const subjects = await listSubjects();
    if (!subjects.some((s) => s.subject === name)) {
      await client.sendMessage(
        chatId,
        `⚠️ No questions stored for subject *${name}* yet.\nUse \`/subject list\` to see available subjects.`
      );
      return;
    }

    await setActiveSubject(name);
    await client.sendMessage(chatId, `📚 Active subject changed to *${name}*.`);
    return;
  }

  // --- /help ---
  if (lower === '/help') {
    const helpText =
      `📚 *Study Bot Commands*\n\n` +
      `*/quiz* — Start a quiz session (keeps asking questions)\n` +
      `*/quiz 60* — Start with a 60 second window per question\n` +
      `*/stop* — End the active quiz session\n` +
      `*/leaderboard* or */lb* — Show leaderboard\n` +
      `*/schedule friday 9pm* — Schedule weekly quiz\n` +
      `*/schedule cancel* — Cancel all schedules\n` +
      `*/schedule cancel friday-9pm* — Cancel specific\n` +
      `*/subject* — Show active subject\n` +
      `*/subject list* — Show all subjects\n` +
      `*/subject mit8101* — Switch active subject\n` +
      `*/help* — Show this message\n\n` +
      `During a quiz, reply with *A*, *B*, *C*, or *D*`;
    await client.sendMessage(chatId, helpText);
    return;
  }
}