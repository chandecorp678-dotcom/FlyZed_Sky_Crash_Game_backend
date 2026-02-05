const fs = require('fs');
const path = require('path');

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_LEVEL = process.env.LOG_LEVEL || 'info';
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] !== undefined ? process.env.LOG_LEVEL : DEFAULT_LEVEL;

let fileStream = null;
if (process.env.LOG_TO_FILE === 'true') {
  try {
    const logPath = process.env.LOG_FILE_PATH || path.join(__dirname, 'logs', 'app.log');
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fileStream = fs.createWriteStream(logPath, { flags: 'a' });
  } catch (err) {
    // If file logging cannot be created, fall back to console only
    console.error('logger: failed to open log file', err && err.message ? err.message : err);
    fileStream = null;
  }
}

function shouldLog(levelName) {
  const cur = LOG_LEVELS[CURRENT_LEVEL] ?? LOG_LEVELS['info'];
  const lvl = LOG_LEVELS[levelName] ?? LOG_LEVELS['info'];
  return lvl <= cur;
}

function formatEntry(levelName, message, meta) {
  const entry = {
    ts: new Date().toISOString(),
    level: levelName,
    message: typeof message === 'string' ? message : String(message),
  };
  if (meta !== undefined) {
    entry.meta = meta;
  }
  return JSON.stringify(entry);
}

function write(levelName, message, meta) {
  if (!shouldLog(levelName)) return;
  const line = formatEntry(levelName, message, meta);
  // Always emit to console (structured JSON for easier ingestion)
  if (levelName === 'error' || levelName === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
  // Optionally append to file
  if (fileStream) {
    try {
      fileStream.write(line + '\n');
    } catch (e) {
      // Keep console as the main sink; swallow file write errors
    }
  }
}

// Convenience helpers
function info(msg, meta) { write('info', msg, meta); }
function warn(msg, meta) { write('warn', msg, meta); }
function error(msg, meta) { write('error', msg, meta); }
function debug(msg, meta) { write('debug', msg, meta); }

module.exports = {
  info,
  warn,
  error,
  debug,
  // Expose fileStream for graceful close on shutdown if needed
  _internal: { fileStream }
};
