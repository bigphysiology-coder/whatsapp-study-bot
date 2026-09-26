import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Runtime quiz fallback model (quality-first)
const model = genAI.getGenerativeModel({
  model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
});

// Batch generation model (throughput-first, higher rate limits)
const batchModel = genAI.getGenerativeModel({
  model: process.env.GEMINI_BATCH_MODEL || 'gemini-3.5-flash-lite',
});

const RETRIES = parseInt(process.env.GEMINI_RETRIES || '5', 10);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateWithRetry(modelInst, parts, retries = RETRIES) {
  let attempt = 0;

  while (true) {
    try {
      const result = await modelInst.generateContent({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
        },
      });

      const text = result.response.text().trim();
      if (!text) throw new Error('Empty response from Gemini');
      return text;
    } catch (err) {
      const isRateLimit = /429|503|SERVICE_UNAVAILABLE|RESOURCE_EXHAUSTED|quota|FETCH_FAILED/i.test(String(err?.message || err));

      if (isRateLimit && attempt < retries) {
        attempt++;
        const wait = Math.min(30000, 1500 * Math.pow(2, attempt));
        console.log(`⏳ Rate limited (${modelInst.model}), retrying in ${(wait / 1000).toFixed(1)}s...`);
        await sleep(wait);
        continue;
      }

      throw err;
    }
  }
}

export function stripMarkdownFences(text) {
  return text.replace(/```json|```/g, '').trim();
}

// Questions that reference the source material instead of the topic are useless
// as quiz questions. Any inbound MCQs hitting these patterns are rejected.
const SOURCE_REFERENCE_PATTERNS = [
  /\baccording to\b/i,
  /\b(?:the|this|our|their|that)\s+(?:session|chapter|section|passage|book)\b/i,
  /\b(?:in|on|from|within|next to)\s+(?:the|this|above)\s*(?:diagram|graphic|figure|illustration|visual|scheme|table|chart|list|panel|box)\b/i,
  /\b(?:in|on|from)\s+(?:the|this)\s+(?:text|passage|reading|session|chapter|section|book)\b/i,
  /\bmentioned\s+(?:in|above|below|earlier|previously)\b/i,
  /\bas\s+(?:seen|shown|displayed|presented|depicted|outlined)\s+(?:above|below|earlier|previously)\b/i,
  /\bwhat\b[^?]{0,60}\b(?:is|are)\s+(?:discussed|explored|described|covered|examined|introduced|presented)\b/i,
];

export function isQuestionSelfContained(question) {
  return !SOURCE_REFERENCE_PATTERNS.some((re) => re.test(question));
}

export async function generateMCQ(chunk) {
  const prompt = `
You are a university exam question generator. Based ONLY on the text provided below, generate ONE multiple choice question.

Rules:
- The question must be based strictly on the provided text
- The question must be FULLY SELF-CONTAINED: a student reading only the question and the 4 options must be able to answer correctly without ever seeing the source material
- NEVER reference the source: no "according to the text", "in the session", "in the chapter/section", "above", "in the diagram/table/list", "the text mentions", etc.
- NEVER write abstract or vague questions like "what is discussed/explored/described". Every question must test a CONCRETE fact (a definition, a named concept or framework, a term, a person, a date, a number, an example, a cause-effect, a best practice)
- Provide exactly 4 options labeled A, B, C, D with exactly one correct option; vary the correct position across A/B/C/D so it is NOT always A
- The explanation should state why the correct option is right and briefly why the others are wrong
- Respond ONLY with valid JSON, no markdown, no extra text

Before finalizing: verify a student who never saw the source text can answer from the question and options alone. If the question or options reference "the text", "the section", "above", "the session", etc., rewrite them to be self-contained.

Good: "What is the most common primary cause of digital transformation failure in organizations?" with concrete causes as options.
Bad:  "According to the scenario, what was the primary cause of the failure?"

Response format:
{
  "question": "...",
  "options": {
    "A": "...",
    "B": "...",
    "C": "...",
    "D": "..."
  },
  "correct": "A",
  "explanation": "..."
}

Text:
${chunk}
  `.trim();

  const text = await generateWithRetry(model, [{ text: prompt }]);
  const parsed = JSON.parse(stripMarkdownFences(text));
  return parsed;
}

export async function generateQuizzesFromPage({ imageDataUrl, pageNumber, subject, quizzesPerPage }) {
  const rawMime = imageDataUrl.replace(/^data:/, '').replace(/;base64.*$/, '');
  const base64 = imageDataUrl.split(',')[1];

  const prompt = `
You are a university exam question generator for the subject "${subject}".

You will be shown ONE scanned page of a textbook.

Step 0 — Decide whether this page contains any actual study content.
Set "hasContent" to false when the page is any of:
- Cover / title page, copyright or ISBN page
- Blank or near-blank page
- Table of contents, preface, dedication, acknowledgement
- Index, glossary, bibliography, references listing
- A page with only headers/footers, page numbers or watermarks and no body content
If "hasContent" is false, respond with "text": "" and "quizzes": [] and do nothing else.

Step 1 — Transcribe the page faithfully.
- Copy ALL readable content verbatim. Preserve headings, subheadings, bullet points, numbered lists and tables as plain text.
- Do NOT summarize and do NOT skip sections.
- Ignore page numbers, running headers/footers and watermarks like "3 of 251".

Step 2 — Create EXACTLY ${quizzesPerPage} multiple-choice questions based on the facts on this page.

Each question MUST be:
- Fully self-contained and answerable WITHOUT the source. A student reading ONLY the question and the four options must be able to answer correctly — bake the necessary facts into the options.
- Based on a concrete fact from the page: a definition, a named concept or framework, a person, a date, a number or statistic, a specific term, an example, a cause-and-effect, a best practice, or a "which is true/false/example of X" fact.

Each question MUST also:
- Have exactly 4 options labeled A, B, C, D with exactly ONE correct option.
- Include an explanation that states why the correct option is right and briefly why the others are wrong.
- Vary the correct answer position randomly across A, B, C, D — it must NOT always be option A.
- Cover a DIFFERENT fact from the other questions on this page (pick distinct facts, do not repeat).

Good vs bad example:
BAD:  "According to the introductory scenario, what was the primary cause of the digital transformation failure?"
GOOD: "What is the most common primary cause of digital transformation failure in organizations?"
Then make the four options list concrete causes so the correct answer is fully stated there.
If the page shows a framework diagram, never say "in the diagram/above"; instead test the concept itself, e.g. "Which element is part of the <framework>?" with the elements as options.

STRICTLY FORBIDDEN:
- NEVER reference the textbook or its structure: do not say "according to the text", "in the session", "in the chapter", "in the section", "above", "in the diagram", "in the table", "in the list", "the scenario", "here" etc.
- NEVER write a question that is only answerable by looking at the source page (e.g., asking what the page mentions or lists).
- NEVER write vague "what is discussed/explored/described" questions. Every question must test a concrete fact a student can restate without the page.

Before finalizing your response, SELF-CHECK every generated question:
1. Would a student who never read the source page still be able to answer it correctly from the question and options alone? If not, REWRITE it so the facts are inside the question and options.
2. Does the question (or its options) contain any phrase like "according to", "the session", "the chapter", "the section", "the text", "above", "in the diagram", "in the table", "the list", or "the scenario"? If yes, REWRITE it to refer only to the topic itself.
3. Is the correct answer sometimes NOT option A? Vary the position.

Respond ONLY with valid JSON, no markdown, no extra text, in this exact format:
{
  "page": ${pageNumber},
  "hasContent": true,
  "text": "<full transcription>",
  "quizzes": [
    {
      "question": "...",
      "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
      "correct": "A",
      "explanation": "..."
    }
  ]
}
  `.trim();

  const text = await generateWithRetry(batchModel, [
    { text: prompt },
    { inlineData: { mimeType: rawMime, data: base64 } },
  ]);

  const parsed = JSON.parse(stripMarkdownFences(text));

  if (!Array.isArray(parsed.quizzes)) {
    throw new Error('Malformed response: no "quizzes" array');
  }

  const hasContent = parsed.hasContent !== false;

  return {
    hasContent,
    pageText: hasContent && typeof parsed.text === 'string' ? parsed.text.trim() : '',
    quizzes: hasContent ? parsed.quizzes : [],
  };
}