'use strict';

/**
 * Generate the launcher's icon assets from `dsh-ico.ico`, the tracked artwork.
 *
 * One source of truth: the tray, the taskbar, the window, and the packaged
 * `DSH Launcher.exe` all render the same image, taken from this one file.
 *
 * Windows picks an icon size per context — 16 in the tray and title bar, 32 in
 * the taskbar, 48/256 in Explorer. An .ico carrying only one large entry is
 * downscaled by the shell and looks soft exactly where it is most visible, so
 * the output carries every size Windows may ask for.
 *
 * Known trade-off: the source entry is 96x96, so 128 and 256 are upscales and
 * cannot be sharper than the source. Replacing `dsh-ico.ico` with a >=256
 * version of the same artwork would fix that with no other change.
 *
 * Run with Electron, not plain node: `npm run make-icons`.
 */

const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/** Widest first; Windows matches by nearest size. */
const SIZES = [256, 128, 64, 48, 32, 24, 16];
const TRAY_PNG_SIZE = 256;

const root = path.join(__dirname, '..');
const assets = path.join(root, 'assets');
const source = path.join(root, 'dsh-ico.ico');

/**
 * Wrap PNG buffers in an ICO container.
 *
 * PNG-compressed entries are understood by Windows Vista and later and keep
 * gradient fidelity that BMP entries lose at small sizes.
 */
function pngsToIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach(({ size, png }, index) => {
    const at = index * 16;
    // A zero byte encodes 256 in the ICO directory.
    directory.writeUInt8(size >= 256 ? 0 : size, at + 0);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); // palette colour count
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

app.whenReady().then(() => {
  if (!fs.existsSync(source)) {
    console.error(`missing source artwork: ${source}`);
    app.exit(1);
    return;
  }

  // Electron decodes .ico directly, so the DIB inside needs no manual parsing.
  const original = nativeImage.createFromPath(source);
  if (original.isEmpty()) {
    console.error(`could not decode ${source}`);
    app.exit(1);
    return;
  }
  const dims = original.getSize();
  console.log(`source: dsh-ico.ico -> ${dims.width}x${dims.height}`);
  const native = Math.min(dims.width, dims.height);
  const upscaled = SIZES.filter((size) => size > native);

  const entries = [];
  for (const size of SIZES) {
    const png = original.resize({ width: size, height: size, quality: 'best' }).toPNG();
    if (png.length === 0) {
      console.error(`resize to ${size} produced no data`);
      app.exit(1);
      return;
    }
    entries.push({ size, png });
    const note = size > native ? ` (upscaled from ${native})` : '';
    console.log(`  ${String(size).padStart(3)}x${String(size).padEnd(3)} ${String(png.length).padStart(6)} bytes${note}`);
  }

  const pngPath = path.join(assets, 'icon.png');
  const icoPath = path.join(assets, 'icon.ico');
  fs.writeFileSync(pngPath, entries.find((entry) => entry.size === TRAY_PNG_SIZE).png);
  fs.writeFileSync(icoPath, pngsToIco(entries));

  console.log(`wrote ${path.relative(root, pngPath)} (${fs.statSync(pngPath).size} bytes)`);
  console.log(`wrote ${path.relative(root, icoPath)} (${fs.statSync(icoPath).size} bytes, ${entries.length} sizes)`);
  if (upscaled.length > 0) {
    console.log(`note: ${upscaled.join(', ')} exceed the ${native}px source and are interpolated;`);
    console.log('      replace dsh-ico.ico with a >=256px version to make them sharp.');
  }
  app.exit(0);
});
