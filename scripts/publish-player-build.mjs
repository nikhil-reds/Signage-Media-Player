#!/usr/bin/env node
/**
 * Uploads electron-builder output to the S3 prefix the CMS downloads from.
 *
 *   npm run build:windows && npm run build:linux
 *   PLAYER_BUILD_VERSION=1.0.1 npm run publish:player-build
 *
 * The CMS resolves artifacts at player-builds/{version}/{windows|linux}/{file},
 * which must stay in sync with lib/player-builds.ts in the CMS repo.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const version = process.env.PLAYER_BUILD_VERSION || '1.0.0';
const bucket = process.env.AWS_BUCKET;
const region = process.env.AWS_REGION;

// electron-builder expands ${arch} to the GNU triplet for AppImage, so the x64
// build lands as x86_64. These names must match artifactFilename() in the CMS
// (lib/player-builds.ts).
const ARTIFACTS = [
  { subdir: 'windows', file: 'reds-player.exe', contentType: 'application/vnd.microsoft.portable-executable' },
  { subdir: 'linux', file: 'reds-player-x86_64.AppImage', contentType: 'application/x-executable' },
  { subdir: 'linux', file: 'reds-player-arm64.AppImage', contentType: 'application/x-executable' }
];

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing ${name}. Set it before publishing a player build.`);
    process.exit(1);
  }
}

requireEnv('AWS_BUCKET', bucket);
requireEnv('AWS_REGION', region);
requireEnv('AWS_ACCESS_KEY_ID', process.env.AWS_ACCESS_KEY_ID);
requireEnv('AWS_SECRET_ACCESS_KEY', process.env.AWS_SECRET_ACCESS_KEY);

const s3 = new S3Client({
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const outputRoot = process.env.PLAYER_OUTPUT_DIR || path.join(process.cwd(), 'output');
let published = 0;
let skipped = 0;

for (const artifact of ARTIFACTS) {
  const localPath = path.join(outputRoot, artifact.subdir, artifact.file);
  const stats = await stat(localPath).catch(() => null);

  if (!stats?.isFile()) {
    console.warn(`skip  ${artifact.subdir}/${artifact.file} (not built)`);
    skipped += 1;
    continue;
  }

  const key = `player-builds/${version}/${artifact.subdir}/${artifact.file}`;
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: key,
      Body: createReadStream(localPath),
      ContentType: artifact.contentType
    }
  });

  const sizeMb = (stats.size / 1024 / 1024).toFixed(1);
  process.stdout.write(`upload ${key} (${sizeMb} MB) ... `);
  await upload.done();
  console.log('done');
  published += 1;
}

if (published === 0) {
  console.error('\nNothing published. Run "npm run build:windows" / "npm run build:linux" first.');
  process.exit(1);
}

console.log(`\nPublished ${published} artifact(s) as version ${version}. ${skipped} skipped.`);
console.log(`Set PLAYER_BUILD_VERSION=${version} in the CMS to serve this release.`);
