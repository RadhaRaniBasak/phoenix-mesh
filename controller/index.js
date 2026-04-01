'use strict';

import express from 'express';
import pino from 'pino';
import pinoHttp from 'pino-http';
import k8s from '@kubernetes/client-node';

//internal modules
import { handleFailure, handleRecovery, getActiveIncidents } from './meshController.js';
import { initK8sClients } from './rollback.js';
import { initK8sClient as initLogClient } from './logs.js';

const log = pino({ 
  level: process.env.LOG_LEVEL || 'info',
  name: 'phoenix-controller' 
});

const app = express();
const PORT = parseInt(process.env.PORT || '8080');

// Midware
app.use(express.json({ limit: '1mb' }));
app.use(pinoHttp({ 
  logger: log,
  genReqId: (req) => req.headers['x-request-id'] || Math.random().toString(36).substring(7)
}));

//K8s Infra.
let k8sReady = false;

function initPhoenixK8s() {
  try {
    const kc = new k8s.KubeConfig();

    if (process.env.KUBECONFIG) {
      kc.loadFromFile(process.env.KUBECONFIG);
      log.info('Loading KubeConfig from local file');
    } else if (process.env.K8S_IN_CLUSTER === 'true') {
      kc.loadFromCluster();
      log.info('Running inside Kubernetes cluster');
    } else {
      kc.loadFromDefault(); // local dev — uses ~/.kube/config
      log.info('Using default local KubeConfig context');
    }

    // Initialize downstream services
    initK8sClients(kc);
    initLogClient(kc);
    
    k8sReady = true;
    log.info('Phoenix Mesh: Kubernetes clients successfully initialized');
  } catch (err) {
    log.warn(
      { err: err.message }, 
      'Phoenix Mesh: Kubernetes initialization failed. Running in MOCK mode (No rollbacks available).'
    );
    k8sReady = false;
  }
}

initPhoenixK8s();

//Incident R


app.post('/api/failure', async (req, res) => {
  const report = req.body;

  if (!report?.service || !report?.podName || !report?.namespace) {
    log.error({ payload: report }, 'Invalid failure report received');
    return res.status(400).json({
      error: 'Missing required identity fields: service, podName, namespace',
    });
  }
  res.status(202).json({ 
    status: 'acknowledged', 
    incidentId: `${report.namespace}/${report.service}`,
    ts: new Date().toISOString()
  });


  handleFailure(report).catch(err => {
    log.error({ err: err.message, service: report.service }, 'Phoenix Mesh: Critical failure in incident handler');
  });
});

app.post('/api/recovery', (req, res) => {
  const report = req.body;
  
  if (!report?.service || !report?.namespace) {
    return res.status(400).json({ error: 'Missing required recovery fields: service, namespace' });
  }

  handleRecovery(report);
  
  log.info({ service: report.service }, 'Phoenix Mesh: Service recovery acknowledged');
  res.json({ status: 'recovered', service: report.service });
});

//observability R

app.get('/api/incidents', (req, res) => {
  res.json({ 
    system: 'phoenix-mesh',
    active_count: getActiveIncidents().length,
    incidents: getActiveIncidents() 
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mesh: 'phoenix',
    k8sReady,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

//devlp & test tools

if (process.env.NODE_ENV !== 'production') {
  app.post('/api/test/failure', async (req, res) => {
    const mockReport = {
      event: 'FAILURE',
      service: req.body.service || 'phoenix-test-service',
      podName: req.body.podName || 'phoenix-test-pod-x1y2',
      namespace: req.body.namespace || 'default',
      errorType: req.body.errorType || 'CRASH',
      consecutiveFails: 3,
      lastError: { 
        message: 'Mock Error: Connection refused', 
        type: 'CRASH', 
        ts: Date.now() 
      },
      reportedAt: new Date().toISOString(),
    };

    log.info('Phoenix Mesh: Triggering manual test incident');
    res.status(202).json({ status: 'test_triggered', report: mockReport });

    handleFailure(mockReport).catch(err => {
      log.error({ err: err.message }, 'Phoenix Mesh: Test incident handler failed');
    });
  });
}

//lifecycle management

const server = app.listen(PORT, () => {
  log.info({ port: PORT, k8sReady }, 'Phoenix Mesh Controller operational');
});

function gracefulShutdown(signal) {
  log.info({ signal }, 'Phoenix Mesh Controller: Initiating graceful shutdown');
  
  server.close(() => {
    log.info('Phoenix Mesh Controller: All network connections closed');
    process.exit(0);
  });

//force exit
  setTimeout(() => {
    log.fatal('Phoenix Mesh Controller: Shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.fatal({ reason }, 'Phoenix Mesh Controller: Unhandled promise rejection detected');
});
