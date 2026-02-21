import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array;
}

interface DiffImageOptions {
  threshold?: number;
  outputPath?: string;
  baselineMime?: 'image/png' | 'image/jpeg';
}

interface DiffImageResult {
  diffPath: string;
  totalPixels: number;
  differentPixels: number;
  mismatchPercentage: number;
  match: boolean;
  dimensionMismatch?: boolean;
}

function decodePng(buffer: Buffer): DecodedImage {
  const png = PNG.sync.read(buffer);
  return {
    width: png.width,
    height: png.height,
    data: png.data,
  };
}

function decodeJpeg(buffer: Buffer): DecodedImage {
  const decoded = jpeg.decode(buffer, {
    useTArray: true,
  });
  return {
    width: decoded.width,
    height: decoded.height,
    data: decoded.data,
  };
}

function decodeImage(buffer: Buffer, mime: 'image/png' | 'image/jpeg'): DecodedImage {
  if (mime === 'image/jpeg') {
    return decodeJpeg(buffer);
  }
  return decodePng(buffer);
}

async function resolveDiffPath(outputPath?: string): Promise<string> {
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    return outputPath;
  }

  const tmpDir = join(homedir(), '.human-browser', 'tmp', 'diffs');
  await mkdir(tmpDir, { recursive: true });
  return join(tmpDir, `diff-${Date.now()}.png`);
}

async function writeDiffImage(path: string, width: number, height: number, data: Uint8Array): Promise<void> {
  const png = new PNG({ width, height });
  png.data = Buffer.from(data);
  const encoded = PNG.sync.write(png);
  await writeFile(path, encoded);
}

export async function diffImages(
  baselineBuffer: Buffer,
  currentBuffer: Buffer,
  options: DiffImageOptions,
): Promise<DiffImageResult> {
  const baselineMime = options.baselineMime ?? 'image/png';
  const threshold = options.threshold ?? 0.1;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`Threshold must be between 0 and 1, got ${String(options.threshold)}`);
  }

  const baseline = decodeImage(baselineBuffer, baselineMime);
  const current = decodePng(currentBuffer);

  const diffPath = await resolveDiffPath(options.outputPath);

  if (baseline.width !== current.width || baseline.height !== current.height) {
    const totalPixels = Math.max(
      baseline.width * baseline.height,
      current.width * current.height,
    );

    await writeDiffImage(diffPath, 1, 1, new Uint8Array([0, 0, 0, 0]));

    return {
      diffPath,
      totalPixels,
      differentPixels: totalPixels,
      mismatchPercentage: 100,
      match: false,
      dimensionMismatch: true,
    };
  }

  const totalPixels = baseline.width * baseline.height;
  const diffData = new Uint8Array(totalPixels * 4);
  const maxColorDistance = threshold * 255 * Math.sqrt(3);
  let differentPixels = 0;

  for (let i = 0; i < totalPixels; i += 1) {
    const offset = i * 4;
    const rA = baseline.data[offset] as number;
    const gA = baseline.data[offset + 1] as number;
    const bA = baseline.data[offset + 2] as number;

    const rB = current.data[offset] as number;
    const gB = current.data[offset + 1] as number;
    const bB = current.data[offset + 2] as number;

    const dr = rA - rB;
    const dg = gA - gB;
    const db = bA - bB;
    const distance = Math.sqrt(dr * dr + dg * dg + db * db);

    if (distance > maxColorDistance) {
      differentPixels += 1;
      diffData[offset] = 255;
      diffData[offset + 1] = 0;
      diffData[offset + 2] = 0;
      diffData[offset + 3] = 255;
      continue;
    }

    diffData[offset] = Math.round(rA * 0.3);
    diffData[offset + 1] = Math.round(gA * 0.3);
    diffData[offset + 2] = Math.round(bA * 0.3);
    diffData[offset + 3] = 255;
  }

  await writeDiffImage(diffPath, baseline.width, baseline.height, diffData);

  return {
    diffPath,
    totalPixels,
    differentPixels,
    mismatchPercentage: Math.round((differentPixels / totalPixels) * 10000) / 100,
    match: differentPixels === 0,
  };
}
