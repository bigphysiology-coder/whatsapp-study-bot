import cron from 'node-cron';
import pool from './db.js';
import { startQuiz } from './quiz.js';

const activeCronJobs = new Map(); // `${chatId}:${label}` -> cron task

// Scheduled quizzes run a bounded number of rounds so a cron never starts an
// endless session; users can always /stop to end early anyway.
const SCHEDULED_ROUNDS = parseInt(process.env.SCHEDULED_QUIZ_ROUNDS || '5', 10);

function timeToCron(dayName, time) {
  // time format: "21:00" or "9pm"
  let hour, minute;

  const timeMatch12 = time.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/i);
  const timeMatch24 = time.match(/^(\d{1,2}):(\d{2})$/);

  if (timeMatch12) {
    hour = parseInt(timeMatch12[1]);
    minute = parseInt(timeMatch12[2] || '0');
    const period = timeMatch12[3].toLowerCase();
    if (period === 'pm' && hour !== 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;
  } else if (timeMatch24) {
    hour = parseInt(timeMatch24[1]);
    minute = parseInt(timeMatch24[2]);
  } else {
    return null;
  }

  const days = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };

  const dayNum = days[dayName.toLowerCase()];
  if (dayNum === undefined) return null;

  return `${minute} ${hour} * * ${dayNum}`;
}

async function persistSchedule(chatId, dayName, time, label) {
  const cronExpr = timeToCron(dayName, time);
  await pool.query(
    `INSERT INTO schedules (cron_expression, label, chat_id, active)
     VALUES ($1, $2, $3, TRUE)
     ON CONFLICT (chat_id, label) DO UPDATE SET
       cron_expression = EXCLUDED.cron_expression,
       active = TRUE`,
    [cronExpr, label, chatId]
  );
}

export async function scheduleQuiz(client, chatId, dayName, time, label = null) {
  const cronExpr = timeToCron(dayName, time);

  if (!cronExpr) {
    return { success: false, message: '❌ Invalid day or time format.\nExample: `/schedule friday 9pm` or `/schedule monday 20:00`' };
  }

  if (!cron.validate(cronExpr)) {
    return { success: false, message: '❌ Could not parse schedule. Try again.' };
  }

  const scheduleLabel = label || `${dayName}-${time}`;
  const key = `${chatId}:${scheduleLabel}`;

  // Cancel existing job with same label
  if (activeCronJobs.has(key)) {
    activeCronJobs.get(key).stop();
  }

  const task = cron.schedule(cronExpr, async () => {
    await startQuiz(client, chatId, undefined, { maxRounds: SCHEDULED_ROUNDS });
  });

  activeCronJobs.set(key, task);

  // Persist to DB so the schedule survives a bot restart
  try {
    await persistSchedule(chatId, dayName, time, scheduleLabel);
  } catch (e) {
    console.error('Schedule persist error:', e);
  }

  return {
    success: true,
    message: `✅ Quiz scheduled for every *${dayName}* at *${time}*\nLabel: \`${scheduleLabel}\``,
  };
}

export async function cancelSchedule(client, chatId, label) {
  if (!label) {
    // Cancel all for this group
    let count = 0;
    for (const [key, task] of activeCronJobs.entries()) {
      if (key.startsWith(`${chatId}:`)) {
        task.stop();
        activeCronJobs.delete(key);
        count++;
      }
    }
    await pool.query(`UPDATE schedules SET active = FALSE WHERE chat_id = $1`, [chatId]);
    return count > 0
      ? '✅ All scheduled quizzes cancelled.'
      : 'ℹ️ No active schedules for this group.';
  }

  const key = `${chatId}:${label}`;
  if (activeCronJobs.has(key)) {
    activeCronJobs.get(key).stop();
    activeCronJobs.delete(key);
    await pool.query(`UPDATE schedules SET active = FALSE WHERE chat_id = $1 AND label = $2`, [chatId, label]);
    return `✅ Schedule \`${label}\` cancelled.`;
  }

  return `⚠️ No active schedule with label \`${label}\` found.`;
}

export async function restoreSchedules(client) {
  try {
    const result = await pool.query(
      `SELECT cron_expression, label, chat_id FROM schedules WHERE active = TRUE`
    );
    let restored = 0;

    for (const row of result.rows) {
      if (!row.chat_id || !cron.validate(row.cron_expression)) continue;

      const key = `${row.chat_id}:${row.label}`;
      if (activeCronJobs.has(key)) continue;

      const task = cron.schedule(row.cron_expression, async () => {
        await startQuiz(client, row.chat_id, undefined, { maxRounds: SCHEDULED_ROUNDS });
      });

      activeCronJobs.set(key, task);
      restored++;
      console.log(`🔁 Restored schedule: ${row.label} (${row.cron_expression})`);
    }

    if (restored > 0) console.log(`   → ${restored} schedule(s) restored.`);
  } catch (e) {
    console.error('Restore schedules error:', e);
  }
}