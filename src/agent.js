'use strict';

const os = require('os');
const { spawnSync } = require('child_process');
const { WebSocket } = require('ws');

const {
  PROTOCOL_VERSION,
  MessageType,
  READ_ONLY_TYPES,
  createMessage,
  parseMessage,
  validateAgentMessage,
} = require('../lib/agent-protocol');
const { getTaskHandler } = require('./tasks');
const { makeCtx } = require('./git/repo');
const { registerSecret } = require('./redact');
const { getLocalVersion } = require('./version');
const { checkForUpdates } = require('./update/updater');

function getGitVersion() {
  try {
    const result = spawnSync('git', ['--version'], { encoding: 'utf-8' });
    return result.status === 0 ? String(result.stdout).trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

class Agent {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.ws = null;
    this.nodeId = null;
    this.nodeName = null;

    this.heartbeatTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    this.reconnectTimer = null;
    this.updateTimer = null;

    this.reconnectAttempts = 0;
    this.currentTask = null;
    this.activeControllers = new Map();
    this.shuttingDown = false;
    this.startedAt = Date.now();
  }

  // --- Verbinding ----------------------------------------------------------

  get wsUrl() {
    return this.config.coordinatorUrl.replace(/^http/, 'ws') + '/agent';
  }

  start() {
    this.connect();
    this.scheduleUpdates();
  }

  connect() {
    if (this.shuttingDown) return;
    const wsUrl = this.wsUrl;
    this.logger.info({ url: wsUrl, protocol: PROTOCOL_VERSION }, 'Verbinden met coordinator');

    try {
      this.ws = new WebSocket(wsUrl, {
        headers: {
          'X-Node-Key': this.config.nodeKey,
          'X-Protocol-Version': PROTOCOL_VERSION,
        },
        handshakeTimeout: 10000,
        perMessageDeflate: false,
      });
    } catch (err) {
      this.logger.error({ err }, 'Kon WebSocket niet aanmaken');
      this.scheduleReconnect();
      return;
    }

    const ws = this.ws;

    ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.logger.info('Verbonden met coordinator');
      this.sendAgentInfo();
      this.startHeartbeat();
      this.startPing();
    });

    ws.on('message', (data) => {
      const msg = parseMessage(data);
      if (!msg) {
        this.logger.warn('Ongeldig bericht ontvangen (geen JSON/protocol)');
        return;
      }
      if (!validateAgentMessage(msg)) {
        this.logger.warn({ type: msg.type, correlationId: msg.correlationId }, 'Bericht met onbekend protocol/type genegeerd');
        return;
      }
      this.handleMessage(msg).catch((err) => {
        this.logger.error({ err }, 'Fout bij verwerken bericht');
      });
    });

    ws.on('pong', () => {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
    });

    ws.on('close', (code, reason) => {
      const reasonText = reason ? reason.toString() : '';
      this.logger.warn({ code, reason: reasonText }, 'Verbinding met coordinator verbroken');
      this.stopHeartbeat();
      this.stopPing();
      this.failActiveTasks('Node disconnected');
      if (code === 4001) {
        this.logger.error('Authenticatie geweigerd door coordinator (ongeldige of ontbrekende node-key). Controleer NODE_KEY.');
      }
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.logger.error({ err: err.message }, 'WebSocket-fout');
    });
  }

  scheduleReconnect() {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) return;

    const max = this.config.reconnectMaxAttempts;
    if (max > 0 && this.reconnectAttempts >= max) {
      this.logger.error({ attempts: this.reconnectAttempts }, 'Maximale herverbindingspogingen bereikt, stoppen');
      process.exit(1);
    }

    const base = this.config.reconnectBaseDelay;
    const delay = base * Math.pow(2, this.reconnectAttempts) + Math.floor(Math.random() * 1000);
    this.reconnectAttempts++;
    const capped = Math.min(delay, 300000);
    this.logger.info(
      { seconds: Math.round(capped / 1000), attempt: this.reconnectAttempts, max: max || 'oneindig' },
      'Opnieuw verbinden'
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, capped);
  }

  sendAgentInfo() {
    const gitVersion = getGitVersion();
    const capabilities = {
      protocolVersion: PROTOCOL_VERSION,
      agentVersion: getLocalVersion(),
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      cwd: process.cwd(),
      nodeVersion: process.version,
      gitVersion,
      features: [
        'sync',
        'clone',
        'create',
        'fetch',
        'pull',
        'push',
        'status',
        'branches',
        'repo_data',
        'commit',
        'diff',
        'switch_branch',
        'resolve_conflict',
        'browse',
        'cancel_task',
        'self_update',
        'structured_logging',
        'secret_redaction',
        'retry',
      ],
    };

    this.send(MessageType.AGENT_INFO, {
      nodeId: null,
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      gitVersion,
      cwd: process.cwd(),
      nodeVersion: process.version,
      agentVersion: getLocalVersion(),
      capabilities,
    });
  }

  // --- Heartbeat / keepalive ----------------------------------------------

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send(MessageType.HEARTBEAT, {
        nodeId: this.nodeId,
        timestamp: Date.now(),
        uptime: Math.round((Date.now() - this.startedAt) / 1000),
      });
    }, this.config.heartbeatInterval);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.pongTimer) {
        this.logger.warn('Coordinator reageert niet op ping; verbinding wordt hersteld');
        try { this.ws.terminate(); } catch { /* ignore */ }
        return;
      }
      this.pongTimer = setTimeout(() => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.logger.warn('Geen pong ontvangen; verbinding wordt hersteld');
        try { this.ws.terminate(); } catch { /* ignore */ }
      }, this.config.heartbeatInterval);
      try { this.ws.ping(); } catch { /* ignore */ }
    }, this.config.heartbeatInterval);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  // --- Berichten -----------------------------------------------------------

  send(type, payload, correlationId = null) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(createMessage(type, payload, correlationId)));
      return true;
    } catch (err) {
      this.logger.warn({ err: err.message }, 'Verzenden mislukt');
      return false;
    }
  }

  async handleMessage(msg) {
    const { type, payload, correlationId } = msg;

    switch (type) {
      case MessageType.AGENT_INFO:
        if (payload && payload.nodeId) {
          this.nodeId = payload.nodeId;
          this.nodeName = payload.name || null;
          this.logger.info({ nodeId: payload.nodeId, name: payload.name }, 'Geregistreerd als node');
        }
        break;

      case MessageType.HEARTBEAT:
        this.send(MessageType.HEARTBEAT_ACK, { nodeId: this.nodeId, timestamp: Date.now() }, correlationId);
        break;

      case MessageType.SYNC_REPO:
      case MessageType.CLONE_REPO:
      case MessageType.CREATE_REPO:
      case MessageType.FETCH_REPO:
      case MessageType.PULL_REPO:
      case MessageType.PUSH_REPO:
      case MessageType.GET_STATUS:
      case MessageType.GET_BRANCHES:
      case MessageType.GET_REPO_DATA:
      case MessageType.GET_COMMIT:
      case MessageType.GET_DIFF:
      case MessageType.BROWSE_DIR:
      case MessageType.SWITCH_BRANCH:
      case MessageType.RESOLVE_CONFLICT:
        await this.handleTask(type, payload || {}, correlationId);
        break;

      case MessageType.CANCEL_TASK: {
        const controller = this.activeControllers.get(correlationId);
        if (controller) {
          this.logger.info({ correlationId }, 'Taak geannuleerd door coordinator');
          controller.abort();
          this.send(MessageType.TASK_FAILED, { error: 'Task cancelled', correlationId }, correlationId);
          this.finishTask(correlationId);
        }
        break;
      }

      case MessageType.SHUTDOWN:
        this.logger.info('Shutdown-commando ontvangen');
        this.shutdown(0);
        break;

      default:
        this.logger.warn({ type }, 'Onbekend berichttype');
    }
  }

  // --- Taakuitvoering ------------------------------------------------------

  async handleTask(type, payload, correlationId) {
    const readOnly = READ_ONLY_TYPES.has(type);

    if (!readOnly && this.currentTask) {
      this.send(
        MessageType.TASK_FAILED,
        { repoId: payload.repoId, error: 'Agent busy with another task', correlationId },
        correlationId
      );
      return;
    }

    const controller = new AbortController();
    this.activeControllers.set(correlationId, controller);
    const task = { type, correlationId, controller, startTime: Date.now() };
    if (!readOnly) this.currentTask = task;

    if (payload.token) registerSecret(payload.token);
    registerSecret(this.config.nodeKey);

    this.send(MessageType.TASK_STARTED, { repoId: payload.repoId, type }, correlationId);
    this.logger.info({ type, repoId: payload.repoId, repoPath: payload.repoPath, correlationId }, 'Taak gestart');

    let timeoutTimer = null;
    if (!readOnly) {
      timeoutTimer = setTimeout(() => {
        if (!this.activeControllers.has(correlationId)) return;
        this.logger.error({ type, correlationId }, 'Taak-timeout');
        controller.abort();
        this.send(
          MessageType.TASK_FAILED,
          { repoId: payload.repoId, error: 'Task timeout', correlationId },
          correlationId
        );
        this.finishTask(correlationId);
      }, this.config.taskTimeout);
      if (timeoutTimer.unref) timeoutTimer.unref();
    }

    try {
      const result = await this.runTask(type, payload, correlationId, controller);
      if (!this.activeControllers.has(correlationId)) return;

      if (controller.signal.aborted) {
        this.send(MessageType.TASK_FAILED, { repoId: payload.repoId, error: 'Task cancelled', correlationId }, correlationId);
      } else if (result.success) {
        this.send(MessageType.TASK_COMPLETED, { repoId: payload.repoId, ...result }, correlationId);
      } else {
        this.send(MessageType.TASK_FAILED, { repoId: payload.repoId, ...result }, correlationId);
      }
    } catch (err) {
      this.logger.error({ err, type, correlationId }, 'Fout bij uitvoeren taak');
      if (this.activeControllers.has(correlationId)) {
        this.send(MessageType.TASK_FAILED, { repoId: payload.repoId, error: err.message, correlationId }, correlationId);
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      this.finishTask(correlationId);
    }
  }

  async runTask(type, payload, correlationId, controller) {
    const handler = getTaskHandler(type);
    if (!handler) return { success: false, error: `Unknown task type: ${type}` };

    const logs = [];
    const emitProgress = (msg, progressType = 'info') => {
      logs.push({ msg, type: progressType, timestamp: Date.now() });
      this.send(MessageType.TASK_PROGRESS, { repoId: payload.repoId, msg, type: progressType, logs }, correlationId);
    };

    const gitCtx = makeCtx({
      token: payload.token,
      timeout: this.config.gitTimeout,
      longTimeout: this.config.gitLongTimeout,
      maxRetries: this.config.gitMaxRetries,
      signal: controller.signal,
    });

    const runtime = {
      config: this.config,
      logger: this.logger,
      gitCtx,
      signal: controller.signal,
      emitProgress,
      onConflict: (files) => {
        this.send(MessageType.CONFLICT_DETECTED, { repoId: payload.repoId, files }, correlationId);
      },
    };

    return handler(payload, runtime);
  }

  finishTask(correlationId) {
    this.activeControllers.delete(correlationId);
    if (this.currentTask && this.currentTask.correlationId === correlationId) {
      this.currentTask = null;
    }
  }

  failActiveTasks(reason) {
    for (const [correlationId] of this.activeControllers) {
      this.send(MessageType.TASK_FAILED, { error: reason, correlationId }, correlationId);
    }
    this.activeControllers.clear();
    this.currentTask = null;
  }

  // --- Auto-update ---------------------------------------------------------

  scheduleUpdates() {
    if (!this.config.updateEnabled) {
      this.logger.info('Auto-update uitgeschakeld');
      return;
    }
    const run = () => {
      checkForUpdates(this.config, this.logger).catch((err) => {
        this.logger.warn({ err: err.message }, 'Update-check mislukt');
      });
    };
    const first = setTimeout(run, 10000);
    if (first.unref) first.unref();
    this.updateTimer = setInterval(run, this.config.updateInterval);
    if (this.updateTimer.unref) this.updateTimer.unref();
  }

  // --- Afsluiten -----------------------------------------------------------

  shutdown(exitCode = 0) {
    if (this.shuttingDown) return;
    this.logger.info('Agent wordt afgesloten');
    this.stop();
    setTimeout(() => process.exit(exitCode), 200).unref();
  }

  /** Sluit netjes af zonder het proces te beeindigen (ook bruikbaar in tests). */
  stop() {
    this.shuttingDown = true;
    this.stopHeartbeat();
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.updateTimer) clearInterval(this.updateTimer);
    this.reconnectTimer = null;
    this.updateTimer = null;
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'Agent shutdown');
    } catch {
      // ignore
    }
  }
}

module.exports = { Agent, getGitVersion };
