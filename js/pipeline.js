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
      lossTileFrac: 0.12, // fracao minima de pixels de perda para o tile ser candidato
      // ---- modo "impresso / ilustracao" (detectPrint)
      printDarkThr: 18,        // contraste minimo da mancha escura em relacao ao entorno (0-255)
      printOpenFrac: 0.004,    // abertura que remove tracos finos do desenho (fracao do lado da obra)
      printBgFrac: 0.05,       // tamanho da mediana que estima a cor local (fracao do lado)
      printDetailMax: 0.36,    // regiao com mais detalhe impresso que isso e descartada (0-1)
      printDetailWin: 0.045,   // janela da medida de detalhe (fracao do lado)
      printEdgeGrad: 60,       // gradiente a partir do qual um pixel conta como contorno do desenho
      printMinArea: 30,        // area minima da mancha (px, na escala de 1280 px)
      printMaxAreaFrac: 0.0006,// area maxima (fracao da area da obra); acima disso e forma do desenho
      printMaxAspect: 5        // manchas muito alongadas sao tracos do desenho, nao manchas
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


    // ---------------------------------------------------------------- 2b'. deteccao para impresso / ilustracao
    /**
     * Para arte impressa (ilustracao, steelbook, poster), em que os contornos do desenho
     * parecem rachaduras e as areas claras parecem perda de cor.
     *  (1) descarta regioes com muito detalhe impresso: ali uma mancha pequena nao se
     *      distingue do proprio desenho;
     *  (2) nas regioes planas, procura manchas escuras compactas (ferrugem, tinta solta)
     *      que destoam do entorno, depois de remover os tracos finos por abertura morfologica.
     * opts.sideEff: lado (em px desta imagem) que corresponderia a obra inteira. Fotos de
     * detalhe passam um valor maior para usar os mesmos tamanhos fisicos da foto geral.
     */
    P.detectPrint = function (rgba, validMask, opts) {
      opts = opts || {};
      const t0 = now();
      const p = P.params;
      const W = rgba.cols, H = rgba.rows;
      const side = opts.sideEff || Math.max(W, H);
      const areaScale = (side / 1280) * (side / 1280);
      const garbage = [];
      const keep = (m) => { garbage.push(m); return m; };

      const gray = keep(new cv.Mat());
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);

      // cor local (mediana grande) e "escurecimento" em relacao a ela
      const bg = keep(new cv.Mat());
      cv.medianBlur(gray, bg, Math.min(255, odd(p.printBgFrac * side)));
      const dark = keep(new cv.Mat());
      cv.subtract(bg, gray, dark); // 8 bits satura em 0: so o que e mais escuro que o entorno

      // abertura: remove tracos mais finos que o nucleo (contornos do desenho)
      const kOpen = odd(Math.max(3, p.printOpenFrac * side));
      const kernel = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kOpen, kOpen)));
      const opened = keep(new cv.Mat());
      cv.morphologyEx(dark, opened, cv.MORPH_OPEN, kernel);
      const spots = keep(new cv.Mat());
      cv.threshold(opened, spots, p.printDarkThr, 255, cv.THRESH_BINARY);

      // densidade de detalhe impresso: fracao de pixels de contorno forte numa janela
      const sm = keep(new cv.Mat());
      cv.GaussianBlur(gray, sm, new cv.Size(0, 0), 1.2 * (side / 1280), 1.2 * (side / 1280));
      const gx = keep(new cv.Mat()), gy = keep(new cv.Mat()), mag = keep(new cv.Mat());
      cv.Sobel(sm, gx, cv.CV_32F, 1, 0); cv.Sobel(sm, gy, cv.CV_32F, 0, 1);
      cv.magnitude(gx, gy, mag);
      const strong32 = keep(new cv.Mat()), strong = keep(new cv.Mat());
      cv.threshold(mag, strong32, p.printEdgeGrad, 255, cv.THRESH_BINARY);
      strong32.convertTo(strong, cv.CV_8U);
      const win = odd(p.printDetailWin * side);
      const density = keep(new cv.Mat());
      cv.blur(strong, density, new cv.Size(win, win)); // 0..255 = 0..100% de pixels de contorno
      const flat = keep(new cv.Mat());
      cv.threshold(density, flat, p.printDetailMax * 255, 255, cv.THRESH_BINARY_INV);

      // regiao valida (recorte da obra / area alinhada), afastada das bordas para evitar efeito de borda
      const valid = keep(new cv.Mat());
      if (validMask) {
        const mg = odd(Math.max(3, 0.012 * side));
        const ek = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(mg, mg)));
        cv.erode(validMask, valid, ek);
      } else {
        valid.create(H, W, cv.CV_8UC1); valid.setTo(new cv.Scalar(255));
      }

      const analyzable = keep(new cv.Mat());
      cv.bitwise_and(flat, valid, analyzable);
      const cand = keep(new cv.Mat());
      cv.bitwise_and(spots, analyzable, cand);

      // quadrados de 32 px para exibir o que foi descartado
      const T = p.tile;
      const cols = Math.ceil(W / T), rows = Math.ceil(H / T);
      const tValid = keep(new cv.Mat()), tFlat = keep(new cv.Mat());
      cv.resize(valid, tValid, new cv.Size(cols, rows), 0, 0, cv.INTER_AREA);
      cv.resize(analyzable, tFlat, new cv.Size(cols, rows), 0, 0, cv.INTER_AREA);
      const tileKeep = new Uint8Array(cols * rows);
      let evaluated = 0, candidates = 0;
      for (let i = 0; i < cols * rows; i++) {
        if (tValid.data[i] < 200) continue; // quadrado fora da regiao valida
        evaluated++;
        if (tFlat.data[i] >= 128) { tileKeep[i] = 1; candidates++; }
      }
      const rejected = evaluated - candidates;

      // componentes conexos = manchas
      const labels = keep(new cv.Mat()), stats = keep(new cv.Mat()), cent = keep(new cv.Mat());
      const n = cv.connectedComponentsWithStats(cand, labels, stats, cent, 8);
      const minArea = Math.max(8, p.printMinArea * areaScale);
      const maxArea = p.printMaxAreaFrac * 0.75 * side * side;
      const accepted = new Uint8Array(n);
      const boxes = [];
      for (let i = 1; i < n; i++) {
        const w = stats.intAt(i, cv.CC_STAT_WIDTH), h = stats.intAt(i, cv.CC_STAT_HEIGHT), area = stats.intAt(i, cv.CC_STAT_AREA);
        if (area < minArea || area > maxArea) continue;
        const aspect = Math.max(w, h) / Math.max(1, Math.min(w, h));
        if (aspect > p.printMaxAspect) continue;
        accepted[i] = 1;
        boxes.push({ x: stats.intAt(i, cv.CC_STAT_LEFT), y: stats.intAt(i, cv.CC_STAT_TOP), w, h, area, type: 'mancha' });
      }
      const outMask = cv.Mat.zeros(H, W, cv.CV_8UC1);
      const lab = labels.data32S, od = outMask.data;
      for (let i = 0; i < lab.length; i++) if (lab[i] > 0 && accepted[lab[i]]) od[i] = 255;

      const damagePx = cv.countNonZero(outMask);
      const validPx = Math.max(1, cv.countNonZero(valid));
      garbage.forEach((m) => { try { m.delete(); } catch (e) { /* ja liberado */ } });

      return {
        boxes, mask: outMask,
        tiles: { cols, rows, size: T, keep: tileKeep, evaluated, candidates, rejected },
        stats: {
          width: W, height: H, mode: 'impresso', crackThr: null, damageFrac: damagePx / validPx,
          rejectedFrac: evaluated ? rejected / evaluated : 0,
          crackCount: 0, lossCount: 0, stainCount: boxes.length,
          ms: now() - t0
        }
      };
    };

    /** Escolhe o detector conforme o tipo de obra: 'pintura' (padrao) ou 'impresso'. */
    P.detect = function (rgba, validMask, opts) {
      opts = opts || {};
      if (opts.mode === 'impresso') return P.detectPrint(rgba, validMask, opts);
      return P.detectDamage(rgba, validMask);
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

    // ---------------------------------------------------------------- varias fotos: levar tudo para o quadro da referencia
    function applyH(Hm, x, y) {
      const w = Hm[6] * x + Hm[7] * y + Hm[8];
      return [(Hm[0] * x + Hm[1] * y + Hm[2]) / w, (Hm[3] * x + Hm[4] * y + Hm[5]) / w];
    }
    /** Escala media da homografia (pixel da foto -> pixel da referencia). Menor que 1 em foto de detalhe. */
    P.homographyScale = function (Hm) { return Math.sqrt(Math.abs(Hm[0] * Hm[4] - Hm[1] * Hm[3])); };

    /** Caixas da foto -> retangulos envolventes no quadro da referencia (H leva foto -> referencia). */
    P.mapBoxes = function (boxes, Hm, refW, refH) {
      const s2 = Math.abs(Hm[0] * Hm[4] - Hm[1] * Hm[3]);
      const out = [];
      boxes.forEach((b) => {
        const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map((q) => applyH(Hm, q[0], q[1]));
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        const cx = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2, cy = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2;
        if (cx < 0 || cy < 0 || cx > refW || cy > refH) return; // centro fora do quadro da referencia
        const x0 = Math.max(0, Math.floor(Math.min.apply(null, xs))), y0 = Math.max(0, Math.floor(Math.min.apply(null, ys)));
        const x1 = Math.min(refW, Math.ceil(Math.max.apply(null, xs))), y1 = Math.min(refH, Math.ceil(Math.max.apply(null, ys)));
        if (x1 - x0 < 2 || y1 - y0 < 2) return;
        out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, area: b.area * s2, type: b.type, score: b.score });
      });
      return out;
    };

    /** Mascara da foto -> mascara no quadro da referencia. Quem chama libera o resultado. */
    P.warpMask = function (mask, Hm, refW, refH) {
      const M = cv.matFromArray(3, 3, cv.CV_64F, Hm);
      const dst = new cv.Mat();
      cv.warpPerspective(mask, dst, M, new cv.Size(refW, refH), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
      M.delete();
      return dst;
    };

    /** Recorte da referencia (255 = dentro) -> mesmo recorte no quadro da foto. Quem chama libera o resultado. */
    P.warpMaskToShot = function (refMask, Hm, shotW, shotH) {
      const M = cv.matFromArray(3, 3, cv.CV_64F, Hm);
      const dst = new cv.Mat();
      cv.warpPerspective(refMask, dst, M, new cv.Size(shotW, shotH), cv.INTER_NEAREST | cv.WARP_INVERSE_MAP, cv.BORDER_CONSTANT, new cv.Scalar(0));
      M.delete();
      return dst;
    };

    /**
     * Junta os danos da referencia com os de qualquer numero de fotos adicionais.
     * shots: [{ label: 'luz normal' | 'luz rasante', boxes: [...] }] com caixas ja no quadro da referencia.
     * Cada entrada diz em quais capturas o dano apareceu (confirmacao cruzada).
     */
    P.mergeAll = function (refBoxes, shots, W, H) {
      const entries = refBoxes.map((b) => ({ ...b, sources: ['luz normal'], seenIn: 1, motores: ['classico'] }));
      shots.forEach((sh) => {
        sh.boxes.forEach((b) => {
          let match = -1, best = 0.05;
          entries.forEach((e, j) => { const v = iou(e, b); if (v > best) { best = v; match = j; } });
          if (match >= 0) {
            const e = entries[match];
            if (e.sources.indexOf(sh.label) < 0) e.sources.push(sh.label);
            e.seenIn++;
          } else entries.push({ ...b, sources: [sh.label], seenIn: 1, motores: ['classico'] });
        });
      });
      numerar(entries, W, H);
      return entries;
    };

    function numerar(entries, W, H) {
      entries.forEach((e, idx) => {
        e.id = idx + 1;
        e.cx = (e.x + e.w / 2) / W; e.cy = (e.y + e.h / 2) / H; // coordenadas normalizadas na obra
      });
    }

    /**
     * Acrescenta as caixas do modelo treinado (YOLO) as entradas ja unidas do detector classico.
     * groups: [{ label: 'luz normal' | 'luz rasante', boxes: [{ x, y, w, h, area, score }] }], caixas no quadro da referencia.
     * Caixa que cai em cima de uma entrada existente (IoU > 0,05) so marca que o modelo tambem viu aquilo;
     * as demais viram entradas novas do tipo 'avaria (modelo)'. Cada entrada traz em 'motores' quem a achou.
     * Muda 'entries' no lugar e devolve a mesma lista.
     */
    P.addModelBoxes = function (entries, groups, W, H) {
      entries.forEach((e) => { if (!e.motores) e.motores = ['classico']; });
      groups.forEach((g) => {
        g.boxes.forEach((b) => {
          let match = -1, best = 0.05;
          entries.forEach((e, j) => { const v = iou(e, b); if (v > best) { best = v; match = j; } });
          if (match >= 0) {
            const e = entries[match];
            if (e.motores.indexOf('modelo') < 0) e.motores.push('modelo');
            if (e.sources.indexOf(g.label) < 0) e.sources.push(g.label);
            e.scoreModelo = Math.max(e.scoreModelo || 0, b.score || 0);
          } else entries.push({ ...b, type: 'avaria (modelo)', sources: [g.label], seenIn: 1, motores: ['modelo'], scoreModelo: b.score || 0 });
        });
      });
      numerar(entries, W, H);
      return entries;
    };

    /** Prioridade de inspecao (heuristica, limiares ajustaveis). Em 'impresso' conta so as manchas. */
    P.triage = function (damageFrac, nEntries, mode) {
      let level = 'baixa';
      if (mode === 'impresso') {
        if (nEntries >= 25 || damageFrac >= 0.01) level = 'alta';
        else if (nEntries >= 10 || damageFrac >= 0.003) level = 'media';
      } else if (damageFrac >= 0.01 || nEntries >= 8) level = 'alta';
      else if (damageFrac >= 0.002 || nEntries >= 3) level = 'media';
      return { level, damageFrac, nEntries, mode: mode || 'pintura' };
    };

    return P;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = createPipeline;
  else root.createPipeline = createPipeline;
})(typeof window !== 'undefined' ? window : globalThis);
