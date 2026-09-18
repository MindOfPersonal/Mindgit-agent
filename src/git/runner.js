'use strict';

const { spawn } = require('child_process');
const { redactString } = require('../redact');

const TRANSIENT_PATTERNS = [
  /could not resolve host/i,
  /connection timed out/i,
  /temporary failure in name resolution/i,
  /unable to access/i,
  /the remote end hung up/i,
  /rpc failed/i,
  /early eof/i,
  /index\.lock/i,
  /resource temporarily unavailable/i,
  /operation timed out/i,
  /network is unreachable/i,
  /connection reset by peer/i,
];

function isTransientError(stderr) {
  const s = String(stderr || '');
  return TRANSIENT_PATTERNS.some((re) => re.test(s));
}

/** Splitst een commando-string in argumenten, met ondersteuning voor quotes. */
function tokenize(cmd) {
  const args = [];
  let i = 0;
  const len = cmd.length;
  while (i < len) {
    while (i < len && /\s/.test(cmd[i])) i++;
    if (i >= len) break;
    let token = '';
    let quote = null;
    while (i < len) {
      const ch = cmd[i];
      if (quote) {
        if (ch === quote) {
          quote = null;
          i++;
          continue;
        }
        token += ch;
        i++;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        i++;
      } else if (/\s/.test(ch)) {
        break;
      } else {
        token += ch;
        i++;
      }
    }
    args.push(token);
  }
  return args;
}

/** Git-authenticatie via http.extraHeader; het token komt nooit in de remote-URL. */
function buildAuthArgs(token) {
  if (!token) return [];
  const auth = Buffer.from(`${token}:x-oauth-basic`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${auth}`];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runOnce(args, opts) {
  return new Promise((resolve) => {
    const timeout = opts.timeout || 15000;
    const controller = new AbortController();
    const external = opts.signal;
    let settled = false;
    let timedOut = false;

    const onExternalAbort = () => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    };

    if (external) {
      if (external.aborted) {
        resolve({ success: false, stdout: '', stderr: 'Aborted', code: -1, aborted: true, timedOut: false });
        return;
      }
      external.addEventListener('abort', onExternalAbort, { once: true });
    }

    let proc;
    try {
      proc = spawn('git', args, {
        cwd: opts.cwd,
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      if (external) external.removeEventListener('abort', onExternalAbort);
      resolve({ success: false, stdout: '', stderr: redactString(err.message), code: -1, aborted: false, timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeout);

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onExternalAbort);
      resolve({
        success: code === 0,
        stdout: stdout.trim(),
        stderr: redactString(stderr.trim()),
        code,
        timedOut,
        aborted: Boolean(external && external.aborted) && !timedOut,
      });
    };

    proc.on('close', finish);
    proc.on('error', (err) => {
      stderr += err.message;
      finish(-1);
    });
  });
}

/**
 * Voert een git-commando uit, met optionele retry voor tijdelijke fouten.
 * @param {string[]|string} args
 * @param {{cwd?:string, timeout?:number, token?:string, signal?:AbortSignal, maxRetries?:number}} [opts]
 */
async function runGit(args, opts = {}) {
  const base = Array.isArray(args) ? args.slice() : tokenize(String(args));
  const full = opts.token ? [...buildAuthArgs(opts.token), ...base] : base;
  const maxRetries = opts.maxRetries || 0;
  let result;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    result = await runOnce(full, opts);
    if (result.success || result.aborted || result.timedOut) return result;
    if (!isTransientError(result.stderr)) return result;
    if (attempt < maxRetries) await delay(500 * (attempt + 1));
  }
  return result;
}

module.exports = {
  runGit,
  buildAuthArgs,
  tokenize,
  isTransientError,
  delay,
};
