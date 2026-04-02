'use strict';

import express from 'express';
import pino from 'pino';

const SERVICE_NAME = process.env.SERVICE_NAME || 'phoenix-payment-service';
const PORT = parseInt(process.env.PORT || '3000');

const log = pino({ 
  level: process.env.LOG_LEVEL || 'info',
  name: `phoenix-${SERVICE_NAME}`
});

const app = express();
app.use(express.json());
let forceUnhealthy = process.env.FORCE_UNHEALTHY === 'true';

app.get('/health', (req, res) => {
  if (forceUnhealthy) {
    log.error('Phoenix Mesh: Payment health probe failed');
    return res.status(500).json({ status: 'error', service: SERVICE_NAME });
  }
  
  res.json({ 
    status: 'ok', 
    service: SERVICE_NAME, 
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});


app.post('/payments', (req, res) => {
  if (forceUnhealthy) {
    return res.status(503).json({ error: 'Phoenix Mesh: Service unavailable' });
  }

  const payment = { 
    id: `pay-${Date.now()}`, 
    status: 'processed', 
    processedBy: SERVICE_NAME,
    ...req.body 
  };

  log.info({ paymentId: payment.id }, 'Phoenix Mesh: Payment processed');
  res.status(201).json(payment);
});

if (process.env.NODE_ENV !== 'production') {
  app.post('/dev/toggle-health', (req, res) => {
    forceUnhealthy = !forceUnhealthy;
    log.warn({ forceUnhealthy }, 'Phoenix Mesh: Payment service health state toggled');
    res.json({ 
      currentStatus: forceUnhealthy ? 'DEGRADED' : 'HEALTHY' 
    });
  });
}

app.listen(PORT, () => {
  log.info({ port: PORT, service: SERVICE_NAME }, 'Phoenix Mesh: Payment Service started');
});
