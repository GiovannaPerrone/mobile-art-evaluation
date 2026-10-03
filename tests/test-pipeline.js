let cv_ref;
const raw = require('@techstark/opencv-js');
const createPipeline = require('../js/pipeline.js');

function loadCV(raw) {
  return new Promise((resolve) => {
    if (raw.Mat) return resolve(raw);
    if (typeof raw.then === 'function') raw.then((m) => resolve(m || raw));
    else raw.onRuntimeInitialized = () => resolve(raw);
  });
}

// RNG deterministico
let seed = 12345;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

(async () => {
  const cv = await loadCV(raw); cv_ref = cv;
  const P = createPipeline(cv);
  const W = 1280, H = 960;

  // ---- pintura sintetica: fundo texturizado + formas coloridas -------------
  const base = new cv.Mat(H, W, cv.CV_8UC3, new cv.Scalar(150, 120, 90));
  const noise = new cv.Mat(H, W, cv.CV_8UC3);
  cv.randn(noise, cv.matFromArray(3, 1, cv.CV_64F, [128, 128, 128]), cv.matFromArray(3, 1, cv.CV_64F, [10, 10, 10]));
  const noiseS = new cv.Mat(); cv.GaussianBlur(noise, noiseS, new cv.Size(0, 0), 1.2);
  const tmp = new cv.Mat();
  base.convertTo(tmp, cv.CV_16SC3); noiseS.convertTo(noiseS, cv.CV_16SC3);
  cv.add(tmp, noiseS, tmp); cv.subtract(tmp, new cv.Mat(H, W, cv.CV_16SC3, new cv.Scalar(128, 128, 128, 0)), tmp); tmp.convertTo(base, cv.CV_8UC3);
  for (let i = 0; i < 70; i++) {
    const col = new cv.Scalar(60 + rnd() * 160, 60 + rnd() * 160, 40 + rnd() * 160);
    if (rnd() < 0.5) cv.circle(base, new cv.Point(rnd() * W, rnd() * H), 15 + rnd() * 50, col, -1);
    else cv.rectangle(base, new cv.Point(rnd() * W, rnd() * H), new cv.Point(rnd() * W, rnd() * H), col, -1);
  }
  cv.GaussianBlur(base, base, new cv.Size(3, 3), 0);

  // ---- danos conhecidos (verdade de campo) ----------------------------------
  const truth = [];
  const cracks = [
    [[200, 150], [260, 190], [300, 260], [380, 300], [420, 380]],
    [[800, 600], [860, 640], [900, 720], [990, 760]],
    [[300, 700], [380, 690], [460, 720], [540, 700], [600, 740]]
  ];
  cracks.forEach((pts) => {
    for (let i = 0; i < pts.length - 1; i++) cv.line(base, new cv.Point(...pts[i]), new cv.Point(...pts[i + 1]), new cv.Scalar(25, 20, 18), 2);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    truth.push({ type: 'rachadura', x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
  });
  // perda de cor: mancha clara (camada de preparo aparecendo)
  cv.ellipse(base, new cv.Point(1000, 220), new cv.Size(55, 40), 20, 0, 360, new cv.Scalar(235, 228, 215), -1);
  truth.push({ type: 'perda de cor', x: 945, y: 180, w: 110, h: 80 });

  const ref = new cv.Mat(); cv.cvtColor(base, ref, cv.COLOR_RGB2RGBA);

  // ---- 2a captura: rotacionada/escalada/deslocada + luz diferente -----------
  const M = cv.getRotationMatrix2D(new cv.Point(W / 2, H / 2), 4, 0.96);
  M.data64F[2] += 18; M.data64F[5] -= 12;
  const sec = new cv.Mat();
  cv.warpAffine(ref, sec, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 255));
  sec.convertTo(sec, -1, 0.85, -10); // mais escura, como luz rasante

  // ---- 1. iluminacao -------------------------------------------------------
  const ill = P.checkIllumination(ref);
  console.log('ILUMINACAO ref:', ill.ok, ill.reason, '| L=', ill.meanL.toFixed(1), 'clip=', ill.clipFrac.toFixed(4), 'dark=', ill.darkFrac.toFixed(4));
  const dark = new cv.Mat(); ref.convertTo(dark, -1, 0.3, 0);
  const illDark = P.checkIllumination(dark);
  console.log('ILUMINACAO escura (deve rejeitar):', illDark.ok, '-', illDark.reason);
  const bright = new cv.Mat(); ref.convertTo(bright, -1, 1.0, 115);
  const illBright = P.checkIllumination(bright);
  console.log('ILUMINACAO clara (deve rejeitar):', illBright.ok, '-', illBright.reason);

  // ---- 2. deteccao -----------------------------------------------------------
  const det = P.detectDamage(ref);
  console.log('\nDETECCAO ref: ', JSON.stringify(det.stats));
  console.log('tiles:', det.tiles.evaluated, 'avaliados,', det.tiles.candidates, 'candidatos,', det.tiles.rejected, 'rejeitados');
  det.boxes.forEach((b) => console.log('  ', b.type.padEnd(13), `x=${b.x} y=${b.y} w=${b.w} h=${b.h} area=${b.area}`));

  // verdade de campo: cada dano conhecido foi detectado?
  function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / (a.w * a.h + b.w * b.h - inter);
  }
  let hit = 0;
  truth.forEach((t) => {
    const best = Math.max(0, ...det.boxes.filter((b) => b.type === t.type).map((b) => iou(t, b)));
    const ok = best > 0.3; if (ok) hit++;
    console.log('  verdade', t.type.padEnd(13), 'melhor IoU =', best.toFixed(2), ok ? 'OK' : 'FALHOU');
  });
  const falsePos = det.boxes.filter((b) => !truth.some((t) => t.type === b.type && iou(t, b) > 0.1)).length;
  console.log(`RESUMO: recall ${hit}/${truth.length}, falsos positivos ${falsePos}`);

  // ---- 3. ORB + Condition Map ------------------------------------------------
  const reg = P.registerCaptures(ref, sec);
  console.log('\nORB: ok=', reg.ok, '| kp ref/sec =', reg.kpRef, '/', reg.kpSec, '| bons =', reg.good, '| inliers =', reg.inliers, '| ms =', reg.ms.toFixed(0), '|', reg.reason);
  if (reg.ok) {
    const secDet = P.detectDamage(reg.warped, reg.valid);
    console.log('DETECCAO sec alinhada:', JSON.stringify(secDet.stats));
    const merged = P.mergeDetections(det, secDet, W, H);
    merged.forEach((e) => console.log('  #' + e.id, e.type.padEnd(13), e.sources.join(' + ')));
    const tri = P.triage(Math.max(det.stats.damageFrac, secDet.stats.damageFrac), merged.length);
    console.log('TRIAGEM:', JSON.stringify(tri));
    // erro de registro: compara H estimada com a verdadeira (inversa de M)
    const Minv = new cv.Mat(); cv.invertAffineTransform(M, Minv);
    const pts = [[100, 100], [1100, 100], [640, 480], [200, 850], [1150, 850]];
    let errMax = 0;
    pts.forEach(([x, y]) => {
      const h = reg.H; const d = h[6] * x + h[7] * y + h[8];
      const ex = (h[0] * x + h[1] * y + h[2]) / d, ey = (h[3] * x + h[4] * y + h[5]) / d;
      const tx = Minv.data64F[0] * x + Minv.data64F[1] * y + Minv.data64F[2], ty = Minv.data64F[3] * x + Minv.data64F[4] * y + Minv.data64F[5];
      errMax = Math.max(errMax, Math.hypot(ex - tx, ey - ty));
    });
    console.log('Erro maximo de registro nos pontos de teste:', errMax.toFixed(2), 'px');
  }
  process.exit(0);
})().catch((e) => { console.error("ERRO", typeof e === "number" && cv_ref && cv_ref.exceptionFromPtr ? cv_ref.exceptionFromPtr(e).msg : e, e && e.stack); process.exit(1); });
