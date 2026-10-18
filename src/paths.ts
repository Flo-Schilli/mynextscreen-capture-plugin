// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from 'node:url';

/** Package root: `/app` in the image, the repository root in a checkout. */
export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
