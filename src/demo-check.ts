// `npm run demo:check`: prints READY only when the running demo (npm run playground) has answered on every component.
import { intFromEnv } from './config.js';
import { demoHealth } from './demo-env.js';

const port = intFromEnv(process.env, 'PORT', 8080, 1, 65535);
const { ready, checks } = await demoHealth(`http://127.0.0.1:${port}`);
for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
console.log(ready ? '\nREADY' : '\nNOT READY');
process.exit(ready ? 0 : 1);
