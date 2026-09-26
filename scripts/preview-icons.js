'use strict';

/**
 * Visual check for the icon at every size Windows actually uses.
 *
 * "The icon looks wrong" usually means one of two things: the artwork is not
 * the official one, or a small size lost the silhouette. This composes every
 * size side by side at 1:1 so a viewer can judge legibility — a bloated
 * programme icon is obvious even when downscaled to fit a chat window.
 *
 * Run with Electron: `electron scripts/preview-icons.js`
 * Writes preview-icons.png at the project root.
 */

const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/** Order matches how Windows uses them, largest first. */
const SIZES = [256, 128, 64, 48, 32, 24, 16];
const GAP = 10;
const MARGIN = 12;

app.whenReady().then(() => {
  const root = path.join(__dirname, '..');
  // Read the generated asset, so the preview shows exactly what ships.
  const source = path.join(root, 'assets', 'icon.png');
  const original = nativeImage.createFromPath(source);
  if (original.isEmpty()) {
    console.error(`could not decode ${source}`);
    app.exit(1);
    return;
  }
  console.log(`source: ${original.getSize().width}x${original.getSize().height}`);

  // Render each size, then place them left to right on a transparent strip.
  const rendered = SIZES.map((size) => ({
    size,
    bitmap: original.resize({ width: size, height: size, quality: 'best' }).toBitmap(),
  }));

  const stripWidth = MARGIN * 2 + rendered.reduce((sum, item) => sum + item.size, 0) + GAP * (rendered.length - 1);
  const stripHeight = MARGIN * 2 + Math.max(...SIZES);
  const strip = Buffer.alloc(stripWidth * stripHeight * 4);

  let x = MARGIN;
  for (const item of rendered) {
    const y = stripHeight - MARGIN - item.size; // bottom-aligned, like a taskbar row
    for (let row = 0; row < item.size; row++) {
      const from = row * item.size * 4;
      const to = ((y + row) * stripWidth + x) * 4;
      item.bitmap.copy(strip, to, from, from + item.size * 4);
    }
    console.log(`  placed ${String(item.size).padStart(3)}px at x=${x}`);
    x += item.size + GAP;
  }

  const image = nativeImage.createFromBitmap(strip, { width: stripWidth, height: stripHeight });
  if (image.isEmpty()) {
    console.error('could not build the strip image');
    app.exit(1);
    return;
  }
  const out = path.join(root, 'preview-icons.png');
  fs.writeFileSync(out, image.toPNG());
  const dims = image.getSize();
  console.log(`wrote ${path.relative(root, out)} (${dims.width}x${dims.height})`);
  app.exit(0);
});
