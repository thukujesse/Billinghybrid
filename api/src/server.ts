import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`JTM billing API listening on http://localhost:${config.port}`);
  console.log(`  M-Pesa: ${config.mpesa.simulated ? 'SIMULATION' : 'live'} · Stripe: ${config.stripe.simulated ? 'SIMULATION' : 'live'}`);
});

async function shutdown() {
  console.log('\nShutting down...');
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
