/*
 * Testes do modelo treinado: a uniao com o detector classico (sem modelo, sempre roda) e a inferencia
 * em Node com o ONNX real (so roda se models/yolo-A-pinturas.onnx existir).
 */
const fs = require('fs');
const path = require('path');
const createPipeline = require('../js/pipeline.js');
const createModelo = require('../js/modelo.js');

function check(cond, label) { if (!cond) throw new Error('verificacao falhou: ' + label); console.log('ok:', label); }

// ---- NMS e uniao (nao precisam do OpenCV nem do modelo)
const M0 = createModelo({});
const mantidos = M0.suprimir([[0, 0, 10, 10], [1, 1, 11, 11], [50, 50, 60, 60]], [0.5, 0.9, 0.3], 0.45);
check(mantidos.length === 2 && mantidos[0] === 1 && mantidos.indexOf(2) >= 0, 'NMS mantem a de maior confianca e a caixa distante');

const P = createPipeline(null);
const W = 1000, H = 800;
const classico = [{ x: 100, y: 100, w: 50, h: 50, area: 2500, type: 'rachadura' }];
const entradas = P.mergeAll(classico, [], W, H);
check(entradas[0].motores.join() === 'classico', 'entrada do detector classico traz motores = classico');
P.addModelBoxes(entradas, [{ label: 'luz normal', boxes: [
  { x: 105, y: 105, w: 45, h: 45, area: 2025, score: 0.4 },     // em cima da caixa classica
  { x: 500, y: 400, w: 60, h: 40, area: 2400, score: 0.2 }      // so o modelo achou
] }], W, H);
check(entradas.length === 2, 'caixa do modelo sobre a classica nao duplica (2 entradas)');
check(entradas[0].motores.join() === 'classico,modelo' && Math.abs(entradas[0].scoreModelo - 0.4) < 1e-9, 'a entrada classica marca que o modelo tambem viu, com a confianca');
check(entradas[1].type === 'avaria (modelo)' && entradas[1].motores.join() === 'modelo' && entradas[1].id === 2, 'caixa so do modelo vira entrada nova, numerada');
check(Math.abs(entradas[1].cx - 530 / W) < 1e-9, 'centro normalizado calculado');

// ---- inferencia com o ONNX real
const arquivo = path.join(__dirname, '..', 'models', 'yolo-A-pinturas.onnx');
if (!fs.existsSync(arquivo)) { console.log('modelo nao encontrado em models/: inferencia ignorada'); process.exit(0); }
const napi = require('@napi-rs/canvas');
const ort = require('onnxruntime-web');
(async () => {
  const M = createModelo(ort);
  const info = await M.carregar(new Uint8Array(fs.readFileSync(arquivo)));
  check(!!info.entrada && !!info.saida && M.pronto(), 'modelo carregou (entrada ' + info.entrada + ', saida ' + info.saida + ')');
  const tela = napi.createCanvas(1300, 900), g = tela.getContext('2d');   // menor que 2560: so exercita os recortes e a saida
  g.fillStyle = 'rgb(140,110,80)'; g.fillRect(0, 0, 1300, 900);
  g.fillStyle = 'rgb(225,215,195)'; g.fillRect(400, 300, 120, 90);
  let ultimo = 0;
  const r = await M.detectar(tela, { progresso: (i, n) => { ultimo = i; } });
  check(r.recortes === 3 * 2 && ultimo === 6, 'percorreu 3 x 2 recortes de 640 px (passo 480)');
  check(Array.isArray(r.caixas) && r.caixas.every((c) => c.x >= 0 && c.y >= 0 && c.x + c.w <= 1300.01 && c.y + c.h <= 900.01 && c.score >= M.confMin), 'caixas dentro da imagem e com confianca valida');
  console.log('   caixas na imagem sintetica:', r.caixas.length, '|', (r.ms / 1000).toFixed(1), 's');
  process.exit(0);
})().catch((e) => { console.error('FALHA:', e && e.message || e); process.exit(1); });
