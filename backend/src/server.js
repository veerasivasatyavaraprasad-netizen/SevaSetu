import { config, validateConfig } from './config.js';
import { createApp } from './app.js';
import { migrate } from './lib/migrate.js';
import { bootstrapAdmins } from './services/bootstrap.js';
import { startScheduler } from './services/jobs.js';

validateConfig();
await migrate();
await bootstrapAdmins();

const server = createApp().listen(config.port, () => {
  console.log(`API listening on :${config.port} (${config.nodeEnv}, payments=${config.payments.provider}, sms=${config.sms.provider})`);
});
if (config.jobs.enabled) startScheduler();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
