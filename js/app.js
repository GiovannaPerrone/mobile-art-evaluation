(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var MAXSIDE = 1280;
  var ENGINE_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@5.0.0-release.1/dist/opencv.js';

  var S = {
    cv: null, P: null,
    ref: null,   // { mat, canvas, meta, ill, det, ms }
    sec: null,   // { mat, meta, reg, det, warpedCanvas }
    merged: null, triage: null,
    view: { damage: true, tiles: false, sec: false, alpha: 0.5 },
    forced: false, busy: false, times: {}
  };

  // ------------------------------------------------------------ utilidades
  function fmtBytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.round(n / 1024) + ' kB'; }
  function pct(x, d) { return (x * 100).toFixed(d == null ? 1 : d).replace('.', ',') + '%'; }
  function ms(x) { return x >= 1000 ? (x / 1000).toFixed(1).replace('.', ',') + ' s' : Math.round(x) + ' ms'; }
  function tick() { return new Promise(function (r) { setTimeout(r, 40); }); }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function setPill(el, cls, text) { el.className = 'pill ' + cls; el.textContent = text; }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function engineState(state, text) { $('engine').dataset.state = state; $('engineText').textContent = text; }
  function enableCapture(enabled) {
    ['refCamBtn', 'refFileBtn'].forEach(function (id) { $(id).setAttribute('aria-disabled', enabled ? 'false' : 'true'); });
    $('refCam').disabled = !enabled; $('refFile').disabled = !enabled;
  }
  function enableSecond(enabled) {
    ['secCamBtn', 'secFileBtn'].forEach(function (id) { $(id).setAttribute('aria-disabled', enabled ? 'false' : 'true'); });
    $('secCam').disabled = !enabled; $('secFile').disabled = !enabled;
  }

  // ------------------------------------------------------------ motor (OpenCV.js)
  function getCV(raw) {
    return new Promise(function (resolve) {
      if (raw.Mat) return resolve({ cv: raw });
      if (typeof raw.then === 'function') raw.then(function (m) { resolve({ cv: m || raw }); });
      else raw.onRuntimeInitialized = function () { resolve({ cv: raw }); };
    });
  }
  function loadEngine() {
    var t0 = performance.now();
    var s = document.createElement('script');
    s.src = ENGINE_URL; s.async = true;
    s.onload = function () {
      getCV(window.cv).then(function (o) {
        S.cv = o.cv; S.P = window.createPipeline(S.cv);
        S.times.engineLoad = performance.now() - t0;
        engineState('ready', 'Motor pronto · ' + ms(S.times.engineLoad));
        enableCapture(true);
        initIllumination();
        $('sCrackVal').textContent = S.P.params.crackSigma.toFixed(1).replace('.', ',') + ' desvios';
        $('sLossVal').textContent = String(S.P.params.lossThr);
      });
    };
    s.onerror = function () {
      engineState('error', 'Motor não carregou. Verifique a conexão e recarregue');
    };
    document.head.appendChild(s);
  }

  // ------------------------------------------------------------ leitura de imagem
  function readImage(file) {
    return new Promise(function (resolve, reject) {
      var done = function (src, w, h, revoke) {
        var scale = Math.min(1, MAXSIDE / Math.max(w, h));
        var cw = Math.round(w * scale), ch = Math.round(h * scale);
        var c = document.createElement('canvas'); c.width = cw; c.height = ch;
        var ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(src, 0, 0, cw, ch);
        if (revoke) revoke();
        resolve({ canvas: c, meta: { name: file.name, bytes: file.size, origW: w, origH: h, procW: cw, procH: ch } });
      };
      if (window.createImageBitmap) {
        createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
          done(bmp, bmp.width, bmp.height, function () { if (bmp.close) bmp.close(); });
        }).catch(function () { viaImg(); });
      } else viaImg();
      function viaImg() {
        var url = URL.createObjectURL(file), img = new Image();
        img.onload = function () { done(img, img.naturalWidth, img.naturalHeight, function () { URL.revokeObjectURL(url); }); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Não foi possível abrir a imagem')); };
        img.src = url;
      }
    });
  }
  function canvasToMat(canvas) {
    var d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    return S.cv.matFromImageData(d);
  }
  function matToCanvas(mat) {
    var c = document.createElement('canvas'); c.width = mat.cols; c.height = mat.rows;
    var id = new ImageData(new Uint8ClampedArray(mat.data), mat.cols, mat.rows);
    c.getContext('2d').putImageData(id, 0, 0);
    return c;
  }

  // ------------------------------------------------------------ iluminacao (UI)
  function initIllumination() {
    var p = S.P.params;
    $('illBand').style.left = (p.lumMin / 255 * 100) + '%';
    $('illBand').style.width = ((p.lumMax - p.lumMin) / 255 * 100) + '%';
    $('illRange').textContent = p.lumMin + '–' + p.lumMax;
  }
  function showIllumination(ill) {
    $('illVal').textContent = ill.meanL.toFixed(0) + ' / 255';
    $('illNeedle').style.left = (ill.meanL / 255 * 100) + '%';
    $('illClip').textContent = pct(ill.clipFrac, 2);
    $('illDark').textContent = pct(ill.darkFrac, 1);
    $('illMsg').textContent = ill.reason;
    setPill($('illPill'), ill.ok ? 'ok' : 'crit', ill.ok ? 'adequada' : 'rejeitada');
  }

  // ------------------------------------------------------------ captura de referencia
  function freeMat(m) { try { if (m && m.delete) m.delete(); } catch (e) { /* ja liberado */ } }
  function resetSecond() {
    if (S.sec) { freeMat(S.sec.mat); if (S.sec.reg) { freeMat(S.sec.reg.warped); freeMat(S.sec.reg.valid); } if (S.sec.det) freeMat(S.sec.det.mask); }
    S.sec = null; S.view.sec = false;
    $('tglSec').checked = false; $('tglSec').disabled = true; $('alphaWrap').hidden = true;
    setPill($('secPill'), 'idle', 'opcional'); $('secStatus').textContent = '';
  }
  function resetReference() {
    resetSecond();
    if (S.ref) { freeMat(S.ref.mat); if (S.ref.det) freeMat(S.ref.det.mask); }
    S.ref = null; S.forced = false; S.merged = null; S.triage = null;
    enableSecond(false); $('overrideRow').hidden = true; $('copyJson').disabled = true; $('reanalyze').disabled = true;
  }

  async function onReference(file) {
    if (!file || !S.cv || S.busy) return;
    S.busy = true;
    try {
      resetReference();
      setPill($('refPill'), 'warn', 'lendo imagem');
      $('refStatus').textContent = 'Lendo a foto...';
      await tick();
      var img = await readImage(file);
      var t0 = performance.now();
      var mat = canvasToMat(img.canvas);
      S.ref = { mat: mat, canvas: img.canvas, meta: img.meta, ill: null, det: null };
      var ill = S.P.checkIllumination(mat);
      S.times.illumination = performance.now() - t0;
      S.ref.ill = ill;
      showIllumination(ill);
      drawView();
      $('refStatus').textContent = 'Original ' + img.meta.origW + ' × ' + img.meta.origH + ' px (' + fmtBytes(img.meta.bytes) + '), processada em ' + img.meta.procW + ' × ' + img.meta.procH + ' px.';
      if (!ill.ok) {
        setPill($('refPill'), 'crit', 'captura rejeitada');
        $('overrideRow').hidden = false;
        renderTriage();
        return;
      }
      await analyzeReference();
    } catch (e) {
      $('refStatus').textContent = 'Erro ao ler a foto: ' + errText(e);
      setPill($('refPill'), 'crit', 'erro');
    } finally { S.busy = false; }
  }

  function errText(e) {
    if (typeof e === 'number' && S.cv && S.cv.exceptionFromPtr) { try { return S.cv.exceptionFromPtr(e).msg; } catch (x) { /* segue */ } }
    return (e && e.message) ? e.message : String(e);
  }

  async function analyzeReference() {
    setPill($('refPill'), 'warn', 'analisando');
    $('refStatus').textContent = 'Rejeitando regiões sem dano e detectando candidatos...';
    await tick();
    if (S.ref.det) freeMat(S.ref.det.mask);
    S.ref.det = S.P.detectDamage(S.ref.mat);
    S.times.detectRef = S.ref.det.stats.ms;
    setPill($('refPill'), 'ok', 'analisada');
    $('refStatus').textContent = S.ref.meta.origW + ' × ' + S.ref.meta.origH + ' px (' + fmtBytes(S.ref.meta.bytes) + '), processada em ' + S.ref.meta.procW + ' × ' + S.ref.meta.procH + ' px.';
    $('overrideRow').hidden = true;
    enableSecond(true); $('reanalyze').disabled = false; $('copyJson').disabled = false;
    if (S.sec && S.sec.reg && S.sec.reg.ok) await analyzeSecondDetect();
    rebuildMerged();
    drawView(); renderTriage();
  }

  // ------------------------------------------------------------ segunda captura
  async function onSecond(file) {
    if (!file || !S.cv || !S.ref || !S.ref.det || S.busy) return;
    S.busy = true;
    try {
      resetSecond();
      if (S.ref.det) rebuildMerged();
      setPill($('secPill'), 'warn', 'lendo imagem');
      $('secStatus').textContent = 'Lendo a foto...';
      await tick();
      var img = await readImage(file);
      var mat = canvasToMat(img.canvas);
      S.sec = { mat: mat, meta: img.meta, reg: null, det: null, warpedCanvas: null };
      setPill($('secPill'), 'warn', 'alinhando');
      $('secStatus').textContent = 'Alinhando por pontos de interesse (ORB)...';
      await tick();
      var reg = S.P.registerCaptures(S.ref.mat, mat);
      S.sec.reg = reg; S.times.orb = reg.ms;
      if (!reg.ok) {
        setPill($('secPill'), 'crit', 'não alinhou');
        $('secStatus').textContent = reg.reason + '.';
        drawView(); renderTriage();
        return;
      }
      await analyzeSecondDetect();
      rebuildMerged();
      $('tglSec').disabled = false;
      setPill($('secPill'), 'ok', 'alinhada');
      $('secStatus').textContent = reg.inliers + ' pontos concordantes de ' + reg.good + ' correspondências. Alinhamento em ' + ms(reg.ms) + '.';
      drawView(); renderTriage();
    } catch (e) {
      $('secStatus').textContent = 'Erro na segunda captura: ' + errText(e);
      setPill($('secPill'), 'crit', 'erro');
    } finally { S.busy = false; }
  }

  async function analyzeSecondDetect() {
    $('secStatus').textContent = 'Detectando danos na captura alinhada...';
    await tick();
    if (S.sec.det) freeMat(S.sec.det.mask);
    S.sec.det = S.P.detectDamage(S.sec.reg.warped, S.sec.reg.valid);
    S.times.detectSec = S.sec.det.stats.ms;
    S.sec.warpedCanvas = matToCanvas(S.sec.reg.warped);
  }

  function rebuildMerged() {
    var W = S.ref.canvas.width, H = S.ref.canvas.height;
    if (S.sec && S.sec.det) S.merged = S.P.mergeDetections(S.ref.det, S.sec.det, W, H);
    else S.merged = S.ref.det.boxes.map(function (b, i) {
      return Object.assign({}, b, { id: i + 1, sources: ['luz normal'], cx: (b.x + b.w / 2) / W, cy: (b.y + b.h / 2) / H });
    });
    var frac = S.ref.det.stats.damageFrac;
    if (S.sec && S.sec.det) frac = Math.max(frac, S.sec.det.stats.damageFrac);
    S.triage = S.P.triage(frac, S.merged.length);
  }

  // ------------------------------------------------------------ desenho
  function colorFor(e) {
    if (e.sources.length > 1) return css('--c-both');
    return e.sources[0] === 'luz normal' ? css('--c-normal') : css('--c-raking');
  }
  function tintMask(mask, rgb, alpha) {
    var c = document.createElement('canvas'); c.width = mask.cols; c.height = mask.rows;
    var ctx = c.getContext('2d'), id = ctx.createImageData(mask.cols, mask.rows), d = id.data, m = mask.data;
    for (var i = 0, n = m.length; i < n; i++) if (m[i]) { var j = i * 4; d[j] = rgb[0]; d[j + 1] = rgb[1]; d[j + 2] = rgb[2]; d[j + 3] = alpha; }
    ctx.putImageData(id, 0, 0); return c;
  }

  function paintTo(ctx, W, H, opts) {
    ctx.drawImage(S.ref.canvas, 0, 0, W, H);
    if (opts.sec && S.sec && S.sec.warpedCanvas) {
      ctx.globalAlpha = opts.alpha; ctx.drawImage(S.sec.warpedCanvas, 0, 0, W, H); ctx.globalAlpha = 1;
    }
    var det = S.ref.det;
    if (opts.tiles && det) {
      var t = det.tiles; ctx.fillStyle = 'rgba(10,14,13,0.55)';
      for (var r = 0; r < t.rows; r++) for (var c = 0; c < t.cols; c++) {
        if (!t.keep[r * t.cols + c]) ctx.fillRect(c * t.size, r * t.size, t.size, t.size);
      }
    }
    if (opts.damage && det) {
      ctx.drawImage(tintMask(det.mask, [255, 75, 51], 110), 0, 0);
      if (S.sec && S.sec.det) ctx.drawImage(tintMask(S.sec.det.mask, [31, 209, 255], 90), 0, 0);
      var lw = Math.max(2, W / 450);
      ctx.font = '600 ' + Math.max(13, Math.round(W / 55)) + 'px ' + css('--font-data');
      ctx.textBaseline = 'top';
      (S.merged || []).forEach(function (e) {
        var pad = lw * 2, x = e.x - pad, y = e.y - pad, w = e.w + pad * 2, h = e.h + pad * 2;
        ctx.lineWidth = lw + 3; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.strokeRect(x, y, w, h);
        ctx.lineWidth = lw; ctx.strokeStyle = colorFor(e); ctx.strokeRect(x, y, w, h);
        var label = '#' + e.id + ' ' + (e.type === 'rachadura' ? 'R' : 'C');
        var tw = ctx.measureText(label).width + 8, th = Math.max(13, Math.round(W / 55)) + 6;
        var ly = y - th >= 0 ? y - th : y, lx = Math.max(0, Math.min(x, W - tw));
        ctx.fillStyle = colorFor(e); ctx.fillRect(lx, ly, tw, th);
        ctx.fillStyle = '#111'; ctx.fillText(label, lx + 4, ly + 3);
      });
    }
  }

  function drawView() {
    var stage = $('stage');
    if (!S.ref) return;
    var cv0 = stage.querySelector('canvas');
    if (!cv0) { stage.textContent = ''; cv0 = document.createElement('canvas'); cv0.setAttribute('role', 'img'); cv0.setAttribute('aria-label', 'Imagem analisada com danos marcados'); stage.appendChild(cv0); }
    var W = S.ref.canvas.width, H = S.ref.canvas.height;
    cv0.width = W; cv0.height = H;
    var hasDet = !!S.ref.det;
    paintTo(cv0.getContext('2d'), W, H, { damage: hasDet && S.view.damage, tiles: hasDet && S.view.tiles, sec: S.view.sec, alpha: S.view.alpha });
    $('chips').hidden = false; $('legend').hidden = !hasDet; $('mapBtnRow').hidden = !hasDet;
    $('tglDamage').disabled = !hasDet; $('tglTiles').disabled = !hasDet;
    $('alphaWrap').hidden = !(S.view.sec && S.sec && S.sec.warpedCanvas);
    $('viewInfo').textContent = W + ' × ' + H + ' px';
  }

  // ------------------------------------------------------------ triagem e metricas
  function renderTriage() {
    var det = S.ref && S.ref.det;
    var tr = $('triage');
    if (!det || !S.merged || !S.triage) {
      tr.dataset.level = ''; $('triLevel').textContent = '--';
      ['triCount', 'triArea', 'triRej', 'triMs'].forEach(function (id) { $(id).textContent = '--'; });
      $('tblWrap').hidden = true; renderKV(); return;
    }
    tr.dataset.level = S.triage.level;
    $('triLevel').textContent = S.triage.level === 'media' ? 'média' : S.triage.level;
    $('triCount').textContent = String(S.merged.length);
    $('triArea').textContent = pct(S.triage.damageFrac, 2);
    $('triRej').textContent = pct(det.stats.rejectedFrac, 0);
    var total = det.stats.ms + (S.sec && S.sec.det ? S.sec.det.stats.ms + (S.sec.reg ? S.sec.reg.ms : 0) : 0);
    $('triMs').textContent = ms(total);

    var tb = $('tblBody'); tb.textContent = '';
    S.merged.forEach(function (e) {
      var row = document.createElement('tr');
      var td = function (txt, cls) { var c = document.createElement('td'); c.textContent = txt; if (cls) c.className = cls; row.appendChild(c); return c; };
      td('#' + e.id, 'num');
      var tcell = td('');
      var dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = colorFor(e);
      tcell.appendChild(dot); tcell.appendChild(document.createTextNode(e.type));
      td((e.cx * 100).toFixed(0) + '%, ' + (e.cy * 100).toFixed(0) + '%', 'num');
      td(e.sources.length > 1 ? 'duas capturas' : e.sources[0]);
      tb.appendChild(row);
    });
    $('tblWrap').hidden = S.merged.length === 0;
    renderKV();
  }

  function deviceLabel() {
    var ua = navigator.userAgent || '';
    var m = ua.match(/\(([^)]+)\)/);
    return m ? m[1] : ua.slice(0, 60);
  }

  function renderKV() {
    var rows = [['Dispositivo', deviceLabel()]];
    if (S.times.engineLoad) rows.push(['Carga do motor', ms(S.times.engineLoad)]);
    if (S.ref) {
      var m = S.ref.meta;
      rows.push(['Original', m.origW + ' × ' + m.origH + ' px · ' + fmtBytes(m.bytes)]);
      rows.push(['Processada', m.procW + ' × ' + m.procH + ' px']);
      if (S.ref.ill) rows.push(['Luminância', S.ref.ill.meanL.toFixed(1)]);
      if (S.times.illumination != null) rows.push(['Tempo da iluminação', ms(S.times.illumination)]);
      if (S.ref.det) {
        var t = S.ref.det.tiles;
        rows.push(['Regiões avaliadas', t.evaluated + ' (' + t.rejected + ' descartadas)']);
        rows.push(['Limiar de rachadura', S.ref.det.stats.crackThr.toFixed(1)]);
        rows.push(['Tempo de detecção (ref.)', ms(S.ref.det.stats.ms)]);
      }
    }
    if (S.sec && S.sec.reg) {
      var r = S.sec.reg;
      rows.push(['2ª captura', S.sec.meta.origW + ' × ' + S.sec.meta.origH + ' px · ' + fmtBytes(S.sec.meta.bytes)]);
      rows.push(['Pontos ORB (ref. / 2ª)', r.kpRef + ' / ' + r.kpSec]);
      rows.push(['Correspondências / inliers', r.good + ' / ' + r.inliers]);
      rows.push(['Tempo do alinhamento', ms(r.ms)]);
      if (S.sec.det) rows.push(['Tempo de detecção (2ª)', ms(S.sec.det.stats.ms)]);
    }
    var kv = $('kv'); kv.textContent = '';
    rows.forEach(function (r) {
      var dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = r[0]; dd.textContent = r[1]; kv.appendChild(dt); kv.appendChild(dd);
    });
  }

  function buildReport() {
    var rep = {
      ferramenta: 'Triagem de Avarias (on-device, OpenCV.js)',
      data: new Date().toISOString(),
      dispositivo: navigator.userAgent,
      parametros: S.P.params,
      referencia: S.ref ? { meta: S.ref.meta, iluminacao: S.ref.ill, deteccao: S.ref.det ? S.ref.det.stats : null,
        regioes: S.ref.det ? { avaliadas: S.ref.det.tiles.evaluated, candidatas: S.ref.det.tiles.candidates, descartadas: S.ref.det.tiles.rejected } : null } : null,
      segundaCaptura: S.sec ? { meta: S.sec.meta,
        alinhamento: S.sec.reg ? { ok: S.sec.reg.ok, pontosRef: S.sec.reg.kpRef, pontosSec: S.sec.reg.kpSec, correspondencias: S.sec.reg.good, inliers: S.sec.reg.inliers, ms: S.sec.reg.ms, homografia: S.sec.reg.H } : null,
        deteccao: S.sec.det ? S.sec.det.stats : null } : null,
      danos: (S.merged || []).map(function (e) { return { id: e.id, tipo: e.type, x: e.x, y: e.y, largura: e.w, altura: e.h, centroNormalizado: [+e.cx.toFixed(4), +e.cy.toFixed(4)], vistoEm: e.sources }; }),
      triagem: S.triage,
      observacao: 'Ferramenta de triagem; nao substitui a analise do profissional.'
    };
    return JSON.stringify(rep, null, 2);
  }

  function copyReport() {
    var txt = buildReport(), fb = $('jsonFallback');
    var fallback = function () { fb.value = txt; fb.hidden = false; fb.focus(); fb.select(); toast('Selecione e copie o texto abaixo'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast('Relatório copiado'); }).catch(fallback);
    } else fallback();
  }

  function makeMapImage() {
    if (!S.ref || !S.ref.det) return;
    var W = S.ref.canvas.width, H = S.ref.canvas.height, bar = Math.round(H * 0.11);
    var c = document.createElement('canvas'); c.width = W; c.height = H + bar;
    var ctx = c.getContext('2d');
    paintTo(ctx, W, H, { damage: true, tiles: false, sec: false, alpha: 0 });
    ctx.fillStyle = '#101514'; ctx.fillRect(0, H, W, bar);
    var fs = Math.max(12, Math.round(bar * 0.26));
    ctx.font = '500 ' + fs + 'px ' + css('--font-data'); ctx.textBaseline = 'middle';
    var items = [[css('--c-both'), 'duas capturas'], [css('--c-normal'), 'só luz normal'], [css('--c-raking'), 'só 2ª captura']];
    var x = 14, y1 = H + bar * 0.3, y2 = H + bar * 0.74, sz = Math.round(fs * 0.9);
    items.forEach(function (it) {
      ctx.strokeStyle = it[0]; ctx.lineWidth = 3; ctx.strokeRect(x, y1 - sz / 2, sz, sz);
      ctx.fillStyle = '#e6eeec'; ctx.fillText(it[1], x + sz + 8, y1); x += sz + 8 + ctx.measureText(it[1]).width + 20;
    });
    var label = 'Prioridade de inspeção: ' + (S.triage.level === 'media' ? 'média' : S.triage.level) + '  ·  R rachadura  ·  C perda de cor';
    ctx.fillStyle = '#9db0ab'; ctx.fillText(label, 14, y2);
    $('mapImg').src = c.toDataURL('image/jpeg', 0.92);
    $('mapOut').hidden = false;
    if ($('mapOut').scrollIntoView) $('mapOut').scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------ eventos
  function bindFile(id, handler) {
    $(id).addEventListener('change', function (ev) { var f = ev.target.files && ev.target.files[0]; ev.target.value = ''; handler(f); });
  }
  bindFile('refCam', onReference); bindFile('refFile', onReference);
  bindFile('secCam', onSecond); bindFile('secFile', onSecond);

  $('override').addEventListener('click', async function () {
    if (S.busy || !S.ref) return; S.busy = true; S.forced = true;
    try { await analyzeReference(); } finally { S.busy = false; }
  });
  $('tglDamage').addEventListener('change', function (e) { S.view.damage = e.target.checked; drawView(); });
  $('tglTiles').addEventListener('change', function (e) { S.view.tiles = e.target.checked; drawView(); });
  $('tglSec').addEventListener('change', function (e) { S.view.sec = e.target.checked; drawView(); });
  $('alpha').addEventListener('input', function (e) { S.view.alpha = e.target.value / 100; $('alphaVal').textContent = e.target.value + '%'; drawView(); });
  $('sCrack').addEventListener('input', function (e) { S.P.params.crackSigma = parseFloat(e.target.value); $('sCrackVal').textContent = parseFloat(e.target.value).toFixed(1).replace('.', ',') + ' desvios'; });
  $('sLoss').addEventListener('input', function (e) { S.P.params.lossThr = parseFloat(e.target.value); $('sLossVal').textContent = e.target.value; });
  $('reanalyze').addEventListener('click', async function () {
    if (S.busy || !S.ref || !S.ref.det) return; S.busy = true;
    try { await analyzeReference(); toast('Análise atualizada'); } finally { S.busy = false; }
  });
  $('copyJson').addEventListener('click', copyReport);
  $('makeImg').addEventListener('click', makeMapImage);

  renderKV();
  loadEngine();
})();
