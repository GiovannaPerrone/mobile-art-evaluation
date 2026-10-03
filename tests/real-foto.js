/*
 * Teste em foto real (nao entra no "npm test": a foto fica fora do repositorio).
 * Uso:
 *   node tests/real-foto.js caminho/da/foto.jpg [rotulos.png]
 * Saida: tests/saida/real-foto.jpg com as manchas e as regioes descartadas.
 * rotulos.png (opcional): imagem de 8 bits, mesmo tamanho da foto reduzida a 1280 px,
 * em que cada area conhecida de dano tem um valor diferente de zero (para contar acertos).
 */
const fs = require('fs');
const path = require('path');
const napi = require('@napi-rs/canvas');
const raw = require('@techstark/opencv-js');
const createPipeline = require('../js/pipeline.js');

function loadCV(r) {
  return new Promise((resolve) => {
    if (r.Mat) return resolve(r);
    if (typeof r.then === 'function') r.then((m) => resolve(m || r)); else r.onRuntimeInitialized = () => resolve(r);
  });
}

(async () => {
  const fotoPath = process.argv[2];
  if (!fotoPath) { console.log('uso: node tests/real-foto.js foto.jpg [rotulos.png]'); process.exit(1); }
  const cv = await loadCV(raw); const P = createPipeline(cv);
  const img = await napi.loadImage(fs.readFileSync(fotoPath));
  const s = Math.min(1, 1280 / Math.max(img.width, img.height));
  const W = Math.round(img.width * s), H = Math.round(img.height * s);
  const c = napi.createCanvas(W, H), g = c.getContext('2d');
  g.drawImage(img, 0, 0, W, H);
  const rgba = cv.matFromImageData(g.getImageData(0, 0, W, H));

  // recorte da peca (fracoes: esquerda, topo, direita, base), igual ao controle da tela
  const crop = (process.env.RECORTE || '0.04,0.085,0.985,0.92').split(',').map(Number);
  const roi = cv.Mat.zeros(H, W, cv.CV_8UC1);
  cv.rectangle(roi, new cv.Point(Math.round(crop[0] * W), Math.round(crop[1] * H)), new cv.Point(Math.round(crop[2] * W), Math.round(crop[3] * H)), new cv.Scalar(255), -1);

  const det = P.detectPrint(rgba, roi, {});
  console.log('manchas:', det.boxes.length, '| regioes avaliadas', det.tiles.evaluated, '| descartadas', det.tiles.rejected,
    '(' + (det.stats.rejectedFrac * 100).toFixed(0) + '%) |', det.stats.ms.toFixed(0), 'ms');

  if (process.argv[3]) {
    const lab = await napi.loadImage(fs.readFileSync(process.argv[3]));
    const lc = napi.createCanvas(W, H), lg = lc.getContext('2d'); lg.drawImage(lab, 0, 0, W, H);
    const ld = lg.getImageData(0, 0, W, H).data;
    const hits = {};
    let inside = 0;
    det.boxes.forEach((b) => {
      let touched = false;
      for (let y = b.y; y < b.y + b.h && !touched; y++) for (let x = b.x; x < b.x + b.w; x++) {
        const v = ld[(y * W + x) * 4];
        if (v > 10) { hits[v] = (hits[v] || 0) + 1; touched = true; break; }
      }
      if (touched) inside++;
    });
    const areas = new Set(); for (let i = 0; i < ld.length; i += 4) if (ld[i] > 10) areas.add(ld[i]);
    console.log('areas conhecidas com ao menos uma marcacao:', Object.keys(hits).length, 'de', areas.size, '| caixas dentro das areas:', inside, 'de', det.boxes.length);
  }

  // imagem de saida
  const out = napi.createCanvas(W, H), og = out.getContext('2d');
  og.drawImage(c, 0, 0);
  og.fillStyle = 'rgba(10,14,13,0.55)';
  const t = det.tiles;
  for (let r = 0; r < t.rows; r++) for (let q = 0; q < t.cols; q++) if (!t.keep[r * t.cols + q]) og.fillRect(q * t.size, r * t.size, t.size, t.size);
  og.strokeStyle = '#ff4b33'; og.lineWidth = 2;
  det.boxes.forEach((b) => og.strokeRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6));
  fs.mkdirSync(path.join(__dirname, 'saida'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'saida', 'real-foto.jpg'), out.toBuffer('image/jpeg', 90));
  console.log('imagem em tests/saida/real-foto.jpg');
  process.exit(0);
})();
