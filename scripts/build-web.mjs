// Copies the static web app into www/ for Capacitor (Android) and GitHub Pages.
// The app itself has no build step: this only picks which files ship.
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'www');
const SHIP = ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'lib', 'icons'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of SHIP) cpSync(path.join(root, f), path.join(out, f), { recursive: true });
console.log(`Copied ${SHIP.length} entries to www/`);
