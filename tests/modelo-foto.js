/*
 * Roda o modelo treinado (ONNX) numa foto real, em Node, com o mesmo codigo do app (js/modelo.js).
 * Uso: node tests/modelo-foto.js foto.jpg [modelo.onnx] [confianca]
 * Saida: numero de caixas, area marcada e tests/saida/modelo-foto.jpg (caixas em vermelho). A foto fica fora do repositorio.
 */
const fs = require('fs');
const path = require('path');
const napi = require('@napi-rs/canvas');
const ort = require('onnxruntime-web');
const createModelo = require('../js/modelo.js');

(async () => {
  const [foto, modeloPath = path.join(__dirname, '..', 'models', 'yolo-A-pinturas.onnx'), conf = '0.10'] = process.argv.slice(2);
  if (!foto) { console.log('uso: node tests/modelo-foto.js foto.jpg [modelo.onnx] [confianca]'); process.exit(1); }
  const M = createModelo(ort);
  await M.carregar(new Uint8Array(fs.readFileSync(modeloPath)));
  const imagem = await napi.loadImage(fs.readFileSync(foto));
  const escala = M.lado / Math.max(imagem.width, imagem.height);
  const W = Math.round(imagem.width * escala), H = Math.round(imagem.height * escala);
  const tela = napi.createCanvas(W, H), g = tela.getContext('2d');
  g.drawImage(imagem, 0, 0, W, H);
  const r = await M.detectar(tela, {});
  const caixas = r.caixas.filter((c) => c.score >= parseFloat(conf));
  const area = caixas.reduce((a, c) => a + c.w * c.h, 0) / (W * H);
  console.log(path.basename(foto), W + 'x' + H, '| recortes', r.recortes, '| caixas (conf >=', conf + '):', caixas.length, '| area marcada (soma):', (area * 100).toFixed(1) + '%', '|', (r.ms / 1000).toFixed(1), 's');
  g.strokeStyle = '#ff2a2a'; g.lineWidth = 5;
  caixas.forEach((c) => g.strokeRect(c.x, c.y, c.w, c.h));
  fs.mkdirSync(path.join(__dirname, 'saida'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'saida', 'modelo-foto.jpg'), tela.toBuffer('image/jpeg', 85));
  if (process.env.JSON_SAIDA) fs.writeFileSync(process.env.JSON_SAIDA, JSON.stringify(caixas));
  process.exit(0);
})().catch((e) => { console.error('FALHA:', e && e.message || e); process.exit(1); });
