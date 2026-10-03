/*
 * Grava em JSON as caixas do detector classico para uma lista de imagens (escala de trabalho 2560 px).
 * Uso: node tests/dump-caixas.js saida.json modo:caminho [modo:caminho ...]   (modo = pintura | impresso)
 */
const fs = require('fs');
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
  const [saida, ...pedidos] = process.argv.slice(2);
  const cv = await loadCV(raw); const P = createPipeline(cv);
  const resultado = {};
  for (const pedido of pedidos) {
    const [modo, caminho] = [pedido.slice(0, pedido.indexOf(':')), pedido.slice(pedido.indexOf(':') + 1)];
    const imagem = await napi.loadImage(fs.readFileSync(caminho));
    const escala = Math.min(1, 1280 / Math.max(imagem.width, imagem.height));
    const largura = Math.round(imagem.width * escala), altura = Math.round(imagem.height * escala);
    const tela = napi.createCanvas(largura, altura), contexto = tela.getContext('2d');
    contexto.drawImage(imagem, 0, 0, largura, altura);
    const rgba = cv.matFromImageData(contexto.getImageData(0, 0, largura, altura));
    const regiaoValida = cv.Mat.ones(altura, largura, cv.CV_8UC1); regiaoValida.setTo(new cv.Scalar(255));
    const deteccao = P.detect(rgba, regiaoValida, { mode: modo });
    const para2560 = 2560 / Math.max(largura, altura);
    resultado[caminho] = deteccao.boxes.map((c) => [c.x * para2560, c.y * para2560, (c.x + c.w) * para2560, (c.y + c.h) * para2560]);
    console.log(modo, caminho.split('/').pop(), deteccao.boxes.length, 'caixas');
    regiaoValida.delete(); rgba.delete(); deteccao.mask.delete();
  }
  fs.writeFileSync(saida, JSON.stringify(resultado));
  process.exit(0);
})();
