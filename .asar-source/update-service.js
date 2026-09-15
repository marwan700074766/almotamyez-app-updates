const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');

const UPDATE_FORMAT = 'sarafa-desktop-update';
const MAX_UPDATE_BYTES = 2.5 * 1024 * 1024 * 1024;

function parseVersion(value) {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw new Error('رقم الإصدار يجب أن يكون بصيغة 3.15.0');
  return { raw: match[0], major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] || '' };
}

function compareVersions(left, right) {
  const a = parseVersion(left); const b = parseVersion(right);
  for (const key of ['major', 'minor', 'patch']) { if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1; }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, 'en');
}

function isHttpsUrl(value) {
  try { return new URL(String(value || '')).protocol === 'https:'; } catch { return false; }
}

function safeFileName(value) {
  const fileName = path.basename(String(value || '').trim());
  if (!fileName || fileName === '.' || fileName === '..' || !/\.exe$/i.test(fileName)) throw new Error('اسم ملف التحديث يجب أن ينتهي بـ EXE');
  return fileName.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 160);
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function validateManifest(raw) {
  if (!raw || raw.format !== UPDATE_FORMAT) throw new Error('ملف تعريف التحديث غير صالح');
  const version = parseVersion(raw.version).raw;
  const url = String(raw.download?.url || '').trim();
  const sha256 = String(raw.download?.sha256 || '').trim().toLowerCase();
  const size = Number(raw.download?.size || 0);
  if (!isHttpsUrl(url)) throw new Error('رابط التحديث يجب أن يستخدم HTTPS');
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('بصمة SHA-256 غير صالحة');
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPDATE_BYTES) throw new Error('حجم ملف التحديث غير صالح');
  return {
    format: UPDATE_FORMAT,
    version,
    publishedAt: new Date(raw.publishedAt || Date.now()).toISOString(),
    releaseNotes: String(raw.releaseNotes || '').trim().slice(0, 2000),
    download: { url, sha256, size, fileName: safeFileName(raw.download?.fileName || path.basename(new URL(url).pathname)) }
  };
}

async function createReleaseManifest({ version, filePath, downloadUrl, releaseNotes = '', publishedAt = new Date().toISOString() }) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile() || stat.size < 1) throw new Error('ملف EXE المطلوب للنشر غير موجود أو فارغ');
  return validateManifest({
    format: UPDATE_FORMAT,
    version,
    publishedAt,
    releaseNotes,
    download: { url: downloadUrl, sha256: await sha256File(filePath), size: stat.size, fileName: path.basename(filePath) }
  });
}

async function fetchManifest(manifestUrl) {
  if (!isHttpsUrl(manifestUrl)) throw new Error('لم يُضبط رابط HTTPS صالح لملف تعريف التحديث');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(manifestUrl, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`تعذر قراءة ملف التحديث: HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > 256 * 1024) throw new Error('ملف تعريف التحديث كبير على نحو غير متوقع');
    return validateManifest(await response.json());
  } finally { clearTimeout(timer); }
}

async function downloadAndVerify(manifest, destinationDirectory) {
  const update = validateManifest(manifest);
  await fsp.mkdir(destinationDirectory, { recursive: true });
  const destination = path.join(destinationDirectory, update.download.fileName);
  const temporary = `${destination}.download`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60_000);
  try {
    const response = await fetch(update.download.url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok || !response.body) throw new Error(`تعذر تنزيل التحديث: HTTP ${response.status}`);
    const expectedLength = Number(response.headers.get('content-length') || 0);
    if (expectedLength && expectedLength !== update.download.size) throw new Error('حجم ملف التحديث لا يطابق ملف التعريف');
    const hash = crypto.createHash('sha256');
    const output = fs.createWriteStream(temporary, { flags: 'w' });
    let received = 0;
    for await (const chunk of Readable.fromWeb(response.body)) {
      received += chunk.length;
      if (received > update.download.size || received > MAX_UPDATE_BYTES) throw new Error('تم تجاوز الحجم المتوقع لملف التحديث');
      hash.update(chunk);
      if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
    }
    await new Promise((resolve, reject) => { output.end(resolve); output.once('error', reject); });
    if (received !== update.download.size) throw new Error('ملف التحديث غير مكتمل');
    if (hash.digest('hex') !== update.download.sha256) throw new Error('فشل التحقق من بصمة SHA-256 للتحديث');
    await fsp.rename(temporary, destination);
    return { path: destination, fileName: update.download.fileName, size: received, sha256: update.download.sha256 };
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  } finally { clearTimeout(timer); }
}

module.exports = { UPDATE_FORMAT, compareVersions, isHttpsUrl, sha256File, validateManifest, createReleaseManifest, fetchManifest, downloadAndVerify };
