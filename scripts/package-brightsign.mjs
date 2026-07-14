import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const outputDirectory = path.join(projectRoot, 'output', 'brightsign');
const sdCardDirectory = path.join(outputDirectory, 'sd-card');

const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const archivePath = path.join(outputDirectory, `SignLink-BrightSign-${packageJson.version}.zip`);
const requiredEntries = [
  'autorun.brs',
  'index.html',
  'app.js',
  'styles.css',
  'config.json',
  'manifest.json',
  'assets',
  'media'
];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(sdCardDirectory, { recursive: true });

for (const entry of requiredEntries) {
  await cp(path.join(projectRoot, entry), path.join(sdCardDirectory, entry), {
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
  archive.directory(sdCardDirectory, false);
  archive.finalize();
});

console.log(`BrightSign SD-card folder: ${sdCardDirectory}`);
console.log(`BrightSign ZIP package: ${archivePath}`);
