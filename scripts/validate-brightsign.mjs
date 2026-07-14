import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, ParseMode } from 'brighterscript';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const failures = [];

async function requireFile(relativePath, minimumBytes = 1) {
  const absolutePath = path.join(projectRoot, relativePath);

  try {
    await access(absolutePath);
    const fileStats = await stat(absolutePath);
    if (!fileStats.isFile()) failures.push(`${relativePath} is not a file`);
    if (fileStats.size < minimumBytes) failures.push(`${relativePath} is unexpectedly small`);
  } catch {
    failures.push(`${relativePath} is missing`);
  }
}

await requireFile('autorun.brs');
await requireFile('media/videos/default-video.mp4', 1024);

for (const relativePath of ['index.html', 'app.js', 'styles.css', 'manifest.json', 'config.json']) {
  await requireFile(relativePath);
}

let config;
try {
  config = JSON.parse(await readFile(path.join(projectRoot, 'config.json'), 'utf8'));
} catch (error) {
  failures.push(`config.json is invalid JSON: ${error.message}`);
}

if (config) {
  const defaultItem = Array.isArray(config.playlist)
    ? config.playlist.find((item) => item.type === 'video' && item.default === true)
    : undefined;

  if (!defaultItem) {
    failures.push('config.json does not contain a default video item');
  } else if (defaultItem.src !== 'media/videos/default-video.mp4') {
    failures.push('config.json default video path does not match the BrightSign launcher');
  }
}

try {
  const videoHeader = await readFile(path.join(projectRoot, 'media/videos/default-video.mp4'));
  if (videoHeader.subarray(4, 8).toString('ascii') !== 'ftyp') {
    failures.push('default-video.mp4 does not have a valid MP4 file-type header');
  }
  if (!videoHeader.includes(Buffer.from('avc1')) && !videoHeader.includes(Buffer.from('avc3'))) {
    failures.push('default-video.mp4 is not identified as H.264/AVC video');
  }
} catch {
  // The missing file is already reported above.
}

try {
  const autorun = await readFile(path.join(projectRoot, 'autorun.brs'), 'utf8');
  if (autorun.charCodeAt(0) === 0xfeff) failures.push('autorun.brs contains a UTF-8 BOM');
  if (!autorun.includes('SD:/media/videos/default-video.mp4')) {
    failures.push('autorun.brs does not reference the packaged default video');
  }
  if (autorun.includes('security_rules')) {
    failures.push('autorun.brs contains the unsupported security_rules widget property');
  }
  if (/https?:\/\/|roUrlTransfer|roNetworkConfiguration/i.test(autorun)) {
    failures.push('autorun.brs contains a network dependency; default playback must remain offline');
  }

  const parser = Parser.parse(autorun, { mode: ParseMode.BrightScript });
  for (const diagnostic of parser.diagnostics) {
    failures.push(`autorun.brs syntax: ${diagnostic.message}`);
  }
} catch {
  // The missing file is already reported above.
}

if (failures.length > 0) {
  console.error('BrightSign validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('BrightSign source and BrightScript syntax validation passed.');
