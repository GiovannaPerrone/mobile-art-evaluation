/*
 * Teste do detector em pinturas reais com dano anotado por especialistas (ArtInsight, Zenodo,
 * CC-BY-4.0, Universidad de Granada). As imagens ficam fora do repositorio.
 * Uso:
 *   node tests/artinsight.js pasta/lpl [pintura|impresso]
 * A pasta lpl tem as subpastas train/ e test/ com as fotos .jpg e o lpl_*.json (formato VIA).
 * Nenhum parametro do detector foi ajustado com estas imagens: todas servem de teste.
 * Saida: tabela no terminal e tests/saida/artinsight-<arquivo>.jpg (ouro em verde, detectado em vermelho).
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

function desenharPoligonos(contexto, regioes, escala, cor) {
  contexto.fillStyle = cor;
  Object.values(regioes).forEach((regiao) => {
    const xs = regiao.shape_attributes.all_points_x, ys = regiao.shape_attributes.all_points_y;
    contexto.beginPath();
    xs.forEach((x, i) => { if (i === 0) contexto.moveTo(x * escala, ys[i] * escala); else contexto.lineTo(x * escala, ys[i] * escala); });
    contexto.closePath(); contexto.fill();
  });
}

(async () => {
  const pastaLpl = process.argv[2];
  const modo = process.argv[3] || 'pintura';
  if (!pastaLpl) { console.log('uso: node tests/artinsight.js pasta/lpl [pintura|impresso]'); process.exit(1); }
  const cv = await loadCV(raw); const P = createPipeline(cv);
  fs.mkdirSync(path.join(__dirname, 'saida'), { recursive: true });

  const linhas = [];
  for (const divisao of ['test', 'train']) {
    const gabarito = JSON.parse(fs.readFileSync(path.join(pastaLpl, divisao, `lpl_${divisao}.json`)));
    for (const entrada of Object.values(gabarito)) {
      const arquivo = entrada.filename;
      const imagem = await napi.loadImage(fs.readFileSync(path.join(pastaLpl, divisao, arquivo)));
      const escala = Math.min(1, 1280 / Math.max(imagem.width, imagem.height));
      const largura = Math.round(imagem.width * escala), altura = Math.round(imagem.height * escala);
      const tela = napi.createCanvas(largura, altura), contexto = tela.getContext('2d');
      contexto.drawImage(imagem, 0, 0, largura, altura);
      const rgba = cv.matFromImageData(contexto.getImageData(0, 0, largura, altura));

      const mascaraGabarito = napi.createCanvas(largura, altura), contextoGabarito = mascaraGabarito.getContext('2d');
      contextoGabarito.fillStyle = '#000'; contextoGabarito.fillRect(0, 0, largura, altura);
      desenharPoligonos(contextoGabarito, entrada.regions, escala, '#fff');
      const pixelsGabarito = contextoGabarito.getImageData(0, 0, largura, altura).data;

      const regiaoValida = cv.Mat.ones(altura, largura, cv.CV_8UC1); regiaoValida.setTo(new cv.Scalar(255));
      const deteccao = P.detect(rgba, regiaoValida, { mode: modo });

      let gabaritoTotal = 0, detectadoTotal = 0, interseccao = 0;
      const pixelsDeteccao = deteccao.mask.data;
      for (let i = 0; i < largura * altura; i++) {
        const noGabarito = pixelsGabarito[i * 4] > 127, naDeteccao = pixelsDeteccao[i] > 0;
        if (noGabarito) gabaritoTotal++;
        if (naDeteccao) detectadoTotal++;
        if (noGabarito && naDeteccao) interseccao++;
      }

      // caixas que caem em cima do gabarito (pelo menos 30% da area da caixa)
      let caixasCertas = 0;
      deteccao.boxes.forEach((caixa) => {
        let dentro = 0;
        for (let y = caixa.y; y < caixa.y + caixa.h; y++) for (let x = caixa.x; x < caixa.x + caixa.w; x++) {
          if (pixelsGabarito[(y * largura + x) * 4] > 127) dentro++;
        }
        if (dentro / (caixa.w * caixa.h) >= 0.3) caixasCertas++;
      });

      // poligonos do gabarito tocados pela deteccao (pelo menos 10% da area do poligono)
      let poligonosTocados = 0; const totalPoligonos = Object.keys(entrada.regions).length;
      Object.values(entrada.regions).forEach((regiao) => {
        const poligono = napi.createCanvas(largura, altura), cp = poligono.getContext('2d');
        cp.fillStyle = '#000'; cp.fillRect(0, 0, largura, altura);
        desenharPoligonos(cp, { a: regiao }, escala, '#fff');
        const dados = cp.getImageData(0, 0, largura, altura).data;
        let area = 0, achada = 0;
        for (let i = 0; i < largura * altura; i++) if (dados[i * 4] > 127) { area++; if (pixelsDeteccao[i] > 0) achada++; }
        if (area > 0 && achada / area >= 0.1) poligonosTocados++;
      });

      const fracaoGabarito = gabaritoTotal / (largura * altura);
      const precisao = detectadoTotal ? interseccao / detectadoTotal : 0;
      const cobertura = gabaritoTotal ? interseccao / gabaritoTotal : 0;
      linhas.push({
        arquivo, divisao, danoReal: fracaoGabarito, danoMarcado: detectadoTotal / (largura * altura),
        precisaoPixels: precisao, ganhoSobreAcaso: fracaoGabarito ? precisao / fracaoGabarito : 0,
        coberturaPixels: cobertura, caixas: deteccao.boxes.length, caixasCertas,
        poligonos: totalPoligonos, poligonosTocados, ms: deteccao.stats.ms
      });

      const saida = napi.createCanvas(largura, altura), cs = saida.getContext('2d');
      cs.drawImage(tela, 0, 0);
      cs.globalAlpha = 0.35; desenharPoligonos(cs, entrada.regions, escala, '#00ff55'); cs.globalAlpha = 1;
      cs.strokeStyle = '#ff2a2a'; cs.lineWidth = 2;
      deteccao.boxes.forEach((caixa) => cs.strokeRect(caixa.x, caixa.y, caixa.w, caixa.h));
      fs.writeFileSync(path.join(__dirname, 'saida', `artinsight-${arquivo}`), saida.toBuffer('image/jpeg', 85));

      regiaoValida.delete(); rgba.delete(); deteccao.mask.delete();
    }
  }

  const pct = (v) => (v * 100).toFixed(1) + '%';
  console.log(`modo: ${modo}`);
  console.log('arquivo | divisao | dano real | dano marcado | precisao (px) | ganho sobre o acaso | cobertura (px) | caixas certas | poligonos tocados | ms');
  linhas.forEach((l) => console.log([l.arquivo, l.divisao, pct(l.danoReal), pct(l.danoMarcado), pct(l.precisaoPixels), l.ganhoSobreAcaso.toFixed(2) + 'x',
    pct(l.coberturaPixels), `${l.caixasCertas}/${l.caixas}`, `${l.poligonosTocados}/${l.poligonos}`, l.ms.toFixed(0)].join(' | ')));
  const soma = (campo) => linhas.reduce((a, l) => a + l[campo], 0);
  console.log('TOTAL | caixas certas', soma('caixasCertas'), 'de', soma('caixas'), '| poligonos tocados', soma('poligonosTocados'), 'de', soma('poligonos'));
  fs.writeFileSync(path.join(__dirname, 'saida', `artinsight-${modo}.json`), JSON.stringify(linhas, null, 2));
  process.exit(0);
})();
