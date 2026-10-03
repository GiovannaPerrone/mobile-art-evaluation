const fs = require('fs');
const path = require('path');
const { buildSingleFile } = require('../build.js');
const OUT = path.join(__dirname, 'saida');
fs.mkdirSync(OUT, { recursive: true });
const { JSDOM } = require('jsdom');
const napi = require('@napi-rs/canvas');
const rawCV = require('@techstark/opencv-js');

let seed = 777;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

// ---------------------------------------------------------------- imagens de teste (PNG em buffer)
function makePainting() {
  const W = 1600, H = 1200; // maior que 1280, para exercitar a reducao
  const c = napi.createCanvas(W, H), g = c.getContext('2d');
  g.fillStyle = 'rgb(150,120,90)'; g.fillRect(0, 0, W, H);
  const nz = napi.createCanvas(400, 300), ng = nz.getContext('2d');
  const id = ng.createImageData(400, 300);
  for (let i = 0; i < 400 * 300; i++) { const v = 128 + (rnd() - 0.5) * 50; id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
  ng.putImageData(id, 0, 0);
  g.globalAlpha = 0.25; g.imageSmoothingEnabled = true; g.drawImage(nz, 0, 0, W, H); g.globalAlpha = 1;
  for (let i = 0; i < 80; i++) {
    g.fillStyle = `rgb(${60 + rnd() * 160},${60 + rnd() * 160},${40 + rnd() * 160})`;
    if (rnd() < 0.5) { g.beginPath(); g.arc(rnd() * W, rnd() * H, 18 + rnd() * 60, 0, 7); g.fill(); }
    else g.fillRect(rnd() * W, rnd() * H, (rnd() - 0.5) * 300, (rnd() - 0.5) * 300);
  }
  const k = 1.25; // fator de escala das coordenadas do teste anterior (1280 -> 1600)
  g.strokeStyle = 'rgb(25,20,18)'; g.lineWidth = 2.5; g.lineJoin = 'round';
  [[[200, 150], [260, 190], [300, 260], [380, 300], [420, 380]], [[800, 600], [860, 640], [900, 720], [990, 760]], [[300, 700], [380, 690], [460, 720], [540, 700], [600, 740]]].forEach((pts) => {
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0] * k, p[1] * k) : g.moveTo(p[0] * k, p[1] * k))); g.stroke();
  });
  g.fillStyle = 'rgb(235,228,215)'; g.beginPath(); g.ellipse(1000 * k, 220 * k, 55 * k, 40 * k, 0.35, 0, 7); g.fill();
  return c;
}
const painting = makePainting();
const refPng = painting.toBuffer('image/png');
const secCanvas = napi.createCanvas(1600, 1200), sg = secCanvas.getContext('2d');
sg.fillStyle = '#000'; sg.fillRect(0, 0, 1600, 1200);
sg.translate(800 + 20, 600 - 14); sg.rotate(4 * Math.PI / 180); sg.scale(0.96, 0.96); sg.translate(-800, -600);
sg.drawImage(painting, 0, 0); sg.setTransform(1, 0, 0, 1, 0, 0);
sg.fillStyle = 'rgba(0,0,0,0.15)'; sg.fillRect(0, 0, 1600, 1200);
const secPng = secCanvas.toBuffer('image/png');
console.log('imagens de teste:', (refPng.length / 1024).toFixed(0), 'kB e', (secPng.length / 1024).toFixed(0), 'kB');

// ---------------------------------------------------------------- DOM com shims
const html = buildSingleFile();
const errors = [];
const dom = new JSDOM('<!doctype html><html><head></head><body>' + html + '</body></html>', {
  runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(window) {
    window.cv = rawCV; // no navegador, window.cv e uma Promise do mesmo tipo
    window.ImageData = napi.ImageData;
    window.addEventListener('error', (e) => errors.push('window.error: ' + (e.error && e.error.stack || e.message)));
    window.HTMLCanvasElement.prototype.getContext = function () {
      const w = this.width || 300, h = this.height || 150;
      if (!this.__napi || this.__napi.width !== w || this.__napi.height !== h) this.__napi = napi.createCanvas(w, h);
      const ctx = this.__napi.getContext('2d');
      if (!ctx.__wrapped) { const orig = ctx.drawImage.bind(ctx); ctx.drawImage = (img, ...a) => orig(img && img.__napi ? img.__napi : img, ...a); ctx.__wrapped = true; }
      return ctx;
    };
    window.HTMLCanvasElement.prototype.toDataURL = function (t) { return this.__napi.toDataURL(t === 'image/jpeg' ? 'image/jpeg' : 'image/png'); };
    window.createImageBitmap = (file) => napi.loadImage(file.__buf);
    // intercepta o carregamento do script do OpenCV (o objeto ja esta em window.cv)
    const proto = window.HTMLHeadElement.prototype, origAppend = window.Node.prototype.appendChild;
    proto.appendChild = function (el) {
      if (el.tagName === 'SCRIPT' && el.src) { setTimeout(() => el.onload && el.onload(), 20); return el; }
      return origAppend.call(this, el);
    };
    window.getComputedStyle = () => ({ getPropertyValue: (n) => ({ '--c-both': '#ffd21f', '--c-normal': '#ff4b33', '--c-raking': '#1fd1ff', '--font-data': 'monospace' }[n] || '') });
  }
});
const { window } = dom;
const $ = (id) => window.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeout = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return; if (errors.length) throw new Error(errors[0]); await sleep(100); }
  throw new Error('timeout aguardando: ' + label);
}
function pick(inputId, buf, name) {
  const input = $(inputId);
  const file = { name, size: buf.length, __buf: buf };
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change'));
}

(async () => {
  await waitFor(() => /pronto/.test($('engineText').textContent), 'motor pronto');
  console.log('1. motor:', $('engineText').textContent, '| captura habilitada:', $('refCam').disabled === false);

  pick('refFile', refPng, 'ref.png');
  await waitFor(() => /analisada|rejeitada|erro/.test($('refPill').textContent), 'analise da referencia');
  console.log('2. referencia:', $('refPill').textContent, '|', $('refStatus').textContent);
  console.log('   iluminacao:', $('illPill').textContent, $('illVal').textContent, '|', $('illMsg').textContent);
  console.log('   triagem:', $('triLevel').textContent, '| danos', $('triCount').textContent, '| area', $('triArea').textContent, '| descartadas', $('triRej').textContent);
  console.log('   2a captura habilitada:', $('secCam').disabled === false);

  pick('secFile', secPng, 'sec.png');
  await waitFor(() => /alinhada|não alinhou|erro/.test($('secPill').textContent), 'alinhamento');
  console.log('3. segunda captura:', $('secPill').textContent, '|', $('secStatus').textContent);
  console.log('   triagem:', $('triLevel').textContent, '| danos', $('triCount').textContent, '| area', $('triArea').textContent);
  const rows = [...window.document.querySelectorAll('#tblBody tr')].map((r) => [...r.children].map((c) => c.textContent).join(' | '));
  rows.forEach((r) => console.log('   ', r));

  // alterna sobreposicoes e gera imagem do mapa
  $('tglTiles').checked = true; $('tglTiles').dispatchEvent(new window.Event('change'));
  $('tglSec').checked = true; $('tglSec').dispatchEvent(new window.Event('change'));
  $('alpha').value = '60'; $('alpha').dispatchEvent(new window.Event('input'));
  console.log('4. sobreposicao: slider visivel =', !$('alphaWrap').hidden);
  $('makeImg').click();
  console.log('   imagem do mapa:', $('mapImg').src.slice(0, 30), '... (' + Math.round($('mapImg').src.length / 1024) + ' kB)');
  fs.writeFileSync(path.join(OUT, 'mapa-teste.jpg'), Buffer.from($('mapImg').src.split(',')[1], 'base64'));

  // reanalisar com outra sensibilidade
  $('sCrack').value = '3'; $('sCrack').dispatchEvent(new window.Event('input'));
  $('reanalyze').click();
  await sleep(300); await waitFor(() => /analisada/.test($('refPill').textContent), 'reanalise');
  await sleep(3000);
  console.log('5. reanalise (sigma 3): danos', $('triCount').textContent);

  // relatorio
  $('copyJson').click(); await sleep(100);
  const jsonTxt = $('jsonFallback').value;
  const rep = JSON.parse(jsonTxt);
  console.log('6. relatorio JSON ok: danos =', rep.danos.length, '| triagem =', rep.triagem.level, '| chaves =', Object.keys(rep).join(','));
  console.log('\nERROS DE JS:', errors.length ? errors : 'nenhum');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('FALHA:', e.message); console.error(errors); process.exit(1); });
