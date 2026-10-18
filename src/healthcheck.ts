// SPDX-License-Identifier: Apache-2.0
import { request } from 'node:http';
import { loadConfig } from './config.js';

/** Container health probe: `GET /v1/status` over the socket must answer 200. */
const req = request(
  { socketPath: loadConfig().socketPath, path: '/v1/status', timeout: 4_000 },
  (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  },
);
req.on('timeout', () => req.destroy());
req.on('error', () => process.exit(1));
req.end();
