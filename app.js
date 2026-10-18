import 'dotenv/config';
import app from './src/app.js';
import { initDb } from './src/db.js';
import { validateProductionConfig } from './src/auth.js';

// Hostinger requires the configured entry file to call listen() immediately.
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, () => {
  console.log(`Braam Street Barbers booking app ready on port ${port}`);
});

async function initialize() {
  validateProductionConfig();
  await initDb();
}

initialize().catch(error => {
  console.error('Failed to initialize Braam Street Barbers booking app:', error);
  server.close(() => { process.exitCode = 1; });
});
