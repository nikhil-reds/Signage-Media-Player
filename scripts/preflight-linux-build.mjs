#!/usr/bin/env node
/**
 * AppImage packaging symlinks the app icon. Windows refuses symlink creation
 * unless the shell is elevated or Developer Mode is on, and electron-builder
 * only surfaces that as a cryptic "EPERM: operation not permitted, symlink"
 * after it has already downloaded Electron. Fail fast with the actual fix.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

if (process.platform !== 'win32') process.exit(0);

const probeDir = mkdtempSync(path.join(tmpdir(), 'reds-symlink-probe-'));
let canSymlink = false;

try {
  const target = path.join(probeDir, 'target.txt');
  writeFileSync(target, 'probe');
  symlinkSync(target, path.join(probeDir, 'link.txt'));
  canSymlink = true;
} catch {
  canSymlink = false;
} finally {
  rmSync(probeDir, { recursive: true, force: true });
}

if (canSymlink) process.exit(0);

console.error(
  [
    '',
    'Cannot build a Linux AppImage on Windows without symlink permission.',
    '',
    'AppImage packaging creates a symlink for the app icon, which Windows blocks',
    'for standard users. electron-builder reports this as:',
    '  EPERM: operation not permitted, symlink ...',
    '',
    'Use the containerised build instead (recommended, no admin needed):',
    '',
    '  npm run build:linux:docker',
    '',
    'Or, to build natively, enable one of these and re-run:',
    '  - Windows Developer Mode: Settings > System > For developers > Developer Mode',
    '  - An Administrator terminal',
    '',
  ].join('\n'),
);
process.exit(1);
