import pool from './db.js';

export async function updateScore(phone, name, isCorrect) {
  await pool.query(
    `INSERT INTO leaderboard (phone, name, score, total_answered, correct_answers)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT (phone) DO UPDATE SET
       name = EXCLUDED.name,
       score = leaderboard.score + $3,
       total_answered = leaderboard.total_answered + 1,
       correct_answers = leaderboard.correct_answers + $4,
       updated_at = NOW()`,
    [phone, name, isCorrect ? 10 : 0, isCorrect ? 1 : 0]
  );
}

export async function getLeaderboard(limit = 10) {
  const result = await pool.query(
    `SELECT name, score, correct_answers, total_answered
     FROM leaderboard
     ORDER BY score DESC, correct_answers DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function formatLeaderboard(rows) {
  if (rows.length === 0) return '🏆 *Leaderboard is empty*';

  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((row, i) => {
    const medal = medals[i] || `${i + 1}.`;
    const accuracy =
      row.total_answered > 0
        ? Math.round((row.correct_answers / row.total_answered) * 100)
        : 0;
    return `${medal} *${row.name}* — ${row.score}pts (${accuracy}% accuracy)`;
  });

  return `🏆 *LEADERBOARD*\n\n${lines.join('\n')}`;
}