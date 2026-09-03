// Reads per-pixel depth from the scene's depth PNG, entirely client-side.
//
// Depth is stored in the RED channel of the depth image (0..255 → 0..1), the
// same convention web/src/3d/point-cloud.js uses to build the point cloud.
// `createDepthSampler` loads the image once into an offscreen 2D canvas;
// `sample(u, v)` reads the depth at a normalized photo coordinate. Pane-
// independent — works whether or not the 3D viewport is mounted.

// Pure: sample an ImageData-like object ({ width, height, data: RGBA }) at a
// normalized (u, v). Clamps (u, v) into [0, 1] so a click is never out of range.
export function sampleDepthFromImageData(img, u, v) {
  const cu = Math.min(1, Math.max(0, u));
  const cv = Math.min(1, Math.max(0, v));
  const col = Math.min(img.width - 1, Math.floor(cu * img.width));
  const row = Math.min(img.height - 1, Math.floor(cv * img.height));
  const idx = (row * img.width + col) * 4;
  return img.data[idx] / 255;
}

async function loadImageData(url) {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
    image.src = url;
  });
  const cv = document.createElement('canvas');
  cv.width = image.naturalWidth;
  cv.height = image.naturalHeight;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, cv.width, cv.height);
}

// Create a sampler for a depth PNG URL. `sample(u, v)` returns the median
// fallback (0.5) until the image finishes loading, so callers never throw.
export function createDepthSampler(depthUrl, { fallback = 0.5 } = {}) {
  let imageData = null;
  const ready = loadImageData(depthUrl)
    .then((d) => { imageData = d; })
    .catch(() => { imageData = null; });

  return {
    ready,
    sample(u, v) {
      if (!imageData) return fallback;
      return sampleDepthFromImageData(imageData, u, v);
    },
  };
}
