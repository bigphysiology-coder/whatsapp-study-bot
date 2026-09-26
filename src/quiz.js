import { generateMCQ, isQuestionSelfContained } from './gemini.js';
import { updateScore, getLeaderboard, formatLeaderboard } from './leaderboard.js';
import pool from './db.js';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

const QUIZ_DURATION = parseInt(process.env.QUIZ_DURATION_SECONDS || '120') * 1000;

let activeQuiz = null; // the question currently open for answers
let session = null; // continuous session state: { chatId, cancelled, maxRounds, finishRound, roundTimer }

const LETTERS = ['A', 'B', 'C', 'D'];

// Gemini sometimes returns lowercase option keys or a wrong-case "correct".
// Normalize both so the question and answer text are always well-formed.
function normalizeOptions(raw) {
  const options = {};
  for (const letter of LETTERS) {
    const value = raw ? (raw[letter] ?? raw[letter.toLowerCase()]) : undefined;
    if (value === undefined || value === null || String(value).trim() === '') return null;
    options[letter] = String(value).trim();
  }
  return options;
}

function resolveCorrect(options, rawCorrect) {
  const answer = String(rawCorrect ?? '').trim();
  if (answer.length === 1 && options[answer.toUpperCase()]) return answer.toUpperCase();
  for (const letter of LETTERS) {
    if (options[letter].toLowerCase() === answer.toLowerCase()) return letter;
  }
  return 'A';
}

export function isQuizActive() {
  return activeQuiz !== null || session !== null;
}

export async function getActiveSubject() {
  const res = await pool.query(`SELECT value FROM settings WHERE key = 'active_subject'`);
  return res.rows[0]?.value || 'default';
}

export async function setActiveSubject(subject) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('active_subject', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [subject]
  );
}

export async function listSubjects() {
  const res = await pool.query(
    `SELECT subject, COUNT(*) AS questions FROM quizzes GROUP BY subject ORDER BY subject`
  );
  return res.rows;
}

async function getUnusedQuiz(subject) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await pool.query(
      `SELECT id, question, options, correct, explanation
       FROM quizzes
       WHERE subject = $1 AND used = FALSE
       ORDER BY RANDOM()
       LIMIT 1`,
      [subject]
    );

    if (res.rows.length === 0) return null;

    const row = res.rows[0];
    await pool.query(`UPDATE quizzes SET used = TRUE WHERE id = $1`, [row.id]);

    if (!isQuestionSelfContained(row.question)) {
      console.warn(`Skipped legacy non-self-contained question #${row.id}`);
      continue;
    }

    const options = normalizeOptions(row.options);
    if (!options) {
      console.warn(`Skipped malformed options for question #${row.id}`);
      continue;
    }

    return {
      question: row.question,
      options,
      correct: resolveCorrect(options, row.correct),
      explanation: row.explanation,
    };
  }

  return null;
}

async function generateLiveQuiz(subject) {
  const res = await pool.query(
    `SELECT text FROM transcripts WHERE subject = $1 ORDER BY RANDOM() LIMIT 1`,
    [subject]
  );
  if (res.rows.length === 0) return null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const mcq = await generateMCQ(res.rows[0].text.slice(0, 8000));
    if (!isQuestionSelfContained(mcq.question)) continue;
    const options = normalizeOptions(mcq.options);
    if (!options) continue;
    return {
      question: mcq.question,
      options,
      correct: resolveCorrect(options, mcq.correct),
      explanation: mcq.explanation || '',
    };
  }

  return null;
}

export async function startQuiz(client, chatId, durationMs = QUIZ_DURATION, opts = {}) {
  if (session) {
    await client.sendMessage(chatId, '⚠️ A quiz is already in progress! Send /stop to end it first.');
    return;
  }

  const maxRounds = Number.isFinite(opts.maxRounds) ? opts.maxRounds : Infinity;
  const sess = { chatId, cancelled: false, maxRounds, finishRound: null, roundTimer: null };
  session = sess;

  try {
    await runSession(client, sess, durationMs);
  } catch (err) {
    console.error('Quiz session error:', err);
    try {
      await client.sendMessage(chatId, '❌ Quiz session crashed. Use /quiz to start again.');
    } catch {
      // ignore
    }
  } finally {
    if (sess.roundTimer) clearTimeout(sess.roundTimer);
    session = null;
    activeQuiz = null;
  }
}

async function runSession(client, sess, durationMs) {
  const timeLabel = formatDuration(durationMs);

  await client.sendMessage(
    sess.chatId,
    `📚 *QUIZ SESSION STARTED!*\n\n` +
      `⏱️ Each question has *${timeLabel}* to answer.\n` +
      `Reply with *A*, *B*, *C*, or *D*.\n` +
      `🛑 Send */stop* to end the session.`
  );

  let round = 0;

  while (!sess.cancelled && round < sess.maxRounds) {
    const subject = await getActiveSubject();

    let mcq = await getUnusedQuiz(subject);
    if (!mcq) {
      try {
        mcq = await generateLiveQuiz(subject);
      } catch (err) {
        console.error('Gemini error (fallback):', err);
      }
    }

    if (!mcq) {
      await client.sendMessage(
        sess.chatId,
        `⚠️ No more questions for subject *${subject}* — ending the session.`
      );
      break;
    }

    if (sess.cancelled) break;

    round++;
    const questionText =
      `📚 *QUESTION ${round}* (${subject})\n\n` +
      `❓ ${mcq.question}\n\n` +
      `*A.* ${mcq.options.A}\n` +
      `*B.* ${mcq.options.B}\n` +
      `*C.* ${mcq.options.C}\n` +
      `*D.* ${mcq.options.D}\n\n` +
      `⏱️ You have *${timeLabel}* to answer!\n` +
      `Reply with *A*, *B*, *C*, or *D*`;

    await client.sendMessage(sess.chatId, questionText);

    activeQuiz = {
      chatId: sess.chatId,
      mcq,
      answers: new Map(),
      startTime: Date.now(),
    };

    try {
      await pool.query(
        `INSERT INTO quiz_history (question, correct_option, subject) VALUES ($1, $2, $3)`,
        [mcq.question, mcq.correct, subject]
      );
    } catch (e) {
      console.error('History log error:', e);
    }

    await waitForRound(sess, durationMs);

    const finished = activeQuiz; // keep a reference; loop clears it
    activeQuiz = null;
    await revealRound(client, finished, sess.cancelled);
  }

  await client.sendMessage(
    sess.chatId,
    sess.cancelled ? '🛑 *Quiz session stopped.*' : '🏁 *Quiz session finished!*'
  );

  try {
    const rows = await getLeaderboard();
    const board = await formatLeaderboard(rows);
    await client.sendMessage(sess.chatId, board);
  } catch (e) {
    console.error('Leaderboard error:', e);
  }
}

function waitForRound(sess, durationMs) {
  return new Promise((resolve) => {
    sess.finishRound = () => {
      if (sess.roundTimer) {
        clearTimeout(sess.roundTimer);
        sess.roundTimer = null;
      }
      sess.finishRound = null;
      resolve();
    };
    sess.roundTimer = setTimeout(() => {
      sess.roundTimer = null;
      sess.finishRound = null;
      resolve();
    }, durationMs);
  });
}

export async function cancelQuiz(client, chatId) {
  if (!session || session.chatId !== chatId) {
    await client.sendMessage(chatId, 'ℹ️ No active quiz session in this group.');
    return;
  }
  session.cancelled = true;
  session.finishRound?.(); // wake the loop immediately
}

export function recordAnswer(phone, name, answer) {
  if (!activeQuiz) return false;
  if (activeQuiz.answers.has(phone)) return false;

  const validAnswers = ['A', 'B', 'C', 'D'];
  const upper = answer.toUpperCase().trim();
  if (!validAnswers.includes(upper)) return false;

  activeQuiz.answers.set(phone, { name, answer: upper });
  return true;
}

async function revealRound(client, quiz, wasCancelled) {
  if (!quiz) return;

  const { chatId, mcq, answers } = quiz;
  const correct = mcq.correct.toUpperCase();
  const correctText = `${correct}. ${mcq.options[correct]}`;

  let resultMessage =
    (wasCancelled ? `🛑 *Round ended.*\n\n` : `⏰ *Time's up!*\n\n`) +
    `✅ *Correct Answer: ${correctText}*\n\n` +
    `📖 *Explanation:*\n${mcq.explanation}\n\n`;

  if (answers.size === 0) {
    resultMessage += `😶 Nobody answered this round.`;
    await client.sendMessage(chatId, resultMessage);
    return;
  }

  const winners = [];
  const losers = [];

  for (const [phone, { name, answer }] of answers.entries()) {
    const isCorrect = answer === correct;
    await updateScore(phone, name, isCorrect);
    if (isCorrect) winners.push(name);
    else losers.push(name);
  }

  if (winners.length > 0) {
    resultMessage += `🎉 *Got it right:* ${winners.join(', ')}\n`;
  }
  if (losers.length > 0) {
    resultMessage += `❌ *Got it wrong:* ${losers.join(', ')}\n`;
  }

  await client.sendMessage(chatId, resultMessage);
}

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return minutes > 0 ? `${minutes} min${seconds > 0 ? ` ${seconds}s` : ''}` : `${seconds}s`;
}