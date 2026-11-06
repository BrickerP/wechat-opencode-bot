import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './constants.js';

// run-bot.sh sources this file for the daemon; CLI runs (--simulate, --notify) need the same
// OPENCODE_SERVER_PASSWORD and allowlist. Variables already set in the environment win.
// Imported first by main.ts so provider.ts reads the values at module load.
const ENV_FILE = join(DATA_DIR, 'env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
