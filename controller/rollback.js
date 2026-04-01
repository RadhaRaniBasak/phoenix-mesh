'use strict';

import k8s from '@kubernetes/client-node';
import pino from 'pino';

const log = pino({ 
  level: process.env.LOG_LEVEL || 'info',
  name: 'phoenix-rollback-engine'
});

let appsV1;
let coreV1;


export function initK8sClients(kubeConfig) {
  appsV1 = kubeConfig.makeApiClient(k8s.AppsV1Api);
  coreV1 = kubeConfig.makeApiClient(k8s.CoreV1Api);
}

const PATCH_HEADER = { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } };

//traffic isolation

export async function rerouteTraffic(service, namespace, unhealthyPodName) {
  log.info({ service, unhealthyPodName }, 'Phoenix Mesh: Attempting traffic isolation');

  try {
    const podList = await coreV1.listNamespacedPod(
      namespace, undefined, undefined, undefined, undefined, `app=${service}`
    );
    const allPods = podList.body.items;

    const healthyPods = allPods.filter(p =>
      p.metadata.name !== unhealthyPodName &&
      p.status.phase === 'Running' &&
      p.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True')
    );

    if (healthyPods.length === 0) {
      log.warn({ service }, 'Phoenix Mesh: No healthy pods available — aborting isolation to prevent total outage');
      return { rerouted: false, reason: 'no_healthy_pods', healthyCount: 0 };
    }

    await coreV1.patchNamespacedPod(
      unhealthyPodName, namespace,
      { metadata: { labels: { 'phoenix.io/status': 'degraded' } } },
      undefined, undefined, undefined, undefined, PATCH_HEADER
    );
    await coreV1.patchNamespacedService(
      service, namespace,
      { spec: { selector: { app: service, 'phoenix.io/status': 'healthy' } } },
      undefined, undefined, undefined, undefined, PATCH_HEADER
    );

    log.info({ service, healthyCount: healthyPods.length }, 'Phoenix Mesh: Traffic isolated successfully');
    return { rerouted: true, healthyPods: healthyPods.length };
  } catch (err) {
    log.error({ err: err.message }, 'Phoenix Mesh: Isolation logic failed');
    throw err;
  }
}


export async function restoreTrafficRouting(service, namespace) {
  try {
    await coreV1.patchNamespacedService(
      service, namespace,
      { spec: { selector: { app: service } } },
      undefined, undefined, undefined, undefined, PATCH_HEADER
    );
    log.info({ service }, 'Phoenix Mesh: Normal routing restored');
  } catch (err) {
    log.error({ err: err.message }, 'Phoenix Mesh: Restoration of routing failed');
    throw err;
  }
}

//automated rollback

export async function rollbackDeployment(name, namespace, targetRevision = null) {
  log.info({ name, namespace }, 'Phoenix Mesh: Initiating automated rollback');

  const rsList = await appsV1.listNamespacedReplicaSet(
    namespace, undefined, undefined, undefined, undefined, `app=${name}`
  );

  const ownedRS = rsList.body.items
    .filter(rs => rs.metadata.ownerReferences?.some(
      ref => ref.kind === 'Deployment' && ref.name === name
    ))
    .sort((a, b) => {
      const revA = parseInt(a.metadata.annotations?.['deployment.kubernetes.io/revision'] || '0');
      const revB = parseInt(b.metadata.annotations?.['deployment.kubernetes.io/revision'] || '0');
      return revB - revA; // Descending order
    });

  if (ownedRS.length < 2) {
    throw new Error(`Phoenix Mesh: Insufficient history for rollback (found ${ownedRS.length} revisions)`);
  }

  // Choose target: specific revision or the immediate previous one (index 1)
  const targetRS = targetRevision
    ? ownedRS.find(rs =>
        rs.metadata.annotations?.['deployment.kubernetes.io/revision'] === String(targetRevision)
      )
    : ownedRS[1];

  if (!targetRS) {
    throw new Error(`Phoenix Mesh: Target revision ${targetRevision} not found in cluster history`);
  }

  const targetImage = targetRS.spec.template.spec.containers[0]?.image;
  const targetRev = targetRS.metadata.annotations?.['deployment.kubernetes.io/revision'];

  // Applying  the rollback
  const patch = {
    metadata: {
      annotations: {
        'phoenix.io/auto-rollback': 'true',
        'deployment.kubernetes.io/change-cause': `Phoenix Mesh: Automated recovery at ${new Date().toISOString()}`,
      },
    },
    spec: {
      template: {
        metadata: targetRS.spec.template.metadata,
        spec: targetRS.spec.template.spec,
      },
    },
  };

  await appsV1.patchNamespacedDeployment(
    name, namespace, patch,
    undefined, undefined, undefined, undefined, PATCH_HEADER
  );

  log.info({ name, targetRev, targetImage }, 'Phoenix Mesh: Rollback patch applied to deployment');
  return { rolledBackTo: targetRev, image: targetImage };
}

//verification

export async function watchRolloutStatus(name, namespace, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  log.info({ name }, 'Phoenix Mesh: Verifying rollout health...');

  while (Date.now() < deadline) {
    const deploy = await appsV1.readNamespacedDeployment(name, namespace);
    const { spec, status } = deploy.body;
    const desired = spec.replicas || 1;

    if (
      status.updatedReplicas   === desired &&
      status.readyReplicas     === desired &&
      status.availableReplicas === desired
    ) {
      log.info({ name, replicas: desired }, 'Phoenix Mesh: Rollout verification successful');
      return { success: true, replicas: desired };
    }

    await sleep(5000);
  }

  log.error({ name }, 'Phoenix Mesh: Rollout verification timed out');
  return { success: false, reason: 'timeout' };
}

export async function getDeploymentInfo(name, namespace) {
  const deploy = await appsV1.readNamespacedDeployment(name, namespace);
  const { metadata, spec, status } = deploy.body;
  return {
    name: metadata.name,
    namespace: metadata.namespace,
    currentRevision: metadata.annotations?.['deployment.kubernetes.io/revision'],
    currentImage: spec.template.spec.containers[0]?.image,
    readyReplicas: status.readyReplicas,
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
