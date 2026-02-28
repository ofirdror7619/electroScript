const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const toIco = require('to-ico');

const size = 256;

function setPixel(png, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= size || y >= size) {
    return;
  }
  const idx = (size * y + x) << 2;
  png.data[idx] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = a;
}

function fillRect(png, startX, startY, width, height, color) {
  for (let y = startY; y < startY + height; y += 1) {
    for (let x = startX; x < startX + width; x += 1) {
      setPixel(png, x, y, color.r, color.g, color.b, color.a ?? 255);
    }
  }
}

function drawCharE(png, offsetX, offsetY, scale, color) {
  fillRect(png, offsetX, offsetY, 1 * scale, 7 * scale, color);
  fillRect(png, offsetX, offsetY, 5 * scale, 1 * scale, color);
  fillRect(png, offsetX, offsetY + 3 * scale, 4 * scale, 1 * scale, color);
  fillRect(png, offsetX, offsetY + 6 * scale, 5 * scale, 1 * scale, color);
}

function drawCharS(png, offsetX, offsetY, scale, color) {
  fillRect(png, offsetX, offsetY, 5 * scale, 1 * scale, color);
  fillRect(png, offsetX, offsetY, 1 * scale, 3 * scale, color);
  fillRect(png, offsetX, offsetY + 3 * scale, 5 * scale, 1 * scale, color);
  fillRect(png, offsetX + 4 * scale, offsetY + 3 * scale, 1 * scale, 3 * scale, color);
  fillRect(png, offsetX, offsetY + 6 * scale, 5 * scale, 1 * scale, color);
}

async function main() {
  const buildDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(buildDir, { recursive: true });

  const png = new PNG({ width: size, height: size });

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const t = (x + y) / (size * 2);
      const r = Math.round(12 + 26 * t);
      const g = Math.round(26 + 56 * t);
      const b = Math.round(58 + 90 * t);
      setPixel(png, x, y, r, g, b, 255);
    }
  }

  const border = { r: 69, g: 143, b: 255, a: 255 };
  fillRect(png, 20, 20, size - 40, 8, border);
  fillRect(png, 20, size - 28, size - 40, 8, border);
  fillRect(png, 20, 20, 8, size - 40, border);
  fillRect(png, size - 28, 20, 8, size - 40, border);

  const textColor = { r: 240, g: 247, b: 255, a: 255 };
  const scale = 20;
  const totalWidth = 11 * scale;
  const startX = Math.floor((size - totalWidth) / 2);
  const startY = Math.floor((size - 7 * scale) / 2);

  drawCharE(png, startX, startY, scale, textColor);
  drawCharS(png, startX + 6 * scale, startY, scale, textColor);

  const pngBuffer = PNG.sync.write(png);
  const pngPath = path.join(buildDir, 'icon.png');
  fs.writeFileSync(pngPath, pngBuffer);

  const icoBuffer = await toIco([pngBuffer]);
  const icoPath = path.join(buildDir, 'icon.ico');
  fs.writeFileSync(icoPath, icoBuffer);

  console.log(`Generated icon files:\n- ${pngPath}\n- ${icoPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
