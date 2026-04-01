'use strict';

import express from 'express';
import axios from 'axios';
import pino from 'pino';
import { register, Gauge, Counter, Histogram } from 'prom-client';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();
app.use(express.json());

//config
const CONFIG = {
  serviceName:    process.env.SERVICE_NAME    || 'unknown-service',
  serviceUrl:     process.env.SERVICE_URL     || 'http://localhost:3000',
  controllerUrl:  process.env.CONTROLLER_URL  || 'http://mesh-controller:8080',
  podName:        process.env.POD_NAME        || 'unknown-pod',
  podNamespace:   process.env.POD_NAMESPACE   || 'default',
  probeInterval:  parseInt(process.env.PROBE_INTERVAL_MS  || '5000'),
  failThreshold:  parseInt(process.env.FAIL_THRESHOLD     || '3'),
  probeTimeout:   parseInt(process.env.PROBE_TIMEOUT_MS   || '2000'),
  port:           parseInt(process.env.SIDECAR_PORT       || '9090'),
};

//axios for upstream service
const upstreamClient = axios.create({
  baseURL: CONFIG.serviceUrl,
  timeout: CONFIG.probeTimeout,
});


const healthGauge = new Gauge({
  name: 'service_health',
  help: '1 = healthy, 0 = unhealthy',
  labelNames: ['service', 'pod'],
});

const errorCounter = new Counter({
  name: 'service_errors_total',
  help: 'Total error count by type',
  labelNames: ['service', 'pod', 'type'],
});

const latencyHistogram = new Histogram({
  name: 'service_probe_latency_ms',
  help: 'Health probe latency in ms',
  labelNames: ['service', 'pod'],
  buckets: [10, 50, 100, 250, 500, 1000, 2000, 5000],
});

const probeCounter = new Counter({
  name: 'service_probes_total',
  help: 'Total health probes',
  labelNames: ['service', 'pod', 'result'],
});

//state management 
const state = {
  status: 'HEALTHY', // HEALTHY, UNHEALTHY, RECOVERING
  consecutiveFails: 0,
  consecutiveSuccesses: 0,
  lastError: null,
  lastCheck: null,
  reportedToController: false,
  startedAt: Date.now(),
  probeHistory: [],
};

//helper fn
function classifyError(err) {
  if (!err.response) {
    const codeMap = {
      ECONNREFUSED: 'CRASH',
      ETIMEDOUT: 'TIMEOUT',
      ENOTFOUND: 'DNS_FAILURE',
      ECONNRESET: 'CONNECTION_RESET'
    };
    return codeMap[err.code] || 'NETWORK_ERROR';
  }
  const status = err.response.status;
  if (status >= 500) return 'HTTP_5XX';
  if (status === 429) return 'RATE_LIMITED';
  return 'HTTP_4XX';
}

function recordProbe(success, latencyMs, errorType = null) {
  state.probeHistory.push({ ts: Date.now(), success, latencyMs, errorType });
  if (state.probeHistory.length > 20) state.probeHistory.shift();
}

//core health logic
async function probeHealth() {
  const start = Date.now();
  const labels = { service: CONFIG.serviceName, pod: CONFIG.podName };

  try {
    const res = await upstreamClient.get('/health');
    const latencyMs = Date.now() - start;

    latencyHistogram.observe(labels, latencyMs);
    
    //payload validation
    const isOk = res.status === 200 && (!res.data?.status || ['ok', 'healthy'].includes(res.data.status));
    if (!isOk) throw new Error(`Health Check Payload Mismatch: ${res.data?.status}`);

    //Success logic
    healthGauge.set(labels, 1);
    probeCounter.inc({ ...labels, result: 'success' });
    recordProbe(true, latencyMs);

    state.consecutiveFails = 0;
    state.consecutiveSuccesses++;
    state.lastCheck = Date.now();
    state.lastError = null;

    if (state.status !== 'HEALTHY' && state.consecutiveSuccesses >= 2) {
      log.info({ service: CONFIG.serviceName }, 'Service status transitioned to HEALTHY');
      state.status = 'HEALTHY';
      state.reportedToController = false;
      await reportEvent('RECOVERY');
    }

  } catch (err) {
    const latencyMs = Date.now() - start;
    const errorType = classifyError(err);

    healthGauge.set(labels, 0);
    errorCounter.inc({ ...labels, type: errorType });
    probeCounter.inc({ ...labels, result: 'failure' });
    recordProbe(false, latencyMs, errorType);

    state.consecutiveFails++;
    state.consecutiveSuccesses = 0;
    state.status = 'UNHEALTHY';
    state.lastCheck = Date.now();
    state.lastError = { message: err.message, type: errorType, ts: Date.now() };

    log.warn({ service: CONFIG.serviceName, type: errorType }, 'Health probe failed');

    if (state.consecutiveFails >= CONFIG.failThreshold && !state.reportedToController) {
      state.reportedToController = true;
      await reportEvent('FAILURE');
    }
  }
}

//controller comm.
async function reportEvent(type) {
  const endpoint = type === 'FAILURE' ? '/api/failure' : '/api/recovery';
  const payload = {
    event: type,
    service: CONFIG.serviceName,
    podName: CONFIG.podName,
    namespace: CONFIG.podNamespace,
    timestamp: new Date().toISOString(),
    ...(type === 'FAILURE' ? { lastError: state.lastError, history: state.probeHistory } : {})
  };

  try {
    await axios.post(`${CONFIG.controllerUrl}${endpoint}`, payload, { timeout: 5000 });
    log.info(`Event ${type} reported to controller`);
  } catch (err) {
    log.error({ err: err.message }, 'Mesh Controller unreachable');
  }
}

//API
app.get('/status', (req, res) => {
  res.json({ ...state, uptime: Date.now() - state.startedAt });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});

//impr. proxy logic
app.all('/proxy/*', async (req, res) => {
  if (state.status === 'UNHEALTHY') {
    return res.status(503).json({ error: 'Circuit Open', service: CONFIG.serviceName });
  }

  const targetPath = req.path.replace('/proxy', '');
  
  try {
    const response = await upstreamClient({
      method: req.method,
      url: targetPath,
      data: req.body,
      headers: { 
        ...req.headers, 
        host: new URL(CONFIG.serviceUrl).host // Ensure host matches target
      },
    });
    res.status(response.status).send(response.data);
  } catch (err) {
    const errorType = classifyError(err);
    res.status(err.response?.status || 502).json({ error: 'Upstream Error', type: errorType });
  }
});


const server = app.listen(CONFIG.port, () => {
  log.info({ port: CONFIG.port }, 'Sidecar agent initialized');
});

let probeTimer = setInterval(probeHealth, CONFIG.probeInterval);

function gracefulShutdown() {
  clearInterval(probeTimer);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
