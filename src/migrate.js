import pool from './db.js';

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leaderboard (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      score INTEGER DEFAULT 0,
      total_answered INTEGER DEFAULT 0,
      correct_answers INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS quiz_history (
      id SERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      correct_option TEXT NOT NULL,
      chunk_index INTEGER,
      asked_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id SERIAL PRIMARY KEY,
      cron_expression TEXT NOT NULL,
      label TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS quizzes (
      id SERIAL PRIMARY KEY,
      subject TEXT NOT NULL DEFAULT 'default',
      source_page INTEGER NOT NULL DEFAULT 0,
      question TEXT NOT NULL,
      options JSONB NOT NULL,
      correct TEXT NOT NULL,
      explanation TEXT NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uniq_quiz_subject_question
      ON quizzes (subject, question);

    CREATE INDEX IF NOT EXISTS idx_quizzes_subject_used
      ON quizzes (subject, used);

    CREATE TABLE IF NOT EXISTS transcripts (
      id SERIAL PRIMARY KEY,
      subject TEXT NOT NULL DEFAULT 'default',
      page_number INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (subject, page_number)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Upgrades for already-created tables
    ALTER TABLE schedules ADD COLUMN IF NOT EXISTS chat_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_schedules_chat_label
      ON schedules (chat_id, label);
    ALTER TABLE quiz_history ADD COLUMN IF NOT EXISTS subject TEXT DEFAULT 'default';
  `);

  console.log('✅ Tables created successfully');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});