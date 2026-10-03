/*
 * Pipeline de triagem de avarias (on-device, OpenCV.js)
 * Funciona no navegador (window.createPipeline) e em Node (module.exports).
 *
 * Estagios:
 *   1. checkIllumination  - rejeita a captura se a iluminacao estiver fora da faixa
 *   2. detectDamage       - (a) rejeicao de tiles sem dano  (b) deteccao nos tiles candidatos
 *   3. buildConditionMap  - ORB + homografia alinha 2a captura (ex.: luz rasante) a referencia
 *                           e une as deteccoes num unico mapa
 */
(function (root) {
  function createPipeline(cv) {
    const P = {};

    P.params = {
      lumMin: 60,        // luminancia media minima (0-255)
      lumMax: 210,       // luminancia media maxima
      clipMax: 0.08,     // fracao maxima de pixels saturados (brilho especular / flash)
      darkMax: 0.35,     // fracao maxima de pixels muito escuros
      tile: 32,          // lado do tile da etapa de rejeicao (px)
      crackSigma: 4.0,   // limiar do black-hat = media + sigma * desvio
      crackMinThr: 14,
      crackMaxThr: 70,
      lossThr: 42,       // distancia (V,S) ao fundo local para perda de cor
      lossMinV: 150,     // prior: camada de preparo exposta e clara (V alto)
      lossMaxS: 90,      // ... e pouco saturada (S baixo)
      lossPosDV: 25,     // ... e mais clara que o fundo local (V - V_local)
      lossTileFrac: 0.12 // fracao minima de pixels de perda para o tile ser candidato
    };

    function odd(n) { n = Math.round(n); return n % 2 === 0 ? n + 1 : n; }
    function now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }

    // ---------------------------------------------------------------- 1. iluminacao
    P.checkIllumination = function (rgba) {
      const gray = new cv.Mat();
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      const total = gray.rows * gray.cols;
      const meanL = cv.mean(gray)[0];

      const hi = new cv.Mat();
      cv.threshold(gray, hi, 250, 255, cv.THRESH_BINARY);
      const clipFrac = cv.countNonZero(hi) / total;

      const lo = new cv.Mat();
      cv.threshold(gray, lo, 25, 255, cv.THRESH_BINARY_INV);
      const darkFrac = cv.countNonZero(lo) / total;

      gray.delete(); hi.delete(); lo.delete();

      const p = P.params;
      let ok = true, reason = 'Iluminacao adequada';
      if (meanL < p.lumMin) { ok = false; reason = 'Imagem escura demais: aumente a iluminacao do ambiente'; }
      else if (meanL > p.lumMax) { ok = false; reason = 'Imagem clara demais: reduza a luz ou afaste o flash'; }
      else if (clipFrac > p.clipMax) { ok = false; reason = 'Reflexo especular/saturacao excessiva: mude o angulo do aparelho'; }
      else if (darkFrac > p.darkMax) { ok = false; reason = 'Areas escuras demais: ilumine melhor a obra'; }
      return { ok, reason, meanL, clipFrac, darkFrac };
    };

    // ---------------------------------------------------------------- 2. deteccao
    /**
     * @param rgba      Mat RGBA da captura
     * @param validMask Mat 8UC1 opcional (255 = regiao valida), usada apos o alinhamento
     * @returns {boxes, mask, tiles, stats}; mask deve ser liberada por quem chamou (mask.delete())
     */
    P.detectDamage = function (rgba, validMask) {
      const t0 = now();
      const p = P.params;
      const W = rgba.cols, H = rgba.rows, side = Math.max(W, H);
      const garbage = [];
      const keep = (m) => { garbage.push(m); return m; };

      // ---- mapas "baratos" que alimentam a rejeicao -------------------------
      const gray = keep(new cv.Mat());
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      const blur = keep(new cv.Mat());
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

      // black-hat: realca estruturas escuras e finas (rachaduras / craquele)
      const k = odd(Math.max(9, 0.012 * side));
      const kernel = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
      const bh = keep(new cv.Mat());
      cv.morphologyEx(blur, bh, cv.MORPH_BLACKHAT, kernel);

      const meanStd = { m: new cv.Mat(), s: new cv.Mat() };
      if (validMask) cv.meanStdDev(bh, meanStd.m, meanStd.s, validMask); else cv.meanStdDev(bh, meanStd.m, meanStd.s);
      const bhMean = meanStd.m.doubleAt(0, 0), bhStd = meanStd.s.doubleAt(0, 0);
      meanStd.m.delete(); meanStd.s.delete();
      let crackThr = bhMean + p.crackSigma * bhStd;
      crackThr = Math.min(p.crackMaxThr, Math.max(p.crackMinThr, crackThr));
      const crackMap = keep(new cv.Mat());
      cv.threshold(bh, crackMap, crackThr, 255, cv.THRESH_BINARY);

      // perda de cor: distancia (V,S) ao fundo local, calculada em baixa resolucao
      const scale = 0.25;
      const small = keep(new cv.Mat());
      cv.resize(rgba, small, new cv.Size(Math.max(8, Math.round(W * scale)), Math.max(8, Math.round(H * scale))), 0, 0, cv.INTER_AREA);
      const rgb = keep(new cv.Mat());
      cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
      const hsv = keep(new cv.Mat());
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      const loc = keep(new cv.Mat());
      const mk = odd(Math.max(15, 0.035 * Math.max(small.cols, small.rows) * 4 / 4 * 3));
      cv.medianBlur(hsv, loc, Math.min(mk, 61));
      const chH = new cv.MatVector(), chL = new cv.MatVector();
      cv.split(hsv, chH); cv.split(loc, chL);
      const dV = keep(new cv.Mat()), dS = keep(new cv.Mat());
      cv.absdiff(chH.get(2), chL.get(2), dV);
      cv.absdiff(chH.get(1), chL.get(1), dS);
      chH.delete(); chL.delete();
      const dV32 = keep(new cv.Mat()), dS32 = keep(new cv.Mat()), dist32 = keep(new cv.Mat());
      dV.convertTo(dV32, cv.CV_32F); dS.convertTo(dS32, cv.CV_32F);
      cv.multiply(dV32, dV32, dV32); cv.multiply(dS32, dS32, dS32);
      cv.add(dV32, dS32, dist32); cv.sqrt(dist32, dist32);
      const lossSmall = keep(new cv.Mat());
      cv.threshold(dist32, lossSmall, p.lossThr, 255, cv.THRESH_BINARY);
      lossSmall.convertTo(lossSmall, cv.CV_8U);
      // prior de camada de preparo exposta: clara, pouco saturada e mais clara que o fundo local
      {
        const hs = new cv.MatVector(), ls = new cv.MatVector();
        cv.split(hsv, hs); cv.split(loc, ls);
        const vHi = new cv.Mat(), sLo = new cv.Mat(), vDiff = new cv.Mat(), vPos = new cv.Mat(), prior = new cv.Mat();
        cv.threshold(hs.get(2), vHi, p.lossMinV - 1, 255, cv.THRESH_BINARY);
        cv.threshold(hs.get(1), sLo, p.lossMaxS, 255, cv.THRESH_BINARY_INV);
        const v16 = new cv.Mat(), l16 = new cv.Mat();
        hs.get(2).convertTo(v16, cv.CV_16S); ls.get(2).convertTo(l16, cv.CV_16S);
        cv.subtract(v16, l16, vDiff);
        cv.threshold(vDiff, vPos, p.lossPosDV - 1, 255, cv.THRESH_BINARY);
        vPos.convertTo(vPos, cv.CV_8U);
        cv.bitwise_and(vHi, sLo, prior); cv.bitwise_and(prior, vPos, prior);
        cv.bitwise_and(lossSmall, prior, lossSmall);
        hs.delete(); ls.delete(); vHi.delete(); sLo.delete(); vDiff.delete(); vPos.delete(); prior.delete(); v16.delete(); l16.delete();
      }

      // ---- estagio A: rejeicao por tiles -----------------------------------
      const T = p.tile;
      const cols = Math.ceil(W / T), rows = Math.ceil(H / T);
      const tileKeep = new Uint8Array(cols * rows); // 1 = candidato
      const lossFull = keep(new cv.Mat());
      cv.resize(lossSmall, lossFull, new cv.Size(W, H), 0, 0, cv.INTER_NEAREST);
      let candidates = 0, evaluated = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * T, y = r * T, w = Math.min(T, W - x), h = Math.min(T, H - y);
          const rect = new cv.Rect(x, y, w, h);
          if (validMask) {
            const vm = validMask.roi(rect);
            const okFrac = cv.countNonZero(vm) / (w * h);
            vm.delete();
            if (okFrac < 0.9) continue; // tile fora da regiao alinhada
          }
          evaluated++;
          const cr = crackMap.roi(rect); const lo = lossFull.roi(rect);
          const crackPx = cv.countNonZero(cr);
          const lossFrac = cv.countNonZero(lo) / (w * h);
          cr.delete(); lo.delete();
          if (crackPx >= 6 || lossFrac >= p.lossTileFrac) { tileKeep[r * cols + c] = 1; candidates++; }
        }
      }
      const rejected = evaluated - candidates;

      // mascara de tiles candidatos
      const tileMask = keep(cv.Mat.zeros(H, W, cv.CV_8UC1));
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (!tileKeep[r * cols + c]) continue;
        const x = c * T, y = r * T;
        cv.rectangle(tileMask, new cv.Point(x, y), new cv.Point(Math.min(W, x + T) - 1, Math.min(H, y + T) - 1), new cv.Scalar(255), -1);
      }

      // ---- estagio B: deteccao apenas nos candidatos ------------------------
      const boxes = [];
      const outMask = cv.Mat.zeros(H, W, cv.CV_8UC1);

      // rachaduras
      const crackCand = keep(new cv.Mat());
      cv.bitwise_and(crackMap, tileMask, crackCand);
      const k3 = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3)));
      cv.morphologyEx(crackCand, crackCand, cv.MORPH_CLOSE, k3);
      collect(crackCand, 'rachadura', (st) => {
        const bw = st.w, bh2 = st.h, longSide = Math.max(bw, bh2), shortSide = Math.max(1, Math.min(bw, bh2));
        const fill = st.area / (bw * bh2);
        const minLong = Math.max(18, 0.02 * side);
        return longSide >= minLong && st.area >= 30 && (longSide / shortSide >= 3 || fill < 0.4);
      });

      // perda de cor
      const lossCand = keep(new cv.Mat());
      cv.bitwise_and(lossFull, tileMask, lossCand);
      const kOpen = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(odd(0.012 * side), odd(0.012 * side))));
      const kClose = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(odd(0.025 * side), odd(0.025 * side))));
      cv.morphologyEx(lossCand, lossCand, cv.MORPH_OPEN, kOpen);
      cv.morphologyEx(lossCand, lossCand, cv.MORPH_CLOSE, kClose);
      collect(lossCand, 'perda de cor', (st) => st.area >= 0.0004 * W * H && st.area <= 0.5 * W * H);

      function collect(bin, type, accept) {
        const labels = new cv.Mat(), stats = new cv.Mat(), cent = new cv.Mat();
        const n = cv.connectedComponentsWithStats(bin, labels, stats, cent, 8);
        for (let i = 1; i < n; i++) {
          const st = {
            x: stats.intAt(i, cv.CC_STAT_LEFT), y: stats.intAt(i, cv.CC_STAT_TOP),
            w: stats.intAt(i, cv.CC_STAT_WIDTH), h: stats.intAt(i, cv.CC_STAT_HEIGHT),
            area: stats.intAt(i, cv.CC_STAT_AREA)
          };
          if (!accept(st)) continue;
          if (validMask) {
            const vm = validMask.roi(new cv.Rect(st.x, st.y, st.w, st.h));
            const okFrac = cv.countNonZero(vm) / (st.w * st.h);
            vm.delete();
            if (okFrac < 0.8) continue;
          }
          boxes.push({ x: st.x, y: st.y, w: st.w, h: st.h, area: st.area, type });
          // pinta apenas o componente aceito na mascara de saida
          const roiBin = bin.roi(new cv.Rect(st.x, st.y, st.w, st.h));
          const roiLab = labels.roi(new cv.Rect(st.x, st.y, st.w, st.h));
          const comp = new cv.Mat();
          cv.compare(roiLab, new cv.Mat(st.h, st.w, cv.CV_32S, new cv.Scalar(i)), comp, cv.CMP_EQ);
          const dst = outMask.roi(new cv.Rect(st.x, st.y, st.w, st.h));
          cv.bitwise_or(dst, comp, dst);
          dst.delete(); comp.delete(); roiBin.delete(); roiLab.delete();
        }
        labels.delete(); stats.delete(); cent.delete();
      }

      garbage.forEach((m) => { try { m.delete(); } catch (e) { /* ja liberado */ } });

      const damagePx = cv.countNonZero(outMask);
      const validPx = validMask ? cv.countNonZero(validMask) : W * H;
      return {
        boxes, mask: outMask,
        tiles: { cols, rows, size: T, keep: tileKeep, evaluated, candidates, rejected },
        stats: {
          width: W, height: H, crackThr, damageFrac: damagePx / validPx,
          rejectedFrac: evaluated ? rejected / evaluated : 0,
          crackCount: boxes.filter((b) => b.type === 'rachadura').length,
          lossCount: boxes.filter((b) => b.type === 'perda de cor').length,
          ms: now() - t0
        }
      };
    };

    // ---------------------------------------------------------------- 3. ORB + Condition Map
    P.registerCaptures = function (refRGBA, secRGBA) {
      const t0 = now();
      const g1 = new cv.Mat(), g2 = new cv.Mat();
      cv.cvtColor(refRGBA, g1, cv.COLOR_RGBA2GRAY);
      cv.cvtColor(secRGBA, g2, cv.COLOR_RGBA2GRAY);
      cv.equalizeHist(g1, g1); cv.equalizeHist(g2, g2); // reduz a diferenca de iluminacao entre as capturas

      const orb = new cv.ORB(2000);
      const kp1 = new cv.KeyPointVector(), kp2 = new cv.KeyPointVector();
      const d1 = new cv.Mat(), d2 = new cv.Mat();
      orb.detectAndCompute(g1, new cv.Mat(), kp1, d1);
      orb.detectAndCompute(g2, new cv.Mat(), kp2, d2);

      const result = { ok: false, kpRef: kp1.size(), kpSec: kp2.size(), good: 0, inliers: 0, H: null, warped: null, valid: null, reason: '', ms: 0 };
      if (d1.rows < 8 || d2.rows < 8) {
        result.reason = 'Poucos pontos de interesse: a obra precisa ter textura visivel nas duas capturas';
        cleanup(); result.ms = now() - t0; return result;
      }

      const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
      const knn = new cv.DMatchVectorVector();
      bf.knnMatch(d2, d1, knn, 2); // sec -> ref
      const src = [], dst = [];
      for (let i = 0; i < knn.size(); i++) {
        const m = knn.get(i);
        if (m.size() < 2) continue;
        const a = m.get(0), b = m.get(1);
        if (a.distance < 0.75 * b.distance) {
          const p2 = kp2.get(a.queryIdx).pt, p1 = kp1.get(a.trainIdx).pt;
          src.push(p2.x, p2.y); dst.push(p1.x, p1.y);
        }
      }
      result.good = src.length / 2;
      if (result.good < 12) {
        result.reason = 'Correspondencias insuficientes (' + result.good + '): refaca a 2a captura enquadrando a mesma obra';
        bf.delete(); knn.delete(); cleanup(); result.ms = now() - t0; return result;
      }

      const srcM = cv.matFromArray(result.good, 1, cv.CV_32FC2, src);
      const dstM = cv.matFromArray(result.good, 1, cv.CV_32FC2, dst);
      const inl = new cv.Mat();
      const Hm = cv.findHomography(srcM, dstM, cv.RANSAC, 4.0, inl);
      result.inliers = Hm.empty() ? 0 : cv.countNonZero(inl);
      srcM.delete(); dstM.delete(); inl.delete(); bf.delete(); knn.delete();

      if (Hm.empty() || result.inliers < 10) {
        result.reason = 'Alinhamento nao confiavel (' + result.inliers + ' inliers)';
        Hm.delete(); cleanup(); result.ms = now() - t0; return result;
      }

      const warped = new cv.Mat();
      cv.warpPerspective(secRGBA, warped, Hm, new cv.Size(refRGBA.cols, refRGBA.rows), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
      const ones = cv.Mat.ones(secRGBA.rows, secRGBA.cols, cv.CV_8UC1);
      ones.convertTo(ones, cv.CV_8UC1, 255);
      const valid = new cv.Mat();
      cv.warpPerspective(ones, valid, Hm, new cv.Size(refRGBA.cols, refRGBA.rows), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
      const ek = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
      cv.erode(valid, valid, ek);
      ones.delete(); ek.delete();

      result.ok = true;
      result.H = Array.from(Hm.data64F);
      result.warped = warped; result.valid = valid;
      result.reason = 'Alinhamento ok';
      Hm.delete(); cleanup(); result.ms = now() - t0; return result;

      function cleanup() { g1.delete(); g2.delete(); d1.delete(); d2.delete(); kp1.delete(); kp2.delete(); orb.delete(); }
    };

    function iou(a, b) {
      const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
      const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
      const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      return inter / (a.w * a.h + b.w * b.h - inter || 1);
    }

    /**
     * Une as deteccoes da referencia e da captura alinhada num unico conjunto de entradas.
     * Cada entrada diz em quantas capturas o dano apareceu (confirmacao cruzada).
     */
    P.mergeDetections = function (refDet, secDet, W, H) {
      const entries = [];
      const used = new Set();
      refDet.boxes.forEach((b, i) => {
        let match = -1, best = 0.05;
        secDet.boxes.forEach((s, j) => {
          if (used.has(j)) return;
          const v = iou(b, s);
          if (v > best) { best = v; match = j; }
        });
        if (match >= 0) used.add(match);
        entries.push({ ...b, sources: match >= 0 ? ['luz normal', 'luz rasante'] : ['luz normal'] });
      });
      secDet.boxes.forEach((s, j) => { if (!used.has(j)) entries.push({ ...s, sources: ['luz rasante'] }); });
      entries.forEach((e, idx) => {
        e.id = idx + 1;
        e.cx = (e.x + e.w / 2) / W; e.cy = (e.y + e.h / 2) / H; // coordenadas normalizadas na obra
      });
      return entries;
    };

    /** Prioridade de inspecao (heuristica, limiares ajustaveis) */
    P.triage = function (damageFrac, nEntries) {
      let level = 'baixa';
      if (damageFrac >= 0.01 || nEntries >= 8) level = 'alta';
      else if (damageFrac >= 0.002 || nEntries >= 3) level = 'media';
      return { level, damageFrac, nEntries };
    };

    return P;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = createPipeline;
  else root.createPipeline = createPipeline;
})(typeof window !== 'undefined' ? window : globalThis);
