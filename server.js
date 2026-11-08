// Ecko server: the phone posts speech and button presses; every screen receives updates over Server-Sent Events.
// Built on node:http with no framework.
import http from 'node:http';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import * as tiger from './tiger.js';

// Everything that happens to each sentence goes to the terminal and to logs/server.log (gitignored: it holds speech).
const LOG_FILE = new URL('./logs/server.log', import.meta.url);
await mkdir(new URL('./logs/', import.meta.url), { recursive: true });
function log(...parts) {
  const line = `${new Date().toLocaleTimeString('en-CA', { hour12: false })} ${parts.join(' ')}`;
  console.log(line);
  appendFile(LOG_FILE, line + '\n').catch(() => {});
}

const PORT = process.env.PORT || 3000;
// Board notes: 3.5-flash with minimal thinking (~1-1.5 s). The lite models are faster but invented answers and wrote
// fragment notes, so they are only fallbacks.
const GEMINI_MODELS = (process.env.GEMINI_MODELS || 'gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite').split(',');
// SVG drawings (fallback only): 3.5-flash 6-8 s with accurate shapes; 3.8-flash 10-13 s; pro models were too slow for class.
const SKETCH_MODELS = (process.env.SKETCH_MODELS || 'gemini-3.5-flash,gemini-3.8-flash').split(',');
// Diagrams: an image model draws the whole labelled diagram in chalk. (SVG shapes often had parts floating loose, so
// renderSvg + the board's label placer are only the fallback.) Timed on a neuron, mitochondrion and nervous system:
// 3.1-flash-image ~7 s with accurate, correctly spelled labels; 3.1-flash-lite-image ~2.5 s but labels sometimes point
// at the wrong part, so it is the fallback; larger image models took 14-23 s.
const IMAGE_MODELS = (process.env.IMAGE_MODELS || 'gemini-3.1-flash-image,gemini-3.1-flash-lite-image').split(',');
const PAGES = { '/': 'index.html', '/phone': 'phone.html', '/board': 'board.html', '/insights': 'insights.html' };
const ASSET_TYPES = { png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml', jpg: 'image/jpeg' };
const MAX_BODY = 64 * 1024;
// Diagrams only when the teacher explicitly asks for one. Checked here as well as in the prompt.
const ASKED_FOR_VISUAL = /\b(diagrams?|draw|drawing|drawn|sketch\w*|pictures?|illustrat\w*|flow ?charts?|charts?|figures?)\b/i;

// The current class is held in memory (the lesson plan and speech measurements are saved to disk / Tiger Data).
// The board is one long page: an append-only list of blocks.
//   { id, type: 'heading' | 'note', text, raw? }   raw = Gemini was unavailable, the teacher's words as spoken
//   { id, type: 'flow', steps, cycle }
//   { id, type: 'sketch', subject, parts, svg, img }  svg and img are '' while it is being drawn; img = an image URL
const session = { lesson: '', lines: [], title: '', blocks: [], clearVoice: false }; // clearVoice: re-speak everything he says
const sketchImages = new Map(); // block id → { buf, mime }, served at /api/sketch/<id>
let boardUpTo = 0; // lines[0..boardUpTo) are already on the board
let visualUsedUpTo = 0; // a request word ("diagram"…) in lines before this has already produced its drawing
let nextId = 1;
const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
const boardState = () => ({ title: session.title, blocks: session.blocks });
const pushBoard = (extra = {}) => broadcast('board', { ...boardState(), ...extra });

// ---------- Gemini ----------

const preferred = new Map(); // model list → the model in it that answered most recently

async function gemini(prompt, schema, { thinking = 'minimal', timeout = 6000, models = GEMINI_MODELS } = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  // Try whichever model in this list last answered first: when one is overloaded (seen 2026-11-07: 3.5-flash-lite
  // timing out on every call), we stop paying its full timeout on every request.
  const listKey = models.join(',');
  const order = [...models].sort((a, b) => (b === preferred.get(listKey)) - (a === preferred.get(listKey)));
  let lastErr;
  for (const model of order) {
    const t0 = performance.now();
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        signal: AbortSignal.timeout(timeout),
        body: JSON.stringify({
          contents: [{ parts: Array.isArray(prompt) ? prompt : [{ text: prompt }] }], // text, or text + audio parts
          generationConfig: { thinkingConfig: { thinkingLevel: thinking }, responseMimeType: 'application/json', responseSchema: schema },
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const quota = body.error?.details?.find((d) => d.violations)?.violations?.map((v) => v.quotaId).join(', ');
        throw new Error(`${model} ${res.status} ${quota || body.error?.message?.slice(0, 120) || ''}`);
      }
      const json = await res.json();
      const ms = Math.round(performance.now() - t0);
      log(`gemini ${model} ${ms} ms`);
      preferred.set(listKey, model);
      return { data: JSON.parse(json.candidates[0].content.parts[0].text), ms, model };
    } catch (err) {
      lastErr = err;
      log(`gemini failed after ${Math.round(performance.now() - t0)} ms:`, err.message);
    }
  }
  throw lastErr;
}

const STR = { type: 'STRING' };
const STRS = { type: 'ARRAY', items: STR };
const BOARD_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: STR,
    add: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING', enum: ['heading', 'note', 'flow', 'sketch'] },
          text: STR, steps: STRS, cycle: { type: 'BOOLEAN' }, subject: STR, parts: STRS,
        },
        required: ['type'],
      },
    },
    holdLast: { type: 'BOOLEAN' },
  },
  required: ['title', 'add', 'holdLast'],
};

const describe = (b) => b.type === 'flow' ? `flow: ${b.steps.join(' → ')}${b.cycle ? ' → (back to start)' : ''}`
  : b.type === 'sketch' ? `sketch: ${b.subject} (${b.parts.join(', ')})` : `${b.type}: ${b.text}`;

const boardPrompt = (newLines, recentLines) => `You write the classroom whiteboard for a high-school biology teacher, live, while he talks.
He has ALS: his speech can be slurred, so the speech-to-text below contains mistakes. Use the lesson plan to fix
misheard biology terms. The board is one long page that grows downward: you only ADD to the end of it.

His speech comes in pieces: speech-to-text cuts it at every pause, and with ALS he often pauses, repeats or struggles
mid-sentence ("the axon ... the axon terminal ... it will release ... release neurotransmitters"). Join the pieces into
whole thoughts. Ignore stutters and repeated words. Every note must be a complete, sensible sentence a student could
learn from. Never write a fragment or trailing piece as a note, and never append one to an earlier note. Real examples
that must NOT become notes on their own: "terminal and then", "design, but I", "Here is", "axons", "which will be used".
Join such pieces with the speech around them, hold them (see holdLast), or skip them. A word written like [neuron?] was slurred and inferred from context: treat it as what he
said, and write it plainly in notes (no brackets).

Return {"title", "add": [...], "holdLast"}. Each added item is one of:
- {"type":"note","text"}: one short note students can copy, under 14 words. This is the default for what he says.
- {"type":"heading","text"}: a section heading, 1 to 4 words in Title Case. Add one whenever he starts on a new topic or
  thing (e.g. moving from "the neuron" to "the nervous system"), before that topic's notes. Name what he is talking
  about now, using words he said; never name a stage or term he has not said yet.
- {"type":"flow","steps":[...],"cycle":true|false}: a flowchart of a PROCESS. ONLY when he explicitly asks for a diagram,
  flowchart, chart or drawing of a process. Steps in order, each a short noun of 1 to 3 words ("Glucose", "Glycolysis",
  "Pyruvate"), at most 8; give the complete textbook sequence he asked for. "cycle" true if it loops back to the start.
- {"type":"sketch","subject","parts":[...]}: a labelled drawing of a STRUCTURE (cell, organelle, organ, neuron, molecule).
  ONLY when he explicitly asks for a diagram, drawing, sketch or picture of it. Add it as soon as he asks, even before he
  names any parts. Parts: the ones he named, otherwise the main parts a high-school textbook labels, at most 7.
  If he asked for the diagram in the earlier speech and it is not on the board yet, add it now. Never add a diagram
  that is already on the board again.
- When he talks about the parts of something already drawn ("the axon runs through the myelin sheath to the axon
  terminal"), those are facts: write them as NOTES. Describing a diagram is never a reason to skip a note.

Rules:
- "Explicitly asks" means he uses a word like diagram, draw, drawing, sketch, picture or flowchart. Naming a topic
  ("today is cellular respiration") is NOT a request for a diagram: write a note.
- Every distinct fact he states gets its own note; do not merge or drop facts. Never repeat anything already on the
  board. Skip ONLY pure filler with no content ("um", "okay", "alright everyone", "settle down"); if a sentence says
  anything about the subject, it gets a note, even if it is informal or half-finished.
- Questions he asks the class ("what do you think the axon looks like?"), instructions and classroom talk ("let me
  show you", "open your books") are NOT notes. Never answer a question he asks, and never add a fact he did not state.
- A sketch's "subject" is exactly the thing he is asking to see NOW (e.g. "central and peripheral nervous system"),
  never an earlier diagram's subject.
- Only write what he actually said; the lesson plan is ONLY for correcting misheard words. The one exception is the
  content of a diagram he explicitly asked for.
- At most 4 items per reply. "title": the lesson topic, a few words.
- "holdLast": true if the LAST line of new speech is an unfinished thought (cut off mid-sentence, e.g. ends with "and",
  "then", "the", "is", or trails off). Write nothing from that last line; it will be sent again joined with what he says
  next. Otherwise false.

Lesson plan:
${session.lesson || '(none given)'}

Board so far (most recent last):
${session.blocks.slice(-12).map(describe).join('\n') || '(empty)'}

Earlier speech (context only, already handled):
${recentLines.map((l) => l.text).join('\n') || '(nothing)'}

New speech:
${newLines.map((l) => l.text).join('\n')}`;

// Near-duplicate of a recent note? The fast models sometimes rewrite an earlier note with the next fragment tacked on
// ("Axons carry impulses away from the cell body which will be used."). Compares content words.
const STOP = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'are', 'for', 'its', 'into', 'was', 'has', 'have', 'they', 'which', 'will']);
const words = (s) => new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((x) => !STOP.has(x)));
// A repeat = adds at most one new content word to a recent note. (Measuring overlap alone also threw away notes that
// EXTEND an earlier one, e.g. "...travels through the axon to send information", 2026-11-07.)
function repeatsRecentNote(text) {
  const w = words(text);
  return session.blocks.slice(-8).some((b) => {
    if (b.type !== 'note') return false;
    const v = words(b.text);
    return [...w].filter((x) => !v.has(x)).length <= 1;
  });
}

// Same diagram already among the last few blocks? (The request and its description often arrive in separate calls.)
const recentVisual = (type, key) => session.blocks.slice(-6).some((b) => b.type === type &&
  (type === 'sketch' ? b.subject.toLowerCase() === key : b.steps.join('|').toLowerCase() === key));

function addBlocks(items, askedForVisual) {
  for (const it of items.slice(0, 4)) {
    const text = (it.text ?? '').trim();
    if ((it.type === 'flow' && recentVisual('flow', (it.steps ?? []).join('|').toLowerCase())) ||
        (it.type === 'sketch' && recentVisual('sketch', (it.subject ?? '').trim().toLowerCase()))) {
      log('board: skipped repeat', it.type, it.subject ?? it.steps?.join(' → '));
    } else if (it.type === 'heading' && (session.blocks.at(-1)?.type === 'heading' ||
               text.toLowerCase() === session.blocks.findLast((b) => b.type === 'heading')?.text.toLowerCase())) {
      log('board: skipped heading', text, '(same section or heading right after heading)');
    } else if (it.type === 'note' && text && repeatsRecentNote(text)) {
      log('board: skipped near-duplicate note', JSON.stringify(text));
    } else if ((it.type === 'note' || it.type === 'heading') && text) {
      session.blocks.push({ id: nextId++, type: it.type, text: text.slice(0, 200) });
      log(`board: +${it.type}`, JSON.stringify(text));
    } else if (it.type === 'flow' && askedForVisual && it.steps?.length >= 2) {
      session.blocks.push({ id: nextId++, type: 'flow', steps: it.steps.slice(0, 8).map((s) => s.slice(0, 40)), cycle: !!it.cycle });
      log('board: +flow', it.steps.join(' → '), it.cycle ? '(cycle)' : '');
    } else if (it.type === 'sketch' && askedForVisual && it.subject?.trim()) {
      log('board: +sketch', it.subject, it.parts?.length ? `(${it.parts.join(', ')})` : '');
      // No parts named → the drawing step picks the standard textbook parts itself.
      const parts = [...new Set((it.parts ?? []).map((p) => p.trim().slice(0, 40)).filter(Boolean))].slice(0, 7);
      const block = { id: nextId++, type: 'sketch', subject: it.subject.trim().slice(0, 60), parts, svg: '', img: '' };
      session.blocks.push(block);
      drawSketch(block);
    } else {
      log('board: dropped', JSON.stringify(it), askedForVisual ? '' : '(no diagram request)');
    }
  }
}

// One board call in flight at a time, and at least MIN_GAP_MS apart. Speech that arrives meanwhile is batched into the
// next call, so nothing is lost.
const MIN_GAP_MS = 1500;
// Patience for slow, effortful (ALS) speech: speech-to-text cuts at every pause, so wait until he has been quiet for
// SETTLE_MS before writing, but never let speech wait more than MAX_WAIT_MS during nonstop talking. A last line Gemini
// marks unfinished is held (joined with what comes next) for at most MAX_HOLD_MS.
const SETTLE_MS = 1800, MAX_WAIT_MS = 10000, MAX_HOLD_MS = 12000;
const RAW_AFTER_MS = 25000; // if Gemini keeps failing this long, show the speech as spoken rather than lose it
let boardBusy = false, boardDirty = false, lastBoardCall = 0, boardTimer = null, lastSpeechAt = 0;
const later = (ms) => { clearTimeout(boardTimer); boardTimer = setTimeout(() => { boardTimer = null; refreshBoard(); }, Math.max(ms, 50)); };

async function refreshBoard() {
  if (boardBusy) { boardDirty = true; return; }
  const pending = session.lines.slice(boardUpTo);
  if (!pending.length) return;
  const now = Date.now();
  const gap = lastBoardCall + MIN_GAP_MS - now;
  if (gap > 0) return later(gap);
  const quiet = now - lastSpeechAt, oldest = now - pending[0].t;
  if (quiet < SETTLE_MS && oldest < MAX_WAIT_MS) return later(Math.min(SETTLE_MS - quiet, MAX_WAIT_MS - oldest));
  clearTimeout(boardTimer);
  boardBusy = true;
  lastBoardCall = now;
  let upTo = session.lines.length, held = false;
  const newLines = session.lines.slice(boardUpTo, upTo);
  try {
    broadcast('status', { writing: true });
    const { data, ms } = await gemini(boardPrompt(newLines, session.lines.slice(Math.max(0, boardUpTo - 3), boardUpTo)), BOARD_SCHEMA);
    if (data.holdLast && now - newLines.at(-1).t < MAX_HOLD_MS) {
      upTo -= 1;
      held = true;
      log('board: holding unfinished', JSON.stringify(newLines.at(-1).text));
    }
    if (data.title?.trim()) session.title = data.title.trim().slice(0, 80);
    // The request and its description often come in separate sentences, so look back two lines, but never past a
    // request that has already been drawn: one "diagram" = one drawing; anything after must ask again.
    const asked = ASKED_FOR_VISUAL.test(session.lines.slice(Math.max(0, boardUpTo - 2, visualUsedUpTo), upTo).map((l) => l.text).join(' '));
    const visualsBefore = session.blocks.filter((b) => b.type === 'flow' || b.type === 'sketch').length;
    if (!data.add?.length) log(`board: Gemini added nothing for ${newLines.length} line(s) (${ms} ms)`);
    addBlocks(data.add ?? [], asked);
    if (session.blocks.filter((b) => b.type === 'flow' || b.type === 'sketch').length > visualsBefore) visualUsedUpTo = upTo;
    broadcast('status', { error: '' });
    pushBoard({ ms });
  } catch (err) {
    log('board:', err.message);
    if (now - newLines[0].t < RAW_AFTER_MS) {
      // Keep the speech and try again on the next round: writing raw pieces of halting speech puts fragments like
      // "design, but I" on the board.
      upTo = boardUpTo;
      broadcast('status', { error: 'Gemini is slow right now: retrying…' });
    } else {
      // Still failing after RAW_AFTER_MS: don't lose the words. Put them up as one plain note, as spoken.
      session.blocks.push({ id: nextId++, type: 'note', text: newLines.map((l) => l.text).join(' '), raw: true });
      broadcast('status', { error: 'Gemini unavailable: showing speech as spoken' });
      pushBoard();
    }
  } finally {
    boardUpTo = upTo;
    boardBusy = false;
    broadcast('status', { writing: false });
    const waiting = session.lines.length - boardUpTo;
    if (boardDirty || waiting > (held ? 1 : 0)) { boardDirty = false; refreshBoard(); } // (a retry waits MIN_GAP_MS)
    else if (held) later(MAX_HOLD_MS - (Date.now() - session.lines[boardUpTo].t)); // nothing new: flush when the hold expires
  }
}

// ---------- Diagrams: an image model draws them; SVG shapes + the board's labels are the fallback ----------

// SVG fallback. "layout" comes first: planning where each part goes and what it attaches to before drawing fixed floating, disconnected
// parts (a neuron with loose dendrites, 2026-11-07) for ~1 s more. The board only uses "svg".
const SVG_SCHEMA = { type: 'OBJECT', properties: { layout: STR, svg: STR }, required: ['layout', 'svg'], propertyOrdering: ['layout', 'svg'] };

async function renderSvg(subject, parts, models, timeout) {
  const { data, ms, model } = await gemini(`Draw a high-school biology diagram of: ${subject}.
Return JSON {"layout": "...", "svg": "..."}. First "layout": 3-6 short lines planning where each part goes (approximate
coordinates and sizes) and what it attaches to. Then "svg": one complete <svg viewBox="0 0 500 500"> element drawing
exactly that layout, kept inside 20..480.

${parts.length
    ? `Each of these parts must be its own element, or a <g> holding its shapes, with a data-part attribute set to exactly
the name given: ${parts.map((p) => `data-part="${p}"`).join(', ')}.`
    : `Choose the main parts a high-school textbook labels (at most 7). Each part must be its own element, or a <g>
holding its shapes, with a data-part attribute set to its name in lowercase, e.g. data-part="inner membrane".`}
Every part appears exactly once as a data-part (a <g data-part> may hold several shapes, e.g. several mitochondria).
Shapes and positions must be scientifically accurate (relative sizes, what sits inside what, typical shapes).
Anatomy rules:
- It is ONE connected structure, like a textbook illustration. Parts that are joined in real life must touch or overlap
  (e.g. dendrites grow out of the cell body's edge; the axon starts at the cell body and runs unbroken to the terminals;
  myelin segments sit ON the axon; terminals branch from the axon's end). Nothing floats loose.
- Parts that are inside something are drawn inside it (nucleus inside the cell body, cristae inside the mitochondrion).
- How to make things attach (draw in this order): anything that grows out of a body (dendrites, the axon, nerves,
  branches) is drawn FIRST as a path that STARTS INSIDE that body, a little in from its edge; then the body is drawn ON
  TOP, so the join is hidden and the part looks attached. Never start a branch in empty space.
- Lines and branches (dendrites, axons, nerves, vessels) are strokes with fill="none" (stroke-width 6-10 for main
  ones). Only closed shapes get a fill colour, set on that shape itself.
- Standard textbook orientation and proportions.

Style: cute and cartoony like a children's science book. Outlines stroke="#3a3a3a" stroke-width 4 to 6,
stroke-linecap and stroke-linejoin round. Bright cheerful fills such as #ffadb0 #9bd4ff #a6f0a8 #ffe066 #d6bcff #ffc999.
Absolutely NO text, no labels, no <text>, no <style>, no filters, no gradients, no images, no background rectangle.
Be economical: a clean, simple drawing with as few elements as needed (about 15-30 shapes), smooth paths with few
points, whole numbers, no comments. Under 3,000 characters of SVG.`,
    SVG_SCHEMA, { thinking: 'low', timeout, models });
  return { svg: data.svg, ms, model };
}

// One finished picture from an image model, with fallback down the list like gemini().
async function renderImage(subject, parts, models = IMAGE_MODELS, timeout = 30000) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const prompt = `A labelled high-school biology diagram of ${subject}, drawn by a teacher in coloured chalk on a plain
white board. Hand-drawn and sketchy: rough grainy chalk-pastel strokes with visible texture, slightly wobbly outlines,
colouring-in that shows the chalk grain, bright chalk colours (pink, sky blue, mint green, yellow, lavender, orange).
Cute and simple like a children's science book, NOT realistic, no shading or 3D, no photo.
Scientifically accurate: one connected structure in standard textbook orientation; every part attached where it is in
real life, nothing floating.
${parts.length ? `Label these parts, spelled exactly: ${parts.join(', ')}.` : 'Label the main parts a high-school textbook labels (at most 7).'}
Each label appears exactly ONCE, as short neat handwritten chalk lettering, with a thin chalk leader line ending ON the
part it names. No title, no other text, no border, no frame, plain flat white background filling the whole image.`;
  const listKey = models.join(',');
  const order = [...models].sort((a, b) => (b === preferred.get(listKey)) - (a === preferred.get(listKey)));
  let lastErr;
  for (const model of order) {
    const t0 = performance.now();
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        signal: AbortSignal.timeout(timeout),
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:3' } } }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${model} ${res.status} ${json.error?.message?.slice(0, 120) ?? ''}`);
      const img = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
      if (!img || !/^image\/(png|jpeg|webp)$/.test(img.mimeType)) throw new Error(`${model} returned no image (${json.candidates?.[0]?.finishReason ?? 'no candidate'})`);
      const ms = Math.round(performance.now() - t0);
      preferred.set(listKey, model);
      return { buf: Buffer.from(img.data, 'base64'), mime: img.mimeType, ms, model };
    } catch (err) {
      lastErr = err;
      log(`image failed after ${Math.round(performance.now() - t0)} ms:`, err.message);
    }
  }
  throw lastErr;
}

async function drawSketch(block) {
  broadcast('status', { drawing: block.subject });
  try {
    try {
      const { buf, mime, ms, model } = await renderImage(block.subject, block.parts);
      sketchImages.set(block.id, { buf, mime });
      block.img = `/api/sketch/${block.id}`;
      log(`sketch: ${block.subject} imaged by ${model} in ${(ms / 1000).toFixed(1)} s (${Math.round(buf.length / 1024)} KB)`);
      return pushBoard({ sketchMs: ms });
    } catch (err) {
      log('sketch image failed, drawing it as SVG instead:', err.message); // fallback, so a request never comes back empty
    }
    const { svg, ms, model } = await renderSvg(block.subject, block.parts, SKETCH_MODELS, 30000);
    block.svg = svg;
    log(`sketch: ${block.subject} drawn by ${model} in ${(ms / 1000).toFixed(1)} s`);
    pushBoard({ sketchMs: ms });
  } catch (err) {
    log('sketch:', err.message);
    session.blocks = session.blocks.filter((b) => b !== block); // drop the "drawing…" placeholder
    broadcast('status', { error: `Could not draw the ${block.subject}` });
    pushBoard();
  } finally {
    broadcast('status', { drawing: false });
  }
}

// ---------- Recap ----------

const RECAP_SCHEMA = { type: 'OBJECT', properties: { recap: STR }, required: ['recap'] };

async function recap() {
  const transcript = session.lines.map((l) => l.text).join('\n');
  if (!transcript) return 'Nothing to recap yet.';
  try {
    const { data } = await gemini(`Write an end-of-class recap that a high-school biology teacher will play aloud to his class
in his own voice. First person, warm, 4 to 6 short spoken sentences, plain words. Cover only what he actually said below.
The speech-to-text may have errors: use the lesson plan ONLY to correct misheard terms, never to add anything he did not say.
End with one thing to remember.

Lesson plan:
${session.lesson || '(none given)'}

What he said in class:
${transcript}`, RECAP_SCHEMA, { timeout: 12000 });
    return data.recap;
  } catch (err) {
    log('recap:', err.message);
    return session.lines.slice(-5).map((l) => l.text).join(' … '); // Gemini unavailable: read back his last few lines
  }
}

// ---------- Audio → text: Gemini listens, so slurred words can be recovered from sound + lesson context ----------
// Tested on deliberately slurred clips ("nyuh... ruhn", "aks. ahn... ter. mnl", "my. lnn"): 3.8-flash recovers neuron /
// axon / terminal / myelin in ~2.4 s and marks exactly the inferred words as [word?]. 3.5-flash is faster (~1.2 s) but
// marks less cleanly, so it is the fallback; pro models took 5-14 s, too slow for live speech.
const AUDIO_MODELS = (process.env.AUDIO_MODELS || 'gemini-3.8-flash,gemini-3.5-flash,gemini-3-flash-preview').split(',');
const MAX_AUDIO = 3 * 1024 * 1024; // ~90 s of 16 kHz mono WAV; the phone sends at most 15 s
const TEXT_SCHEMA = { type: 'OBJECT', properties: { text: STR }, required: ['text'] };

async function transcribe(wav) {
  const recentNotes = session.blocks.filter((b) => b.text).slice(-5).map((b) => b.text).join(' / ');
  const { data, ms, model } = await gemini([
    { text: `Transcribe this classroom audio of a high-school biology teacher. He has ALS: his speech is slurred, slow and
broken by pauses, so some words are hard to hear. Use the lesson context and what he said just before to work out what he
most likely said. Write his words as clean text, without stutters or repeated words.
Transcribe the WHOLE utterance, every word he says, not just the clear ones: for each unclear word give your best guess
from the sound and the context and mark it like [neuron?]; only if you truly cannot guess a word, write [?] in its
place. Never leave out a stretch of his speech because it was hard to hear. (A heavily slurred sentence that came back
as just "axon" lost everything he said around it.)
If the audio is only noise, coughing, or other people (students) talking, return empty text: only transcribe the teacher.

Lesson plan: ${session.lesson || '(none given)'}
What he said just before: ${session.lines.slice(-3).map((l) => l.text).join(' ') || '(start of class)'}
Recent board notes: ${recentNotes || '(none)'}` },
    { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } },
  ], TEXT_SCHEMA, { thinking: 'low', timeout: 10000, models: AUDIO_MODELS }); // 3.8-flash has no "minimal" level
  return { text: (data.text ?? '').trim(), ms, model };
}

// Pieces are transcribed in parallel but added to the board in the order they were spoken.
let audioQueue = Promise.resolve();
function addAudio(wav) {
  const job = transcribe(wav);
  audioQueue = audioQueue.then(async () => {
    try {
      const { text, ms, model } = await job;
      const secs = ((wav.length - 44) / (wav.readUInt32LE(28) || 32000)).toFixed(1); // audio length, from the WAV header
      if (!text) return log(`audio: nothing to transcribe (audio ${secs} s, ${ms} ms)`);
      if (isEcho(text)) return log(`audio: ignored the board's own voice: ${JSON.stringify(text.slice(0, 80))}`);
      const line = { t: Date.now(), text: text.slice(0, 2000) };
      session.lines.push(line);
      log(`heard (audio ${secs} s, ${model} ${ms} ms):`, JSON.stringify(line.text));
      broadcast('final', line);
      if (session.clearVoice) speak(line.text, 'clear'); // everything he says, not only what goes on the board
      recordSpeech(wav, line.text);
      refreshBoard();
    } catch (err) {
      log('audio:', err.message);
      broadcast('status', { error: 'Could not transcribe that: Gemini unavailable' });
    }
  });
}

// ---------- Speech fatigue tracker ----------
// Every piece of his speech is measured: speaking rate, how much of it is pauses, loudness, and how many words Gemini
// had to infer (a live stand-in for intelligibility). Only these numbers are kept, never the words.
// Case baseline (SLP, Sept 2026): 165 wpm at 9 am, 118 wpm at 4 pm; intelligibility 98% → 91%.
// Stored in Tiger Data (tiger.js) when DATABASE_URL is set; the JSON-lines file is always written too, so nothing is
// lost if the database is unreachable, and the dashboard falls back to it.
const SPEECH_FILE = new URL('./data/speech.jsonl', import.meta.url);
await mkdir(new URL('./data/', import.meta.url), { recursive: true });
// The lesson plan survives restarts and deploys (a fresh server with no lesson context transcribes slurred words worse).
const LESSON_FILE = new URL('./data/lesson.txt', import.meta.url);
session.lesson = await readFile(LESSON_FILE, 'utf8').catch(() => '');
const saveLesson = () => writeFile(LESSON_FILE, session.lesson).catch((err) => log('lesson file:', err.message));
const measured = (await readFile(SPEECH_FILE, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const SUGGEST_BELOW = 0.8;               // suggest Clear voice when speaking rate falls under 80% of his morning rate…
const SUGGEST_INFERRED = 0.1;            // …or Gemini has to infer more than 1 word in 10
const SUGGEST_EVERY_MS = 20 * 60 * 1000; // and at most once every 20 minutes
let lastSuggestion = 0;

function measure(wav, text) {
  if (wav.readUInt16LE(22) !== 1 || wav.readUInt16LE(34) !== 16) return null; // our phone sends 16-bit mono
  const rate = wav.readUInt32LE(24), n = Math.floor((wav.length - 44) / 2), frame = Math.round(rate * 0.02); // 20 ms
  const rms = [];
  for (let f = 0; f + frame <= n; f += frame) {
    let s = 0;
    for (let i = f; i < f + frame; i++) { const v = wav.readInt16LE(44 + i * 2) / 32768; s += v * v; }
    rms.push(Math.sqrt(s / frame));
  }
  const floor = [...rms].sort((a, b) => a - b)[Math.floor(rms.length * 0.2)] ?? 0;
  const isSpeech = rms.map((r) => r > Math.max(0.01, floor * 3));
  const first = isSpeech.indexOf(true), last = isSpeech.lastIndexOf(true);
  if (first < 0) return null;
  const span = isSpeech.slice(first, last + 1), voiced = rms.slice(first, last + 1).filter((_, i) => span[i]);
  const seconds = span.length * 0.02;
  const words = plain(text).split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
  if (seconds < 1.5 || words < 4) return null; // too short to say anything about his speech
  return {
    t: Date.now(),
    words,
    seconds: +seconds.toFixed(2),
    wpm: Math.round(words / (seconds / 60)),
    pause: +(1 - voiced.length / span.length).toFixed(3),                       // share of the span that is silence
    db: +(20 * Math.log10(voiced.reduce((a, b) => a + b, 0) / voiced.length)).toFixed(1), // loudness while voiced
    inferred: (text.match(/\[[^\]]+?\?\]/g) ?? []).length,
  };
}

function recordSpeech(wav, text) {
  const m = measure(wav, text);
  if (!m) return;
  measured.push(m);
  appendFile(SPEECH_FILE, JSON.stringify(m) + '\n').catch((err) => log('speech file:', err.message));
  if (tiger.ready()) tiger.insert([m]).catch((err) => log('tiger: insert failed (kept in the local file):', err.message));
  log(`speech: ${m.wpm} wpm, ${Math.round(m.pause * 100)}% pauses, ${m.db} dB, ${m.inferred}/${m.words} inferred`);
  broadcast('speech', m);
  maybeSuggestClearVoice();
}

// Sample history for the weeks before today, so the trends have something to show in the demo. Clearly labelled as
// sample everywhere it appears. Built from the case: 165 wpm at 9 am falling to 118 at 4 pm, getting slightly worse
// week by week (ALSFRS-R falls ~0.6 points a month; bulbar involvement is early). Deterministic, so it never changes.
function sampleHistory(days = 63) { // ~9 weeks, so this month and last month both have days in the calendar
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const out = [], today = new Date(); today.setHours(0, 0, 0, 0);
  for (let d = days; d >= 1; d--) {
    const day = new Date(today - d * 864e5);
    if (day.getDay() === 0 || day.getDay() === 6) continue; // school days only
    const weeksAgo = d / 7;
    for (const start of [9, 10.5, 13, 14.75]) {             // his four classes
      for (let k = 0; k < 6; k++) {
        const hour = start + k * 0.2, late = Math.min(1, Math.max(0, (hour - 9) / 7)); // 0 at 9 am → 1 at 4 pm
        const t = new Date(day); t.setMinutes(Math.round(hour * 60));
        const words = 12 + Math.round(rand() * 8);
        const wpm = Math.round(165 - 47 * late + weeksAgo * 1.6 + rand() * 12);
        out.push({ t: t.getTime(), words, seconds: +(words / wpm * 60).toFixed(2), wpm, sample: true,
          pause: +(0.17 + 0.15 * late - weeksAgo * 0.005 + rand() * 0.05).toFixed(3),
          db: +(-19 - 4 * late + weeksAgo * 0.2 + rand() * 1.5).toFixed(1),
          inferred: Math.max(0, Math.round(words * (0.02 + 0.08 * late - weeksAgo * 0.004 + rand() * 0.03))) });
      }
    }
  }
  return out;
}
const HISTORY = sampleHistory();

// Tiger Data: connect in the background so the server starts at once. Until it is ready (or if it fails) the
// dashboard uses the local file and HISTORY.
if (process.env.DATABASE_URL) {
  tiger.init(process.env.DATABASE_URL, log)
    .then(() => tiger.seed(HISTORY, measured, log))
    .then(() => log('tiger: connected, speech measurements are in Tiger Data'))
    .catch((err) => log('tiger: unavailable, using the local file:', err.message));
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sumBy = (xs, k) => xs.reduce((a, x) => a + x[k], 0);
const isToday = (t) => new Date(t).toDateString() === new Date().toDateString();
const hourOf = (t) => { const d = new Date(t); return d.getHours() + d.getMinutes() / 60; };


// Right now = the last three pieces measured today.
function current() {
  const recent = measured.filter((m) => isToday(m.t)).slice(-3);
  if (!recent.length) return null;
  const words = sumBy(recent, 'words');
  return { wpm: Math.round(words / (sumBy(recent, 'seconds') / 60)), pause: mean(recent.map((m) => m.pause)),
    db: mean(recent.map((m) => m.db)), inferredRate: sumBy(recent, 'inferred') / words, pieces: recent.length };
}

async function maybeSuggestClearVoice() {
  const now = current();
  if (!now || now.pieces < 2 || session.clearVoice || Date.now() - lastSuggestion < SUGGEST_EVERY_MS) return;
  const base = (await insights()).baseline; // his usual morning rate: the same number the page shows
  const slow = now.wpm < base * SUGGEST_BELOW, unclear = now.inferredRate > SUGGEST_INFERRED;
  if (!slow && !unclear) return;
  lastSuggestion = Date.now();
  const reason = slow ? `Your speaking rate is ${now.wpm} words a minute, ${Math.round((1 - now.wpm / base) * 100)}% below your mornings.`
    : `Gemini has had to fill in ${Math.round(now.inferredRate * 100)}% of your words in the last few minutes.`;
  log('suggest: Clear voice.', reason);
  broadcast('suggest', { mode: 'clearVoice', reason });
}

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayStart = (key) => { const [y, m, d] = key.split('-').map(Number); return +new Date(y, m - 1, d); };
// Pooled stats for a set of pieces: rate = total words / total speaking time.
function stats(xs) {
  if (!xs.length) return null;
  const words = sumBy(xs, 'words');
  return { wpm: Math.round(words / (sumBy(xs, 'seconds') / 60)), pause: mean(xs.map((m) => m.pause)),
    db: mean(xs.map((m) => m.db)), inferredRate: sumBy(xs, 'inferred') / (words || 1), pieces: xs.length };
}

// Everything the "My speech" page draws for one day (default today): that day through the school day against a
// typical day from the 4 weeks before it, weekly morning/afternoon averages up to it, and every day for the calendar.
function insightsLocal(day) {
  const all = [...HISTORY, ...measured], start = dayStart(day), today = day === dayKey(Date.now());
  const before = all.filter((m) => m.t < start && m.t >= start - 28 * 864e5);
  const onDay = all.filter((m) => dayKey(m.t) === day);
  const mornings = before.filter((m) => hourOf(m.t) < 11);
  const base = Math.round(mean(mornings.map((m) => m.wpm)) ?? 165);
  const typical = [];
  for (let h = 8.5; h < 16.5; h += 0.5) { // half-hour bins over the school day
    const bin = before.filter((m) => hourOf(m.t) >= h && hourOf(m.t) < h + 0.5);
    if (bin.length) typical.push({ hour: h + 0.25, wpm: Math.round(mean(bin.map((m) => m.wpm))) });
  }
  const weeks = new Map();
  for (const m of all.filter((x) => x.t < start + 864e5 && x.t >= start - 42 * 864e5)) { // the 6 weeks up to the day
    const d = new Date(m.t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // that week's Monday
    const w = weeks.get(+d) ?? { week: +d, am: [], pm: [], sample: false };
    (hourOf(m.t) < 12 ? w.am : w.pm).push(m.wpm);
    w.sample ||= !!m.sample;
    weeks.set(+d, w);
  }
  const days = new Map();
  for (const m of all) {
    const k = dayKey(m.t), d = days.get(k) ?? { date: k, am: [], pm: [], sample: false, live: false };
    (hourOf(m.t) < 12 ? d.am : d.pm).push(m.wpm);
    m.sample ? (d.sample = true) : (d.live = true);
    days.set(k, d);
  }
  return {
    day, today,
    baseline: base,
    threshold: Math.round(base * SUGGEST_BELOW),
    morning: { wpm: base, pause: mean(mornings.map((m) => m.pause)), db: mean(mornings.map((m) => m.db)),
      inferredRate: sumBy(mornings, 'inferred') / (sumBy(mornings, 'words') || 1) },
    now: today ? current() : stats(onDay),   // today: the last few minutes; another day: that whole day
    afternoon: stats(onDay.filter((m) => hourOf(m.t) >= 12)),
    points: onDay.sort((a, b) => a.t - b.t).map(({ t, wpm, pause, db, words, inferred, sample }) => ({ hour: hourOf(t), wpm, pause, db, words, inferred, sample: !!sample })),
    typical,
    weekly: [...weeks.values()].sort((a, b) => a.week - b.week)
      .map((w) => ({ week: w.week, morning: Math.round(mean(w.am)), afternoon: Math.round(mean(w.pm)), sample: w.sample })),
    days: [...days.values()].map((d) => ({ date: d.date, morning: Math.round(mean(d.am)) || null, afternoon: Math.round(mean(d.pm)) || null, sample: d.sample, live: d.live })),
    totals: { measured: measured.length, sample: HISTORY.length },
  };
}

// The dashboard from Tiger Data's continuous aggregate; the local version fills in anything it doesn't cover and is
// the fallback. "store" tells the page where the numbers came from.
async function insights(day = dayKey(Date.now())) {
  const local = insightsLocal(day);
  if (!tiger.ready()) return { ...local, store: 'local' };
  try {
    const [d, totals] = await Promise.all([tiger.dashboard(dayStart(day)), tiger.counts()]);
    const base = Math.round(d.morning?.wpm ?? local.baseline);
    return {
      ...local,
      baseline: base,
      threshold: Math.round(base * SUGGEST_BELOW),
      morning: d.morning ?? local.morning,
      now: local.today ? current() : stats(d.points),
      afternoon: stats(d.points.filter((p) => p.hour >= 12)),
      points: d.points, typical: d.typical, weekly: d.weekly, days: d.days, totals,
      store: 'tiger',
    };
  } catch (err) {
    log('tiger: dashboard query failed, using the local file:', err.message);
    return { ...local, store: 'local' };
  }
}

const SUMMARY_SCHEMA = { type: 'OBJECT', properties: { summary: STR }, required: ['summary'] };
async function clinicSummary() {
  const s = await insights(), recent = [...HISTORY, ...measured].filter((m) => Date.now() - m.t < 28 * 864e5);
  const byPart = (am) => recent.filter((m) => (hourOf(m.t) < 12) === am);
  const stats = (xs) => xs.length ? { wpm: Math.round(mean(xs.map((m) => m.wpm))), pausePct: Math.round(mean(xs.map((m) => m.pause)) * 100),
    inferredPct: +((sumBy(xs, 'inferred') / sumBy(xs, 'words')) * 100).toFixed(1), loudnessDb: +mean(xs.map((m) => m.db)).toFixed(1) } : null;
  const split = s.store === 'tiger' ? await tiger.clinicStats().catch(() => null) : null; // from the continuous aggregate
  const facts = { mornings: split?.mornings ?? stats(byPart(true)), afternoons: split?.afternoons ?? stats(byPart(false)), weekly: s.weekly, today: stats(measured.filter((m) => isToday(m.t))),
    clearVoiceThresholdWpm: s.threshold, samplePieces: s.totals.sample, liveMeasuredPieces: s.totals.measured };
  const { data } = await gemini(`Write a short summary for an ALS clinic team (neurologist, speech-language pathologist)
about their patient's speech between clinic visits. The patient is a 47-year-old high-school teacher with limb-onset
ALS and early bulbar involvement who is still teaching full time. The numbers below come from a classroom microphone
during his lessons over the last four weeks.

Rules: plain clinical English, about 150 words, short paragraphs. Report what was measured and how it changes over the
school day and across the weeks. Describe the numbers only; do not attribute causes (e.g. do not say "indicating
fatigue"). Do NOT diagnose, predict progression, or recommend treatment; you may note what the team might want to
look at. Say that speaking rate is measured on connected classroom speech (not a standardised
reading passage), and that "words inferred" is the share of words the transcription model had to work out from
context, an indirect sign of intelligibility. If samplePieces > 0, say clearly that most of this history is sample
data for a demonstration and only liveMeasuredPieces were measured live.

Measurements: ${JSON.stringify(facts)}`, SUMMARY_SCHEMA, { thinking: 'low', timeout: 20000 });
  return data.summary;
}

// ---------- Voice: the board laptop speaks his words in his (cloned) voice, via ElevenLabs ----------
// The server announces each thing to say; the board fetches /api/tts/<id>, which streams ElevenLabs audio straight
// through, so playback starts as soon as the first audio arrives. Without a key, the board uses the browser's voice.
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5'; // ElevenLabs' low-latency model
// No voice_settings are sent, so the voice uses the settings saved on it in ElevenLabs (stability 0.5, style 0,
// speed 1.0), the same as on their website. An earlier override (stability 0.4, style 0.15) made his clone swing
// into yelling or sudden cheer on plain sentences (2026-11-07): lower stability and any style make it more erratic.
const toSpeak = new Map(); // id → { text, previous }, until the board fetches it
let nextSpeechId = 1, voiceId = process.env.ELEVENLABS_VOICE_ID || '', lastSpoken = { t: 0, text: '' };
// "the [neuron?]" → "the neuron"; a word Gemini couldn't guess ("[?]") is skipped rather than read out.
const plain = (t) => t.replace(/\[\?\]/g, ' ').replace(/\[([^\]]+?)\?\]/g, '$1').replace(/\s+([,.!?;:])/g, '$1').replace(/\s{2,}/g, ' ');

function speak(text, kind) {
  let clean = plain(text).trim().slice(0, 1500);
  if (!/[a-z0-9]/i.test(clean)) return;
  // Without an ending the voice guesses the tone, often rising or rushed, and can clip the last word.
  if (!/[.!?…]["')\]]*$/.test(clean)) clean += '.';
  spokenRecently.push({ t: Date.now(), words: words(clean) });
  const id = String(nextSpeechId++);
  // What it said just before (within a minute) is passed along so the tone carries on instead of restarting each line.
  const previous = Date.now() - lastSpoken.t < 60000 ? lastSpoken.text.slice(-500) : '';
  lastSpoken = { t: Date.now(), text: clean };
  toSpeak.set(id, { text: clean, previous });
  setTimeout(() => toSpeak.delete(id), 5 * 60 * 1000);
  broadcast('speak', { id, kind, text: clean, voice: !!process.env.ELEVENLABS_API_KEY });
}

// No voice ID configured yet: use the first voice on the account, so it works before the clone is made.
async function getVoiceId(key) {
  if (voiceId) return voiceId;
  const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
  if (!res.ok) throw new Error(`voices ${res.status}`);
  voiceId = (await res.json()).voices?.[0]?.voice_id ?? '';
  if (!voiceId) throw new Error('no voices on this ElevenLabs account');
  log(`voice: no ELEVENLABS_VOICE_ID set, using ${voiceId}`);
  return voiceId;
}

async function streamSpeech(id, res) {
  const { text, previous } = toSpeak.get(id) ?? {}, key = process.env.ELEVENLABS_API_KEY;
  if (!text || !key) return send(res, 404, 'nothing to say');
  const t0 = performance.now();
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${await getVoiceId(key)}/stream?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: ELEVEN_MODEL, ...(previous && { previous_text: previous }) }),
  });
  if (!r.ok) {
    log(`voice: ElevenLabs ${r.status} ${(await r.text()).slice(0, 160)}`);
    return send(res, 502, 'voice unavailable');
  }
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
  let first = true;
  for await (const chunk of r.body) {
    if (first) { log(`voice: first audio after ${Math.round(performance.now() - t0)} ms (${ELEVEN_MODEL}, ${text.length} chars)`); first = false; }
    res.write(chunk);
  }
  res.end();
}

// Echo guard: while the board's speakers play his voice, the clip mic hears it. Ignore what comes in meanwhile
// (and just after), or the replay would be transcribed and spoken again.
let boardSpeaking = false, boardSpokeAt = 0;
const hearingEcho = () => boardSpeaking || Date.now() - boardSpokeAt < 800; // live captions only
// Audio pieces arrive ~2 s after they end, so timing alone let a spoken recap back in as if he'd said it (seen
// 2026-11-07). Instead compare what was heard with what the board said in the last 2 minutes: mostly the same words
// = the speakers. A real sentence he says while the board is talking is kept.
const spokenRecently = [];
function isEcho(text) {
  while (spokenRecently.length && Date.now() - spokenRecently[0].t > 120000) spokenRecently.shift();
  const heard = words(text);
  if (heard.size < 3) return false;
  return spokenRecently.some((s) => [...heard].filter((w) => s.words.has(w)).length / heard.size >= 0.7);
}

// ---------- Lesson plan upload ----------
// Gemini reads PDFs and images natively; plain text is used as-is. (Word/PowerPoint aren't readable inline, so the
// board asks for a PDF instead of us unzipping Office files.)
const LESSON_FILE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'text/plain', 'text/markdown']);
const MAX_LESSON_FILE = 15 * 1024 * 1024; // inline Gemini requests top out around 20 MB
const LESSON_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite'];

async function readLessonPlan(file, type) {
  if (type.startsWith('text/')) return file.toString('utf8');
  const { data } = await gemini([
    { text: `This is a high-school biology teacher's lesson plan (it may be a document, slides, or a photo of handwritten
notes). Turn it into lesson context for a live classroom assistant that transcribes the teacher's slurred speech (he has
ALS) and writes the whiteboard. Plain text, in this order:
Topic: one line.
Outline: the topics in teaching order, one per line.
Key terms: every biology term, name and abbreviation he is likely to say, comma separated (these are what we listen for).
Diagrams: structures or processes he may ask to draw, one per line.
Only include what is in the plan.` },
    { inlineData: { mimeType: type, data: file.toString('base64') } },
  ], TEXT_SCHEMA, { thinking: 'low', timeout: 45000, models: LESSON_MODELS });
  return (data.text ?? '').trim();
}

// ---------- HTTP ----------

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); } else parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('bad json')); }
    });
  });
}

function send(res, status, body = '') {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(body);
}

const routes = {
  'GET /api/events': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: init\ndata: ${JSON.stringify({ lesson: session.lesson, board: boardState(), clearVoice: session.clearVoice })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  },

  // Phone sends { text, final }. Interim text is live captions; final text goes to the board.
  'POST /api/speech': async (req, res) => {
    const { text, final } = await readJson(req);
    if (typeof text !== 'string' || !text.trim()) return send(res, 400, 'text required');
    const clean = text.trim().slice(0, 2000);
    if (hearingEcho()) return send(res, 204); // that's the board's speakers, not him
    lastSpeechAt = Date.now(); // still talking: the board waits for a pause before writing
    if (final) {
      const line = { t: Date.now(), text: clean };
      session.lines.push(line);
      log('heard:', JSON.stringify(clean));
      broadcast('final', line);
      refreshBoard();
    } else {
      broadcast('interim', { text: clean });
    }
    send(res, 204);
  },

  // Phone sends each spoken piece as a 16 kHz mono WAV, cut at pauses.
  'POST /api/audio': async (req, res) => {
    const wav = await readBody(req, MAX_AUDIO);
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return send(res, 400, 'WAV required');
    lastSpeechAt = Date.now();
    addAudio(wav);
    send(res, 202);
  },

  // Phone buttons: { type: 'repeat' | 'recap' }
  'POST /api/action': async (req, res) => {
    const { type } = await readJson(req);
    if (type === 'repeat') {
      const last = session.lines.at(-1);
      broadcast('repeat', last ? { ...last, text: plain(last.text) } : null);
      if (last) speak(last.text, 'repeat');
    }
    else if (type === 'recap') {
      broadcast('recap', { pending: true });
      recap().then((text) => { broadcast('recap', { text }); speak(text, 'recap'); });
    } else return send(res, 400, 'unknown action');
    send(res, 204);
  },

  // ?day=YYYY-MM-DD for any day in the calendar; today by default.
  'GET /api/insights': async (req, res) => {
    const day = new URL(req.url, 'http://localhost').searchParams.get('day');
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return send(res, 400, 'day must be YYYY-MM-DD');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(await insights(day ?? undefined)));
  },

  'POST /api/clinic-summary': async (req, res) => {
    try {
      send(res, 200, await clinicSummary());
    } catch (err) {
      log('clinic summary:', err.message);
      send(res, 502, 'Could not write the summary right now. Try again in a minute.');
    }
  },

  // Phone: { clearVoice: true | false }. Re-speak everything he says in his clear voice.
  'POST /api/mode': async (req, res) => {
    const { clearVoice } = await readJson(req);
    if (typeof clearVoice !== 'boolean') return send(res, 400, 'clearVoice must be true or false');
    session.clearVoice = clearVoice;
    log(`mode: Clear Voice ${clearVoice ? 'on' : 'off'}`);
    broadcast('mode', { clearVoice });
    send(res, 204);
  },

  // Board: { playing: true | false } around each spoken clip, for the echo guard.
  'POST /api/playback': async (req, res) => {
    const { playing } = await readJson(req);
    boardSpeaking = !!playing;
    if (!playing) boardSpokeAt = Date.now();
    send(res, 204);
  },

  'POST /api/lesson': async (req, res) => {
    const { text } = await readJson(req);
    if (typeof text !== 'string') return send(res, 400, 'text required');
    session.lesson = text.slice(0, 20000);
    saveLesson();
    broadcast('lesson', { text: session.lesson });
    send(res, 204);
  },

  // Upload a lesson plan file (raw body, Content-Type = the file's type). Gemini reads it and writes the lesson context.
  'POST /api/lesson-file': async (req, res) => {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (!LESSON_FILE_TYPES.has(type)) return send(res, 415, 'Use a PDF, a photo, or a text file. Save Word or PowerPoint files as PDF first.');
    const file = await readBody(req, MAX_LESSON_FILE);
    if (!file.length) return send(res, 400, 'empty file');
    try {
      session.lesson = (await readLessonPlan(file, type)).slice(0, 20000);
      saveLesson();
      log(`lesson plan read from ${type} (${Math.round(file.length / 1024)} KB)`);
      broadcast('lesson', { text: session.lesson });
      send(res, 200, session.lesson);
    } catch (err) {
      log('lesson file:', err.message);
      send(res, 502, 'Could not read that file right now. Try again, or paste the plan as text.');
    }
  },

  'POST /api/reset': (req, res) => {
    sketchImages.clear();
    session.lines = [];
    session.title = '';
    session.blocks = [];
    boardUpTo = 0;
    visualUsedUpTo = 0;
    broadcast('status', { error: '' });
    pushBoard();
    send(res, 204);
  },
};

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    const route = routes[`${req.method} ${pathname}`];
    if (route) return await route(req, res);
    const tts = req.method === 'GET' && pathname.match(/^\/api\/tts\/(\d+)$/);
    if (tts) return await streamSpeech(tts[1], res);
    const sketch = req.method === 'GET' && pathname.match(/^\/api\/sketch\/(\d+)$/);
    if (sketch) {
      const img = sketchImages.get(Number(sketch[1]));
      if (!img) return send(res, 404, 'not found');
      res.writeHead(200, { 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=86400' });
      return res.end(img.buf);
    }
    // Images like the gecko poses: flat names only, so nothing outside public/assets can be read.
    const asset = req.method === 'GET' && pathname.match(/^\/assets\/([\w-]+)\.(png|webp|svg|jpg)$/);
    if (asset) {
      const file = await readFile(new URL(`./public/assets/${asset[1]}.${asset[2]}`, import.meta.url)).catch(() => null);
      if (!file) return send(res, 404, 'not found');
      res.writeHead(200, { 'Content-Type': ASSET_TYPES[asset[2]], 'Cache-Control': 'max-age=300' });
      return res.end(file);
    }
    const page = req.method === 'GET' && PAGES[pathname];
    if (!page) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await readFile(new URL(`./public/${page}`, import.meta.url)));
  } catch (err) {
    log(err.message);
    if (!res.headersSent) send(res, 400, err.message);
  }
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}  (phone: /phone, board: /board)`);
  console.log(process.env.GEMINI_API_KEY ? `Gemini: ${GEMINI_MODELS.join(' → ')}` : 'Gemini: no key, board shows raw speech');
  console.log(process.env.ELEVENLABS_API_KEY ? `Voice: ElevenLabs ${ELEVEN_MODEL}${voiceId ? `, voice ${voiceId}` : ', first voice on the account'}`
    : 'Voice: no ELEVENLABS_API_KEY, the board uses the browser voice');
});

