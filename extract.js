import fs from 'fs';
import path from 'path';
import { PDFParse } from 'pdf-parse';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
import pool from './src/db.js';
import { generateQuizzesFromPage, isQuestionSelfContained } from './src/gemini.js';

const PDF_PATH = process.argv[2];
const SUBJECT = process.argv[3] || 'default';
const QUIZZES_PER_PAGE = parseInt(process.argv[4] || '2', 10);
const PAGE_RANGE = process.argv[5] || process.env.GENERATE_PAGE_RANGE;

const SCALE = parseFloat(process.env.GENERATE_SCALE || '1.5');
const DELAY_MS = parseInt(process.env.GENERATE_DELAY_MS || '500', 10);
const MAX_PAGES = parseInt(process.env.GENERATE_MAX_PAGES || '0', 10);
const MAX_FAILURES = parseInt(process.env.GENERATE_MAX_FAILURES || '15', 10);
const CONCURRENCY = parseInt(process.env.GENERATE_CONCURRENCY || '3', 10);
const STAGGER_MS = parseInt(process.env.GENERATE_STAGGER_MS || '800', 10);

function parsePageRange(range, totalPages) {
  if (!range) return { from: 1, to: totalPages };

  const match = String(range).match(/^(\d+)(?:-(\d+))?$/);
  if (!match) {
    console.error(`❌ Invalid page range "${range}". Use format like "23-70" or "45".`);
    process.exit(1);
  }

  const from = parseInt(match[1], 10);
  const to = match[2] ? parseInt(match[2], 10) : from;

  if (from < 1 || to > totalPages || from > to) {
    console.error(`❌ Page range ${from}-${to} is invalid (document has ${totalPages} pages).`);
    process.exit(1);
  }

  return { from, to };
}

async function ensureTables() {
  await pool.query(`
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
  `);
}

function findPdf() {
  if (PDF_PATH) {
    if (!fs.existsSync(PDF_PATH)) {
      console.error(`❌ PDF not found: ${PDF_PATH}`);
      process.exit(1);
    }
    return path.resolve(PDF_PATH);
  }

  const pdfs = fs
    .readdirSync('.')
    .filter((f) => f.toLowerCase().endsWith('.pdf') && !fs.statSync(f).isDirectory());

  if (pdfs.length === 0) {
    console.error('❌ No PDF file found in project root');
    process.exit(1);
  }

  return path.resolve(pdfs[0]);
}

async function main() {
  const pdfPath = findPdf();
  await ensureTables();

  console.log(`📄 PDF:  ${pdfPath.split(/[\\/]/).pop()}`);
  console.log(`📚 Subject: ${SUBJECT}`);
  console.log(`❓ Questions per page: ${QUIZZES_PER_PAGE}`);
  console.log(`⚡ Concurrency: ${CONCURRENCY} (${process.env.GEMINI_BATCH_MODEL || 'gemini-3.5-flash-lite'})`);
  console.log('⏳ Reading document...');

  const parser = new PDFParse({ data: fs.readFileSync(pdfPath) });
  const totalPages = (await parser.getInfo()).total;

  let { from, to } = parsePageRange(PAGE_RANGE || (MAX_PAGES > 0 ? `1-${MAX_PAGES}` : null), totalPages);
  const pagesToProcess = to - from + 1;

  console.log(`✅ Document has ${totalPages} pages. Processing ${pagesToProcess} (pages ${from}-${to})...\n`);

  const processOnePage = async (pageNumber) => {
    const shot = await parser.getScreenshot({
      imageDataUrl: true,
      scale: SCALE,
      first: pageNumber,
      last: pageNumber,
    });

    const pageImage = shot.pages[0];
    if (!pageImage?.dataUrl) {
      throw new Error('Page produced no image');
    }

    const { hasContent, pageText, quizzes } = await generateQuizzesFromPage({
      imageDataUrl: pageImage.dataUrl,
      pageNumber,
      subject: SUBJECT,
      quizzesPerPage: QUIZZES_PER_PAGE,
    });

    if (!hasContent) {
      return { inserted: 0, quizCount: 0, transcripts: 0, skipped: true, rejected: 0 };
    }

    let transcripts = 0;
    let inserted = 0;
    let rejected = 0;

    if (pageText) {
      await pool.query(
        `INSERT INTO transcripts (subject, page_number, text) VALUES ($1, $2, $3)
         ON CONFLICT (subject, page_number) DO UPDATE SET text = EXCLUDED.text`,
        [SUBJECT, pageNumber, pageText]
      );
      transcripts = 1;
    }

    for (const q of quizzes) {
      if (!q?.question || !q?.options || !q?.correct) continue;
      if (!isQuestionSelfContained(q.question)) {
        rejected++;
        continue;
      }
      const res = await pool.query(
        `INSERT INTO quizzes (subject, source_page, question, options, correct, explanation)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (subject, question) DO NOTHING`,
        [SUBJECT, pageNumber, q.question, q.options, q.correct, q.explanation || '']
      );
      inserted += res.rowCount || 0;
    }

    return { inserted, quizCount: quizzes.length, transcripts, skipped: false, rejected };
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let quizCount = 0;
  let transcriptCount = 0;
  let failures = 0;
  let skippedPages = 0;
  let rejectedCount = 0;
  let aborted = false;

  for (let start = from; start <= to && !aborted; start += CONCURRENCY) {
    const batch = [];
    for (let pageNumber = start; pageNumber < start + CONCURRENCY && pageNumber <= to; pageNumber++) {
      batch.push(pageNumber);
    }

    const results = await Promise.all(
      batch.map(async (pageNumber, i) => {
        await sleep(i * STAGGER_MS);
        try {
          const outcome = await processOnePage(pageNumber);
          return { pageNumber, outcome };
        } catch (err) {
          return { pageNumber, error: err };
        }
      })
    );

    for (const { pageNumber, outcome, error } of results) {
      if (error) {
        failures++;
        console.error(`   ✗ Page ${pageNumber} failed: ${error?.message || error}`);
        if (failures >= MAX_FAILURES) {
          console.error(`❌ Aborting: more than ${MAX_FAILURES} consecutive page failures.`);
          aborted = true;
        }
        continue;
      }

      if (outcome.skipped) {
        skippedPages++;
        console.log(`   Page ${pageNumber}/${to} — ⏭️ skipped (no study content)`);
        continue;
      }

      quizCount += outcome.inserted;
      transcriptCount += outcome.transcripts;
      rejectedCount += outcome.rejected;
      failures = 0;
      console.log(
        `   Page ${pageNumber}/${to} — ${outcome.inserted}/${outcome.quizCount} new questions (total: ${quizCount})` +
          (outcome.rejected > 0 ? ` (${outcome.rejected} rejected: not self-contained)` : '')
      );
    }

    await sleep(DELAY_MS);
  }

  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('active_subject', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [SUBJECT]
  );

  console.log('\n✅ Done!');
  console.log(`   Transcripts stored: ${transcriptCount}`);
  console.log(`   New questions stored: ${quizCount}`);
  console.log(`   Questions rejected (not self-contained): ${rejectedCount}`);
  console.log(`   Pages skipped (no study content): ${skippedPages}`);
  console.log(`   Active subject set to: ${SUBJECT}`);
  console.log('🚀 Start the bot with: npm run dev');

  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('❌ Generation failed:', err);
  await pool.end();
  process.exit(1);
});