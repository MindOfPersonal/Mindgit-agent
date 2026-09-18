'use strict';

const pino = require('pino');
const { redact } = require('./redact');

const REDACT_PATHS = [
  'token',
  '*.token',
  'payload.token',
  'authorization',
  '*.authorization',
  'nodeKey',
  '*.nodeKey',
  'node_key',
  '*.node_key',
];

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

function prettyAvailable() {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

function wrap(base) {
  const logger = {};
  for (const level of LEVELS) {
    logger[level] = (arg1, arg2, ...rest) => {
      if (typeof arg1 === 'string') {
        if (arg2 === undefined) base[level](arg1);
        else base[level](redact(arg2), arg1, ...rest);
      } else {
        base[level](redact(arg1), arg2, ...rest);
      }
    };
  }
  logger.child = (bindings) => wrap(base.child(redact(bindings) || {}));
  logger.raw = base;
  return logger;
}

/**
 * Maakt de logger. Redigeert automatisch tokens/keys en schrijft optioneel
 * naar een bestand én de console.
 * @param {object} config - gevalideerde agent-config
 */
function createLogger(config) {
  const usePretty =
    (config.logPretty === null || config.logPretty === undefined
      ? Boolean(process.stdout.isTTY)
      : config.logPretty) && prettyAvailable();

  const options = {
    level: config.logLevel,
    base: { name: 'mindgit-agent' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };

  let stream;
  if (config.logFile) {
    const streams = [
      { level: config.logLevel, stream: pino.destination({ dest: config.logFile, mkdir: true, sync: false }) },
    ];
    if (usePretty) {
      streams.push({
        level: config.logLevel,
        stream: require('pino-pretty')({
          colorize: Boolean(process.stdout.isTTY),
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname,name',
        }),
      });
    } else {
      streams.push({ level: config.logLevel, stream: process.stdout });
    }
    stream = pino.multistream(streams);
  } else if (usePretty) {
    stream = require('pino-pretty')({
      colorize: Boolean(process.stdout.isTTY),
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname,name',
    });
  } else {
    stream = process.stdout;
  }

  return wrap(pino(options, stream));
}

/** Stille logger (voor tests / CLI die zelf output doet). */
function createSilentLogger() {
  return createLogger({ logLevel: 'silent', logPretty: false, logFile: '' });
}

module.exports = { createLogger, createSilentLogger, LEVELS };
