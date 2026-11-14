// Publishes the source registry with the site so the Methods page can link to it.
import { copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
copyFileSync(resolve(here, '../../SOURCES.md'), resolve(here, '../public/SOURCES.md'));
