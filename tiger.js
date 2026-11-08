// Tiger Data (Tiger Cloud: Postgres + TimescaleDB) store for the speech measurements.
//
//   speech_pieces   hypertable, one row per measured piece of speech: numbers only, never words
//   speech_30min    continuous aggregate: half-hour totals per teacher, kept up to date by Timescale itself
//                   (real-time, so a piece measured a second ago is already counted). The "My speech" page and
//                   the clinic summary read from this, not from the raw rows.
//   retention       raw pieces are deleted after 120 days; the half-hour totals stay. Less raw data about a
//                   teacher in a classroom of minors, and the trends still work.
//   columnstore     week-old chunks are compressed (same numbers, a fraction of the space).
//
// Every function throws if the database is unreachable; server.js then falls back to its local file.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

const TZ = 'America/Toronto';     // the school's day: "morning", "4 pm" and calendar days are local
const TEACHER = 'alex';
let pool = null;
export const ready = () => !!pool;

const n = (x) => (x == null ? null : Number(x));

// Tiger Cloud signs its servers' certificates with its own authority (ca.timescale.com), which Node doesn't trust by
// default. tiger-ca.pem is that authority's certificate, so the connection is still fully verified (certificate and
// hostname) instead of switching checking off. sslmode is removed from the URL because pg lets it override `ssl`.
const CA = await readFile(new URL('./tiger-ca.pem', import.meta.url), 'utf8').catch(() => null);

export async function init(url, log) {
  const u = new URL(url);
  if (CA) u.searchParams.delete('sslmode');
  const p = new pg.Pool({ connectionString: u.toString(), ...(CA && { ssl: { ca: CA } }),
    max: 4, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000 });
  p.on('error', (err) => log('tiger: idle connection error:', err.message)); // dropped idle connections must not crash us
  const q = (sql) => p.query(sql);
  await q(`CREATE TABLE IF NOT EXISTS speech_pieces (
    time      timestamptz NOT NULL,
    teacher   text        NOT NULL DEFAULT '${TEACHER}',
    words     integer     NOT NULL,
    seconds   real        NOT NULL,
    wpm       integer     NOT NULL,
    pause     real        NOT NULL,   -- share of the piece that is silence, 0..1
    db        real        NOT NULL,   -- loudness while voiced, dBFS
    inferred  integer     NOT NULL,   -- words Gemini had to work out from context
    sample    boolean     NOT NULL DEFAULT false
  )`);
  await q(`SELECT create_hypertable('speech_pieces', by_range('time', INTERVAL '7 days'), if_not_exists => TRUE)`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS speech_pieces_once ON speech_pieces (teacher, time, sample)`);
  await q(`CREATE MATERIALIZED VIEW IF NOT EXISTS speech_30min
    WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
    SELECT teacher, sample, time_bucket(INTERVAL '30 minutes', time) AS bucket,
           count(*) AS pieces, sum(words) AS words, sum(seconds) AS seconds, sum(wpm) AS wpm_sum,
           sum(pause) AS pause_sum, sum(db) AS db_sum, sum(inferred) AS inferred
    FROM speech_pieces GROUP BY teacher, sample, bucket WITH NO DATA`);
  // Refresh window ends before the retention cut-off, so deleting old raw rows never empties their totals.
  await q(`SELECT add_continuous_aggregate_policy('speech_30min', start_offset => INTERVAL '100 days',
    end_offset => INTERVAL '30 minutes', schedule_interval => INTERVAL '15 minutes', if_not_exists => TRUE)`);
  await q(`SELECT add_retention_policy('speech_pieces', INTERVAL '120 days', if_not_exists => TRUE)`);
  try {
    await q(`ALTER TABLE speech_pieces SET (timescaledb.compress, timescaledb.compress_segmentby = 'teacher')`);
    await q(`SELECT add_compression_policy('speech_pieces', INTERVAL '7 days', if_not_exists => TRUE)`);
  } catch (err) {
    log('tiger: compression not set up:', err.message); // nice to have; never block startup on it
  }
  pool = p;
}

const COLS = ['time', 'teacher', 'words', 'seconds', 'wpm', 'pause', 'db', 'inferred', 'sample'];
// Many rows in one statement. ON CONFLICT: the same piece twice (e.g. a re-import) is stored once.
export async function insert(rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500), vals = [];
    const tuples = chunk.map((m, r) => {
      vals.push(new Date(m.t), TEACHER, m.words, m.seconds, m.wpm, m.pause, m.db, m.inferred, !!m.sample);
      return `(${COLS.map((_, c) => `$${r * COLS.length + c + 1}`).join(',')})`;
    });
    await pool.query(`INSERT INTO speech_pieces (${COLS}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, vals);
  }
}

// Load the sample history once (it is deterministic), then make sure the half-hour totals cover it: the refresh
// policy only looks back 100 days and real-time aggregation only adds rows newer than what is materialised.
export async function seed(history, live, log) {
  const { rows } = await pool.query(`SELECT count(*)::int AS c FROM speech_pieces WHERE sample`);
  if (!rows[0].c) {
    await insert(history);
    log(`tiger: loaded ${history.length} sample pieces`);
  }
  if (live.length) await insert(live); // measurements from the local file (e.g. made while offline)
  await pool.query(`CALL refresh_continuous_aggregate('speech_30min', NULL, now() - INTERVAL '30 minutes')`);
}

const local = (col) => `(${col} AT TIME ZONE '${TZ}')`;
const hour = (col) => `extract(epoch from ${local(col)}::time) / 3600`;
// Speaking rate over a group = total words / total speaking time (optionally only rows matching a condition).
const pooled = (cond) => {
  const f = cond ? ` FILTER (WHERE ${cond})` : '';
  return `round(sum(words)${f} / nullif(sum(seconds)${f}, 0) * 60)::float8`;
};

// Everything the dashboard needs from the database for one day, as plain numbers.
//   dayStart: ms of local midnight of that day. All windows match the local-file version in server.js.
export async function dashboard(dayStart) {
  const start = new Date(dayStart), end = new Date(dayStart + 864e5);
  const before = [new Date(dayStart - 28 * 864e5), start];
  const [typical, morning, weekly, days, points] = await Promise.all([
    // A typical day: the 4 weeks before, by half hour of the school day.
    pool.query(`SELECT ${hour('bucket')} AS h, ${pooled()} AS wpm FROM speech_30min
      WHERE teacher = $1 AND bucket >= $2 AND bucket < $3 GROUP BY 1 HAVING sum(seconds) > 0 ORDER BY 1`, [TEACHER, ...before]),
    // His usual morning (before 11 am) over those 4 weeks.
    pool.query(`SELECT ${pooled()} AS wpm, (sum(pause_sum) / sum(pieces))::float8 AS pause, (sum(db_sum) / sum(pieces))::float8 AS db,
      (sum(inferred)::float8 / nullif(sum(words), 0)) AS inferred_rate FROM speech_30min
      WHERE teacher = $1 AND bucket >= $2 AND bucket < $3 AND ${hour('bucket')} < 11`, [TEACHER, ...before]),
    // Weekly morning vs afternoon, the 6 weeks up to the day. date_trunc('week') starts on Monday.
    pool.query(`SELECT (extract(epoch from date_trunc('week', ${local('bucket')}) AT TIME ZONE '${TZ}') * 1000)::float8 AS week,
      ${pooled(`${hour('bucket')} < 12`)} AS morning, ${pooled(`${hour('bucket')} >= 12`)} AS afternoon,
      bool_or(sample) AS sample FROM speech_30min WHERE teacher = $1 AND bucket >= $2 AND bucket < $3 GROUP BY 1 ORDER BY 1`,
      [TEACHER, new Date(dayStart - 42 * 864e5), end]),
    // Every day for the calendar.
    pool.query(`SELECT to_char(${local('bucket')}, 'YYYY-MM-DD') AS date,
      ${pooled(`${hour('bucket')} < 12`)} AS morning, ${pooled(`${hour('bucket')} >= 12`)} AS afternoon,
      bool_or(sample) AS sample, bool_or(NOT sample) AS live FROM speech_30min WHERE teacher = $1 GROUP BY 1 ORDER BY 1`, [TEACHER]),
    // That day's pieces themselves, for the "through the day" dots.
    pool.query(`SELECT ${hour('time')} AS hour, wpm, pause, db, words, seconds, inferred, sample FROM speech_pieces
      WHERE teacher = $1 AND time >= $2 AND time < $3 ORDER BY time`, [TEACHER, start, end]),
  ]);
  const m = morning.rows[0];
  return {
    typical: typical.rows.filter((r) => r.h >= 8.5 && r.h < 16.5).map((r) => ({ hour: n(r.h) + 0.25, wpm: n(r.wpm) })),
    morning: m.wpm == null ? null : { wpm: n(m.wpm), pause: n(m.pause), db: n(m.db), inferredRate: n(m.inferred_rate) ?? 0 },
    weekly: weekly.rows.map((r) => ({ week: n(r.week), morning: n(r.morning), afternoon: n(r.afternoon), sample: r.sample })),
    days: days.rows.map((r) => ({ date: r.date, morning: n(r.morning), afternoon: n(r.afternoon), sample: r.sample, live: r.live })),
    points: points.rows.map((r) => ({ hour: n(r.hour), wpm: r.wpm, pause: r.pause, db: r.db, words: r.words, seconds: r.seconds, inferred: r.inferred, sample: r.sample })),
  };
}

// Mornings vs afternoons over the last 4 weeks, for the clinic summary.
export async function clinicStats() {
  const { rows } = await pool.query(`SELECT ${hour('bucket')} < 12 AS am, ${pooled()} AS wpm,
      round((sum(pause_sum) / sum(pieces) * 100)::numeric)::float8 AS pause_pct,
      round((sum(inferred)::numeric / nullif(sum(words), 0) * 100), 1)::float8 AS inferred_pct,
      round((sum(db_sum) / sum(pieces))::numeric, 1)::float8 AS loudness_db,
      sum(pieces)::int AS pieces
    FROM speech_30min WHERE teacher = $1 AND bucket >= now() - INTERVAL '28 days' GROUP BY 1`, [TEACHER]);
  const pick = (am) => {
    const r = rows.find((x) => x.am === am);
    return r ? { wpm: r.wpm, pausePct: r.pause_pct, inferredPct: r.inferred_pct, loudnessDb: r.loudness_db } : null;
  };
  return { mornings: pick(true), afternoons: pick(false) };
}

export async function counts() {
  const { rows } = await pool.query(`SELECT count(*) FILTER (WHERE NOT sample)::int AS measured, count(*) FILTER (WHERE sample)::int AS sample FROM speech_pieces`);
  return rows[0];
}
