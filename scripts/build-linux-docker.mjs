#!/usr/bin/env node
/**
 * Builds the Linux AppImage inside the official electron-builder container.
 *
 * AppImage packaging creates symlinks, which Windows refuses unless the shell
 * is elevated or Developer Mode is on (EPERM: operation not permitted,
 * symlink ...). Building in Linux avoids the problem entirely and produces the
 * same artifacts native CI would.
 *
 *   npm run build:linux:docker
 *
 * Output lands in output/linux/ on the host, exactly as npm run build:linux.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const IMAGE = process.env.ELECTRON_BUILDER_IMAGE || 'electronuserland/builder:latest';
const projectDir = process.cwd();

if (!existsSync(path.join(projectDir, 'package.json'))) {
  console.error('Run this from the player project root.');
  process.exit(1);
}

const docker = spawnSync('docker', ['--version'], { stdio: 'ignore' });
if (docker.status !== 0) {
  console.error(
    'Docker is not available.\n\n' +
      'Alternatives:\n' +
      '  - Build inside WSL:  wsl bash -lc "cd \\"$(wslpath \'' + projectDir + '\')\\" && npm ci && npm run build:linux"\n' +
      '  - Enable Windows Developer Mode, then run npm run build:linux natively.',
  );
  process.exit(1);
}

// AppImage assembly (squashfs + runtime concatenation) fails on the Windows
// bind mount, so build into the container's own filesystem and copy only the
// finished artifacts back to the host.
const build = [
  'npm install --no-audit --no-fund',
  'npx electron-builder --linux AppImage --x64 --arm64 --config.directories.output=/tmp/reds-build',
  'mkdir -p /project/output/linux',
  'cp -f /tmp/reds-build/*.AppImage /project/output/linux/',
  'ls -la /project/output/linux/',
].join(' && ');

// node_modules is a named volume so the container installs Linux-native
// binaries without clobbering the host's Windows install.
const args = [
  'run', '--rm',
  '-v', `${projectDir}:/project`,
  '-v', 'reds-player-node-modules:/project/node_modules',
  '-v', 'reds-player-electron-cache:/root/.cache/electron',
  '-v', 'reds-player-builder-cache:/root/.cache/electron-builder',
  '-w', '/project',
  IMAGE,
  '/bin/bash', '-c',
  build,
];

console.log(`Building Linux AppImages in ${IMAGE} ...`);
const result = spawnSync('docker', args, { stdio: 'inherit' });

if (result.status !== 0) {
  console.error('\nLinux build failed inside Docker.');
  process.exit(result.status ?? 1);
}

console.log('\nDone. Artifacts are in output/linux/ on the host.');
