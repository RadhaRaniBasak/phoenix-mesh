'use strict';

import k8s from '@kubernetes/client-node';
import pino from 'pino';

const log = pino({ 
  level: process.env.LOG_LEVEL || 'info',
  name: 'phoenix-log-collector'
});

let coreV1;


export function initK8sClient(kubeConfig) {
  coreV1 = kubeConfig.makeApiClient(k8s.CoreV1Api);
}

//fetch recent logs
export async function fetchPodLogs(podName, namespace, options = {}) {
  const {
    container = null,
    tailLines = 100,
    sinceSeconds = 300, // last 5 min
    previous = false,   // get logs from the crashed instance if true
  } = options;

  try {
    const params = {
      tailLines,
      sinceSeconds,
      previous,
      timestamps: true,
    };
    if (container) params.container = container;

    const res = await coreV1.readNamespacedPodLog(
      podName, 
      namespace, 
      ...flattenPhoenixParams(params)
    );
    
    const raw = res.body || '';
    return raw.split('\n').filter(Boolean);
  } catch (err) {
    log.warn({ podName, namespace, err: err.message }, 'Phoenix Mesh: Failed to fetch pod logs');
    return [`[Phoenix Log Fetch Failure: ${err.message}]`];
  }
}

export async function fetchIncidentLogs(podName, namespace, serviceName) {
  const [currentLogs, previousLogs, sidecarLogs] = await Promise.all([
    fetchPodLogs(podName, namespace, { tailLines: 80, sinceSeconds: 300 }),
    fetchPodLogs(podName, namespace, { tailLines: 40, previous: true }).catch(() => []),
    // Target the specific container name for your sidecar
    fetchPodLogs(podName, namespace, { container: 'phoenix-sidecar', tailLines: 40 }).catch(() => []),
  ]);

  return {
    current: currentLogs,
    previous: previousLogs,
    sidecar: sidecarLogs,
    summary: buildPhoenixLogSummary(currentLogs),
  };
}

//extract critical error
function buildPhoenixLogSummary(lines) {
  const errorPatterns = [
    /error/i, /exception/i, /fatal/i, /panic/i, /crash/i,
    /oom/i, /killed/i, /segfault/i, /unhandled/i, /uncaught/i,
    /ECONNREFUSED/i, /ETIMEDOUT/i, /heap.*out.*memory/i,
  ];

  const errorLines = lines.filter(line =>
    errorPatterns.some(p => p.test(line))
  );

  return {
    totalLines: lines.length,
    errorLines: errorLines.slice(-20), // Send the last 20 critical errors to AI
    hasOOM: lines.some(l => /out.*memory|OOMKilled|heap.*exceeded/i.test(l)),
    hasPanic: lines.some(l => /panic|fatal|SIGKILL|SIGSEGV/i.test(l)),
    hasConnRefused: lines.some(l => /ECONNREFUSED/i.test(l)),
    hasTimeout: lines.some(l => /ETIMEDOUT|timeout|timed out/i.test(l)),
    collectedAt: new Date().toISOString(),
  };
}


function flattenPhoenixParams(opts) {
  return [
    opts.container || undefined,
    opts.follow || false,
    undefined, // insecureSkipTLSVerifyBackend
    undefined, // limitBytes
    undefined, // pretty
    opts.previous || false,
    opts.sinceSeconds || undefined,
    undefined, // sinceTime
    opts.tailLines || undefined,
    opts.timestamps || true,
  ];
}
