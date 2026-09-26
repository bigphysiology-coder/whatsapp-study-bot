# Study Bot for WhatsApp

A WhatsApp study bot that generates multiple-choice quizzes from scanned textbook PDFs and runs them inside a WhatsApp group, with a scoreboard and weekly scheduling.

## How it works

1. **Generate**: A batch pipeline reads your scanned PDF, and Gemini Vision transcribes every page and writes quiz questions from it. Questions and page transcripts are stored in a Postgres database, grouped by subject.
2. **Quiz**: In WhatsApp, `/quiz` starts a session that hands out pre-generated questions instantly (no AI latency per question), then auto-advances to the next question until you `/stop` it. When the stored pool runs out, it falls back to live generation from the saved transcripts.
3. **Score**: Correct answers earn points on a leaderboard.

## Tech stack

- Node.js (ES modules)
- @whiskeysockets/baileys (native WhatsApp protocol — no browser, no Chrome, no WhatsApp-Web logout churn)
- Google Gemini `gemini-3.5-flash-lite` / `gemini-3.6-flash`
- pdf-parse + canvas (scanned-page rendering)
- PostgreSQL (Neon / pg)

## Setup

```bash
npm install
```

### 1. Environment variables

Copy the keys you have into `.env`:

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Google Gemini API key |
| `DATABASE_URL` | Postgres connection string |
| `QUIZ_DURATION_SECONDS` | Default answer window per question in seconds (default `120`) |
| `SCHEDULED_QUIZ_ROUNDS` | Number of questions a *scheduled* quiz runs before posting the leaderboard (default `5`). Manual `/quiz` runs until `/stop` |
| `WHATSAPP_NUMBER` | (Optional) Your number in international format, no `+`/spaces, e.g. `2348012345678` — only used for pairing-code login (see below) |
| `GEMINI_BATCH_MODEL` | Model used during question generation (default `gemini-3.5-flash-lite`) |
| `GEMINI_MODEL` | Model used for live fallback questions (default `gemini-3.6-flash`) |
| `GENERATE_CONCURRENCY` | Parallel pages during generation (default `3`) |
| `GENERATE_SCALE` | Render resolution of page images (default `1.5`; raise to `2` for dense pages) |
| `GENERATE_DELAY_MS` / `GENERATE_STAGGER_MS` | Pacing between generations to respect rate limits |

### 2. Database

Create the tables (leaderboard, quiz history, schedules, quizzes, transcripts, settings):

```bash
npm run migrate
```

### 3. WhatsApp login

No browser or Chrome is needed — the bot speaks the WhatsApp protocol directly and saves its session
to a JSON folder (`.baileys`). Link once, and every later start reconnects automatically.

## Generating quiz questions

Run the batch pipeline against your textbook:

```bash
npm run generate -- "Information Technology Management.pdf" mit8101 2
```

Arguments:

1. PDF file path (defaults to the first `.pdf` in the project root)
2. Subject name (defaults to `default`)
3. Questions per page (defaults to `2`)

Notes:

- **Scanned PDFs** are supported: each page is rendered to an image and read by Gemini Vision.
- **No-study-content pages** (cover, title, TOC, blank, index pages) are detected and skipped automatically.
- **Self-contained questions only**: questions that reference the source material ("according to the text", "in the diagram", etc.) are rejected automatically, both at generation time and at quiz time.
- Reruns are safe: existing questions/transcripts are kept, duplicates are skipped.

### Page ranges

Generate only part of the book (chapter-by-chapter study):

```bash
npm run generate -- "Information Technology Management.pdf" mit8101 2 23-70
```

The 5th argument accepts a range (`23-70`) or a single page (`45`). You can also use
`GENERATE_PAGE_RANGE="23-70"`.

## Running the bot

```bash
npm start        # recommended for normal use (no auto-restarts)
# or
npm run dev      # development only: auto-restarts on file changes (nodemon)
```

> Use `npm start` for your day-to-day running. `npm run dev`'s auto-restart can interrupt a live
> WhatsApp session whenever files change.

### First login

- **QR code**: printed in the terminal, scan it with WhatsApp -> Linked devices.
- **Pairing code** (only if you can't scan a QR): set `WHATSAPP_NUMBER` **and** add `WHATSAPP_PAIRING=1`
  to `.env`, then the terminal prints a pairing code. In WhatsApp use
  **Linked devices -> Link with phone number instead** and enter it. Linking by QR is the default
  and preferred — requesting a pairing code at boot can interfere with the QR handshake.

Once connected you'll see `Study Bot is ready!` and a list of your groups. The session is saved in
`.baileys`, so future starts skip login.

## Commands (usable in a WhatsApp group)

| Command | Description |
| --- | --- |
| `/quiz` | Start a quiz **session** — keeps asking questions until `/stop` |
| `/quiz 60` | Start a session with a 60-second answer window per question |
| `/stop` (also `/cancel`, `/end`) | End the active quiz session and post the final leaderboard |
| `/leaderboard` / `/lb` | Show the leaderboard |
| `/schedule friday 9pm` | Schedule a weekly quiz (also accepts `20:00` 24h time). Schedules are saved in the database and restored when the bot restarts |
| `/schedule monday 20:00` | Same, 24-hour format |
| `/schedule cancel` | Cancel all schedules |
| `/schedule cancel friday-9pm` | Cancel one specific schedule |
| `/subject` | Show the active subject |
| `/subject list` | List all subjects with question counts |
| `/subject mit8101` | Switch to a different subject |
| `/help` | Show all commands |

During a quiz, participants reply with **A**, **B**, **C**, or **D**.

## Switching subjects (new textbook later)

Generate the new book under its own subject name, then switch pools in WhatsApp without touching the old one:

```bash
npm run generate -- "NewBook.pdf" webtech 2
```

```text
/subject list
/subject webtech
```

## Project structure

```
index.js          Entry point (just imports the bot)
extract.js        Batch question-generation pipeline
src/bot.js        Baileys WhatsApp client (QR / pairing code, reconnect logic)
src/commands.js   WhatsApp command handling
src/quiz.js       Quiz logic (pool lookup, scoring, leaderboard posting)
src/gemini.js     Gemini calls + question-quality filter
src/scheduler.js  Weekly quiz scheduling (node-cron)
src/db.js         Postgres connection pool
src/leaderboard.js Scoreboard queries
src/migrate.js    Table creation
scripts/cleanup.js       Kills stale bot processes
scripts/reset-session.js Clears the saved WhatsApp session
```

## Troubleshooting

- **Terminal says WhatsApp is "refusing new sessions" (repeated 401/log-outs)** — WhatsApp is
  temporarily blocking new companion devices for that number at the protocol level. Wait a few
  hours/days, try a different number, or use the official WhatsApp Business Cloud API.
- **`npm run reset-session`** clears a corrupted/locked session (`.baileys`). Re-link after running it.
- **Rate-limited during generation** — the pipeline retries with backoff automatically. Lower
  `GENERATE_CONCURRENCY` to `2` if you still see retries, or raise `GENERATE_DELAY_MS`.
- **Low-quality questions** — the generator already rejects non-self-contained questions; if the ones
  that pass still feel off, raise `GENERATE_SCALE` to `2` so Gemini reads smaller text better.