import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
const state = process.env.OPENSENSOR_DASHBOARD_STATE || path.join(os.homedir(), '.local/state/nono-kilo-dashboard');
try {
  const { key } = JSON.parse(readFileSync(path.join(state, 'browser-access.json'), 'utf8'));
  console.log('Open this private link in your browser. Keep it private; it grants dashboard access.');
  console.log(`http://127.0.0.1:${process.env.OPENSENSOR_PORT || 4317}/#access=${key}`);
} catch { console.error('Start the dashboard first with npm start, or systemctl --user start nono-kilo-dashboard if installed as a service.'); process.exitCode = 1; }
