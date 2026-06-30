/**
 * replay-log.js
 *
 * Plays back a recorded "time_sec,value" .txt log by POSTing each row to
 * /adc, exactly like the ESP32 does. Use this to test the live website
 * end-to-end with a real recording, without needing the actual board
 * connected, and without adding any file-upload UI back into the website
 * itself (that was intentionally removed when we wired up the real ESP32).
 *
 * Usage (with the server already running via `npm start` in another
 * terminal):
 *   node replay-log.js adc_log.txt
 *   node replay-log.js adc_log__1_.txt --speed 2          (2x speed)
 *   node replay-log.js adc_log.txt --url http://localhost:3000/adc
 *
 * Requires Node 18+ (uses the built-in fetch). Check with `node -v`.
 */

const fs = require('fs');

function parseArgs(argv) {
  const args = { speed: 1, url: 'http://localhost:3000/adc' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--speed') args.speed = parseFloat(argv[++i]);
    else if (argv[i] === '--url') args.url = argv[++i];
    else positional.push(argv[i]);
  }
  args.file = positional[0];
  return args;
}

function loadRows(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    if (line.toLowerCase().startsWith('time')) continue; // header row
    const [tStr, vStr] = line.split(',');
    const t = parseFloat(tStr);
    const value = parseFloat(vStr);
    if (Number.isNaN(t) || Number.isNaN(value)) continue;
    rows.push({ t, value });
  }
  return rows;
}

async function replay(args) {
  if (!args.file) {
    console.error('Usage: node replay-log.js <file.txt> [--speed N] [--url http://host:port/adc]');
    process.exit(1);
  }

  const rows = loadRows(args.file);
  console.log(`Loaded ${rows.length} samples from ${args.file}, ${rows[rows.length - 1].t.toFixed(1)}s of recorded data.`);
  console.log(`Replaying at ${args.speed}x to ${args.url} ... (Ctrl+C to stop)`);

  let posted = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      await fetch(args.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: row.value }),
      });
      posted++;
    } catch (err) {
      console.error(`Could not reach ${args.url} - is the server running ("npm start")?`, err.message);
      process.exit(1);
    }

    if (posted % 200 === 0) {
      console.log(`  ${posted}/${rows.length} samples sent (t=${row.t.toFixed(1)}s)`);
    }

    const next = rows[i + 1];
    if (next) {
      const delayMs = Math.max(0, (next.t - row.t) * 1000) / args.speed;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  console.log(`Done. Sent all ${posted} samples.`);
}

replay(parseArgs(process.argv.slice(2)));
