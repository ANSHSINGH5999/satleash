// `npm run demo:reset`: stops and removes the regtest containers and volumes and deletes <repo>/data, and nothing else.
import { dockerReachable, resetDemo } from './demo-env.js';
import { compose, ROOT } from './regtest.js';

resetDemo({ root: ROOT, dockerUp: dockerReachable, composeDown: () => void compose('down', '-v'), log: console.log });
