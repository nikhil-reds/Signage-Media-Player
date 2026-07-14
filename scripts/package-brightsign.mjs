import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';
import './validate-brightsign.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const outputRoot = path.join(projectRoot, 'output');
const sdCardDirectory = path.join(outputRoot, 'brightsign');

const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const archivePath = path.join(sdCardDirectory, `SignLink-BrightSign-${packageJson.version}.zip`);
const legacyArchivePath = path.join(outputRoot, `SignLink-BrightSign-${packageJson.version}.zip`);
const requiredEntries = [
  'autorun.brs',
  'media/videos/default-video.mp4'
];

await rm(sdCardDirectory, { recursive: true, force: true });
await rm(legacyArchivePath, { force: true });
await rm(archivePath, { force: true });
await mkdir(sdCardDirectory, { recursive: true });

for (const entry of requiredEntries) {
  const destination = path.join(sdCardDirectory, entry);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(projectRoot, entry), destination, {
    recursive: true,
    force: true
  });
}

await new Promise((resolve, reject) => {
  const output = createWriteStream(archivePath);
  const archive = new ZipArchive({ zlib: { level: 9 } });

  output.on('close', resolve);
  output.on('error', reject);
  archive.on('error', reject);
  archive.pipe(output);

  for (const entry of requiredEntries) {
    archive.file(path.join(sdCardDirectory, entry), {
      name: entry.split(path.sep).join('/')
    });
  }

  archive.finalize();
});

console.log(`BrightSign SD-card contents: ${sdCardDirectory}`);
console.log(`BrightSign ZIP package: ${archivePath}`);
