(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var MAXSIDE = 1280;
  var ENGINE_URL = 'vendor/opencv/opencv.js';
  var TYPE_LETTER = { 'rachadura': 'R', 'perda de cor': 'C', 'mancha': 'M', 'avaria (modelo)': 'A' };
  // Modelo treinado (YOLO, opcional): arquivo do repositorio e biblioteca de execucao no navegador
  var MODEL_URL = 'models/yolo-A-pinturas.onnx';
  var ORT_URL = 'vendor/ort/ort.wasm.min.js';
  var MODEL_SIDE = 2560;                     // escala em que o modelo foi treinado (lado maior)
  var vendorUrl = function (p) { try { return new URL(p, location.href).href; } catch (e) { return p; } };
  var barraProgresso = (function () {
  var box, bar, txt, t0 = 0;
  function criar() {
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#e6efe9;color:#1f3d33;font:13px system-ui,sans-serif';
    bar = document.createElement('div');
    bar.style.cssText = 'height:6px;width:0;background:#2e6b57;transition:width .2s';
    txt = document.createElement('div');
    txt.style.cssText = 'padding:4px 12px';
    box.appendChild(bar);
    box.appendChild(txt);
    document.body.appendChild(box);
  }
  function atualizar(rotulo, i, n) {
    if (!document.body || !n) return;
    if (!box) criar();
    if (!t0) t0 = performance.now();
    var pct = Math.min(100, Math.round(100 * i / n));
    var feitos = Math.max(i - 1, 0);
    var seg = (performance.now() - t0) / 1000;
    var resta = feitos > 0 ? Math.round(seg / feitos * (n - feitos)) : null;
    bar.style.width = pct + '%';
    txt.textContent = 'Lendo a ' + rotulo + ': ' + pct + '%' + (resta === null ? ' · calculando o tempo...' : ' · faltam cerca de ' + resta + ' s');
    box.style.display = 'block';
  }
  function fim() {
    t0 = 0;
    if (box) box.style.display = 'none';
  }
  return { atualizar: atualizar, fim: fim };
})();
function ligarExemplos() {
  var btn = document.getElementById('exemploBtn');
  var input = document.getElementById('refFile');
  if (!btn || !input) return;
  var fotos = ['exemplos/exemplo-1.jpg', 'exemplos/exemplo-2.jpg', 'exemplos/exemplo-3.jpg'];
  var atual = 0;
  btn.addEventListener('click', async function () {
    var caminho = fotos[atual];
    atual = (atual + 1) % fotos.length;
    var status = document.getElementById('refStatus');
    try {
      var resp = await fetch(caminho);
      if (!resp.ok) throw new Error('arquivo não encontrado');
      var blob = await resp.blob();
      var arquivo = new File([blob], caminho.split('/').pop(), { type: blob.type || 'image/jpeg' });
      var dt = new DataTransfer();
      dt.items.add(arquivo);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      if (status) status.textContent = 'Foto de exemplo ainda não foi adicionada (' + caminho + ').';
    }
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ligarExemplos);
else ligarExemplos();

  var S = {
    cv: null, P: null,
    mode: 'pintura',                       // 'pintura' | 'impresso'
    crop: { l: 0, t: 0, r: 0, b: 0 },      // % cortado de cada lado (recorte da peca)
    ref: null,                             // { mat, canvas, meta, ill, det }
    shots: [], nextShotId: 1,              // fotos adicionais (detalhes e/ou luz rasante)
    merged: null, triage: null,
    view: { damage: true, tiles: false, sec: false, alpha: 0.5 },
    forced: false, busy: false, times: {},
    // detectores: o modelo treinado (YOLO) e o detector principal em pintura; o classico e opcional (padrao em impresso)
    model: { on: true, M: null, state: 'idle', conf: 0.10, loadMs: 0, loading: null },
    classic: { on: false }
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
  function enableShots(enabled) {
    ['nrmCamBtn', 'nrmFileBtn', 'rakCamBtn', 'rakFileBtn'].forEach(function (id) { $(id).setAttribute('aria-disabled', enabled ? 'false' : 'true'); });
    ['nrmCam', 'nrmFile', 'rakCam', 'rakFile'].forEach(function (id) { $(id).disabled = !enabled; });
  }
  function setLabel(set) { return set === 'raking' ? 'luz rasante' : 'luz normal'; }
  function fmtNum(x, d) { return Number(x).toFixed(d).replace('.', ','); }

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
        syncSliders();
        syncModelUI();
        if (S.model.on) ensureModel().then(function (ok) { if (!ok) fallbackToClassic('Modelo indisponível: ' + (S.model.error || 'não carregou') + '. O detector clássico foi ligado no lugar.'); });
      });
    };
    s.onerror = function () {
      engineState('error', 'Motor não carregou. Verifique a conexão e recarregue');
    };
    document.head.appendChild(s);
  }

  // ------------------------------------------------------------ modelo treinado (opcional, experimental)
  function modelStatus(text, kind) {
    var el = $('modelStatus'); el.textContent = text || '';
    el.dataset.kind = kind || '';
  }
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var sc = document.createElement('script'); sc.src = src; sc.async = true;
      sc.onload = resolve; sc.onerror = function () { reject(new Error('biblioteca do modelo não carregou')); };
      document.head.appendChild(sc);
    });
  }
  /** Carrega a biblioteca e o arquivo do modelo na primeira vez. Devolve true se o modelo ficou pronto. */
  function ensureModel() {
    var m = S.model;
    if (m.M && m.M.pronto()) return Promise.resolve(true);
    if (!m.loading) m.loading = loadModelOnce().then(function (ok) { m.loading = null; return ok; });
    return m.loading;
  }
  async function loadModelOnce() {
    var m = S.model;
    m.state = 'carregando';
    try {
      modelStatus('Verificando o arquivo do modelo...', 'warn');
      var head = await fetch(MODEL_URL, { method: 'HEAD' });
      if (!head.ok) throw new Error('arquivo do modelo não encontrado neste endereço');
      modelStatus('Baixando a biblioteca de execução...', 'warn');
      if (!window.ort) await loadScript(ORT_URL); 
      window.ort.env.wasm.wasmPaths = vendorUrl('vendor/ort/');
      window.ort.env.wasm.proxy = false;
      m.M = window.createModelo(window.ort);
      var t0 = performance.now();
      modelStatus('Carregando o modelo (cerca de 12 MB)...', 'warn');
      await m.M.carregar(MODEL_URL);
      m.loadMs = performance.now() - t0;
      m.state = 'pronto';
      modelStatus('Modelo pronto · ' + ms(m.loadMs), 'ok');
      return true;
    } catch (e) {
      m.state = 'erro'; m.M = null; m.error = errText(e);
      modelStatus('Modelo indisponível: ' + errText(e) + '. O detector clássico foi ligado no lugar.', 'crit');
      return false;
    }
  }

  /** Roda o modelo numa foto e devolve as caixas no quadro (em pixels) de uma imagem de largura destW. */
  async function runModel(file, destW, label) {
    var big = await readForModel(file), bigW = big.width;
    try {
      var res = await S.model.M.detectar(big, {
       progresso: function (i, n) { modelStatus('Modelo treinado, ' + label + ': recorte ' + i + ' de ' + n, 'warn'); barraProgresso.atualizar(label, i, n); },
      aguardar: tick
      });

      var k = destW / bigW;
      return {
        ms: res.ms, recortes: res.recortes,
        boxes: res.caixas.map(function (c) { return { x: c.x * k, y: c.y * k, w: c.w * k, h: c.h * k, area: c.w * k * c.h * k, score: c.score }; })
      };
    } finally { big.width = 0; big.height = 0;  barraProgresso.fim(); }
  }
  async function modelForReference() {
    if (!S.model.on || !S.ref || S.ref.model) return;
    S.ref.model = await runModel(S.ref.file, S.ref.canvas.width, 'referência');
    S.times.modelRef = S.ref.model.ms;
    modelStatus('Modelo pronto · referência: ' + S.ref.model.boxes.length + ' caixas candidatas em ' + ms(S.ref.model.ms), 'ok');
  }
  async function modelForShot(sh) {
    if (!S.model.on || sh.model || !sh.reg || !sh.reg.ok || !sh.file) return;
    var r = await runModel(sh.file, sh.mat.cols, 'foto adicional');
    var W = S.ref.canvas.width, H = S.ref.canvas.height;
    sh.model = { ms: r.ms, boxesRef: S.P.mapBoxes(r.boxes, sh.reg.H, W, H) };
  }
  async function modelForAll() {
    await modelForReference();
    for (var i = 0; i < S.shots.length; i++) await modelForShot(S.shots[i]);
  }
  /** Caixas do modelo prontas para unir: acima da confianca escolhida e com o centro dentro do recorte da peca. */
  function modelGroups() {
    if (!S.model.on || !S.ref || !S.ref.model) return [];
    var W = S.ref.canvas.width, H = S.ref.canvas.height, r = cropRect(W, H), conf = S.model.conf;
    var keep = function (b) {
      var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      return b.score >= conf && cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1;
    };
    var groups = [{ label: 'luz normal', boxes: S.ref.model.boxes.filter(keep) }];
    S.shots.forEach(function (sh) {
      if (sh.state === 'ok' && sh.model) groups.push({ label: setLabel(sh.set), boxes: sh.model.boxesRef.filter(keep) });
    });
    return groups;
  }
  function modelOnly(e) { return e.motores && e.motores.length === 1 && e.motores[0] === 'modelo'; }
  function motorText(e) {
    var m = e.motores || ['classico'];
    return m.map(function (x) { return x === 'modelo' ? 'modelo' : 'clássico'; }).join(' e ');
  }
  function syncModelUI() {
    $('slidersModelo').hidden = !S.model.on;
    $('legModel').hidden = !S.model.on;
  }

  // ------------------------------------------------------------ comparar modelos (A, C2 e C4 na mesma foto)
  // So para comparar e mostrar: a triagem, o mapa e o laudo continuam usando o modelo A. Cada modelo tem a sua sessao ONNX.
  var CMP_MODELS = [
    { id: 'A', url: 'models/yolo-A-pinturas.onnx', cor: '#1fd1ff', nota: 'pinturas de cavalete; o mais conservador' },
    { id: 'C2', url: 'models/yolo-C2-pinturas-met.onnx', cor: '#ffd21f', nota: 'A mais pinturas do Met; intermediário' },
    { id: 'C4', url: 'models/yolo-C4-pinturas-met.onnx', cor: '#ff5fa2', nota: 'A, Met e ARTeFACT; o mais sensível, com mais falsos alarmes' }
  ];
  var cmp = { busy: false, on: { A: true, C2: true, C4: true }, conf: 0.10 };

  function cmpStatus(text, kind) { var el = $('cmpStatus'); el.textContent = text || ''; el.dataset.kind = kind || ''; }
  function cmpDone(ref) { return !!(ref && ref.cmp && CMP_MODELS.every(function (m) { return ref.cmp[m.id] && ref.cmp[m.id].boxes; })); }
  async function cmpLoad(m) {
    if (m.M && m.M.pronto()) return;
    if (m.id === 'A' && S.model.M && S.model.M.pronto()) { m.M = S.model.M; return; }   // o A ja esta carregado pelo fluxo principal
    var head = await fetch(m.url, { method: 'HEAD' });
    if (!head.ok) throw new Error('arquivo ' + m.url + ' não encontrado');
    if (!window.ort) await loadScript(ORT_URL);
    window.ort.env.wasm.wasmPaths = vendorUrl('vendor/ort/');
    window.ort.env.wasm.proxy = false;
    var M = window.createModelo(window.ort), t0 = performance.now();
    await M.carregar(m.url);
    m.M = M; m.loadMs = performance.now() - t0;
  }
  /** Caixas de um modelo acima da confianca escolhida e com o centro dentro do recorte da peca. */
  function cmpBoxes(ref, id) {
    var r = ref.cmp && ref.cmp[id];
    if (!r || !r.boxes) return [];
    var W = ref.canvas.width, H = ref.canvas.height, c = cropRect(W, H);
    return r.boxes.filter(function (b) {
      var cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      return b.score >= cmp.conf && cx >= c.x0 && cx <= c.x1 && cy >= c.y0 && cy <= c.y1;
    });
  }
  /** Fracao da imagem coberta pela uniao das caixas (grade grossa, sem contar duas vezes onde elas se sobrepoem). */
  function cmpUnionFrac(boxes, W, H) {
    var g = Math.max(1, Math.round(W / 320)), gw = Math.ceil(W / g), gh = Math.ceil(H / g), m = new Uint8Array(gw * gh), n = 0;
    boxes.forEach(function (b) {
      var x0 = Math.max(0, Math.floor(b.x / g)), x1 = Math.min(gw, Math.ceil((b.x + b.w) / g));
      var y0 = Math.max(0, Math.floor(b.y / g)), y1 = Math.min(gh, Math.ceil((b.y + b.h) / g));
      for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) if (!m[y * gw + x]) { m[y * gw + x] = 1; n++; }
    });
    return n / (gw * gh);
  }
  function cmpBuildChips() {
    var box = $('cmpChips');
    if (box.children.length) return;
    CMP_MODELS.forEach(function (m) {
      var lab = document.createElement('label'); lab.className = 'chip';
      var inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!cmp.on[m.id]; inp.id = 'cmpChip' + m.id;
      inp.addEventListener('change', function () { cmp.on[m.id] = inp.checked; cmpRender(); });
      var sp = document.createElement('span'), sw = document.createElement('i'), tx = document.createElement('b');
      sw.className = 'cmp-sw'; sw.style.background = m.cor; tx.id = 'cmpChipTxt' + m.id; tx.textContent = m.id;
      sp.appendChild(sw); sp.appendChild(tx); lab.appendChild(inp); lab.appendChild(sp); box.appendChild(lab);
    });
  }
  function cmpRender() {
    var ref = S.ref;
    if (!ref || !ref.cmp) return;
    var stage = $('cmpStage'), W = ref.canvas.width, H = ref.canvas.height;
    var cv0 = stage.querySelector('canvas');
    if (!cv0) { stage.textContent = ''; cv0 = document.createElement('canvas'); cv0.setAttribute('role', 'img'); cv0.setAttribute('aria-label', 'Imagem com as marcas de cada modelo'); stage.appendChild(cv0); }
    cv0.width = W; cv0.height = H;
    var ctx = cv0.getContext('2d');
    paintTo(ctx, W, H, { damage: false, tiles: false, sec: false, alpha: 0, crop: true });
    var lw = Math.max(2, W / 450);
    CMP_MODELS.slice().reverse().forEach(function (m) {            // o A por cima: e o que tem menos caixas
      if (!cmp.on[m.id]) return;
      cmpBoxes(ref, m.id).forEach(function (b) {
        var pad = lw;
        ctx.lineWidth = lw + 3; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
        ctx.lineWidth = lw; ctx.strokeStyle = m.cor; ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
      });
    });
    cmpBuildChips();
    $('cmpChips').hidden = false; $('cmpConfWrap').hidden = false; $('cmpTblWrap').hidden = false; $('cmpNote').hidden = false;
    var body = $('cmpBody'); body.textContent = '';
    CMP_MODELS.forEach(function (m) {
      var r = ref.cmp[m.id], row = document.createElement('tr');
      var tdNome = document.createElement('td'), nome = document.createElement('span'), sw = document.createElement('i'), tn = document.createElement('b'), nota = document.createElement('span');
      nome.className = 'cmp-nome'; sw.className = 'cmp-sw'; sw.style.background = m.cor; tn.textContent = m.id;
      nota.className = 'cmp-nota'; nota.textContent = r && r.erro ? 'indisponível: ' + r.erro : m.nota;
      nome.appendChild(sw); nome.appendChild(tn); tdNome.appendChild(nome); tdNome.appendChild(nota); row.appendChild(tdNome);
      var boxes = r && r.boxes ? cmpBoxes(ref, m.id) : null;
      var cels = boxes ? [String(boxes.length), pct(cmpUnionFrac(boxes, W, H), 1), ms(r.ms)] : ['--', '--', '--'];
      cels.forEach(function (t) { var td = document.createElement('td'); td.className = 'num'; td.textContent = t; row.appendChild(td); });
      body.appendChild(row);
      var tx = $('cmpChipTxt' + m.id);
      if (tx) tx.textContent = m.id + (boxes ? ' · ' + boxes.length : '');
    });
  }
  function cmpReset() {
    var stage = $('cmpStage');
    stage.textContent = '';
    var p = document.createElement('p'); p.className = 'empty';
    p.textContent = 'Depois de escolher a foto de referência, toque em "Comparar os 3 modelos" para ver as marcas de cada um aqui.';
    stage.appendChild(p);
    $('cmpChips').hidden = true; $('cmpConfWrap').hidden = true; $('cmpTblWrap').hidden = true; $('cmpNote').hidden = true;
    cmpStatus('');
  }
  /** Atualiza o botao, a etiqueta e o desenho conforme o estado da referencia. */
  function cmpSync() {
    var ref = S.ref, has = !!(ref && ref.file), any = !!(ref && ref.cmp);
    $('cmpRun').disabled = !has || cmp.busy || cmpDone(ref);
    if (cmp.busy) setPill($('cmpPill'), 'warn', 'comparando');
    else if (cmpDone(ref)) setPill($('cmpPill'), 'ok', 'comparado');
    else if (any) setPill($('cmpPill'), 'warn', 'incompleto');
    else setPill($('cmpPill'), 'idle', has ? 'pronto para comparar' : 'aguardando foto');
    if (any) cmpRender();
  }
  async function cmpRun() {
    var ref = S.ref;
    if (cmp.busy || !ref || !ref.file) return;
    if (S.busy) { toast('Aguarde a análise terminar'); return; }
    cmp.busy = true; ref.cmp = ref.cmp || {}; cmpSync();
    var big = null, k = 1;
    try {
      big = await readForModel(ref.file);
      k = ref.canvas.width / big.width;
      for (var i = 0; i < CMP_MODELS.length; i++) {
        var m = CMP_MODELS[i];
        if (ref.cmp[m.id] && ref.cmp[m.id].boxes) continue;
        if (m.id === 'A' && ref.model) { ref.cmp.A = { ms: ref.model.ms, boxes: ref.model.boxes }; continue; }   // o fluxo principal ja rodou o A nesta foto
        try {
          cmpStatus('Carregando o modelo ' + m.id + '...', 'warn');
          await cmpLoad(m);
          var res = await m.M.detectar(big, {
            progresso: function (n, total) { cmpStatus('Modelo ' + m.id + ': recorte ' + n + ' de ' + total, 'warn'); },
            aguardar: tick
          });
          ref.cmp[m.id] = { ms: res.ms, recortes: res.recortes, boxes: res.caixas.map(function (c) { return { x: c.x * k, y: c.y * k, w: c.w * k, h: c.h * k, area: c.w * k * c.h * k, score: c.score }; }) };
        } catch (e) { ref.cmp[m.id] = { erro: errText(e) }; }
        if (S.ref === ref) cmpRender();
      }
      var falhou = CMP_MODELS.filter(function (m) { return ref.cmp[m.id] && ref.cmp[m.id].erro; });
      cmpStatus(falhou.length ? 'Modelo sem resposta: ' + falhou.map(function (m) { return m.id; }).join(', ') + '. Os outros foram comparados.' : 'Pronto: veja as marcas de cada modelo abaixo.', falhou.length ? 'crit' : 'ok');
    } catch (e) {
      cmpStatus('Falha na comparação: ' + errText(e), 'crit');
    } finally {
      if (big) { big.width = 0; big.height = 0; }
      cmp.busy = false;
      if (S.ref === ref) cmpSync();
    }
  }

  // ------------------------------------------------------------ leitura de imagem
  /** Decodifica o arquivo (com a rotacao do EXIF) e entrega a fonte, o tamanho original e como liberar. */
  function decodeFile(file) {
    return new Promise(function (resolve, reject) {
      if (window.createImageBitmap) {
        createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bmp) {
          resolve({ src: bmp, w: bmp.width, h: bmp.height, free: function () { if (bmp.close) bmp.close(); } });
        }).catch(function () { viaImg(); });
      } else viaImg();
      function viaImg() {
        var url = URL.createObjectURL(file), img = new Image();
        img.onload = function () { resolve({ src: img, w: img.naturalWidth, h: img.naturalHeight, free: function () { URL.revokeObjectURL(url); } }); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Não foi possível abrir a imagem')); };
        img.src = url;
      }
    });
  }
  function drawScaled(dec, side, allowUp) {
    var scale = side / Math.max(dec.w, dec.h);
    if (!allowUp) scale = Math.min(1, scale);
    var cw = Math.max(1, Math.round(dec.w * scale)), ch = Math.max(1, Math.round(dec.h * scale));
    var c = document.createElement('canvas'); c.width = cw; c.height = ch;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    if (scale !== 1) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; }
    ctx.drawImage(dec.src, 0, 0, cw, ch);
    return c;
  }
  function readImage(file) {
    return decodeFile(file).then(function (dec) {
      var c = drawScaled(dec, MAXSIDE, false);
      dec.free();
      return { canvas: c, meta: { name: file.name, bytes: file.size, origW: dec.w, origH: dec.h, procW: c.width, procH: c.height } };
    });
  }
  /** A foto na escala do modelo (lado maior = 2560 px, ampliada se for menor). Quem chama libera o canvas. */
  function readForModel(file) {
    return decodeFile(file).then(function (dec) { var c = drawScaled(dec, MODEL_SIDE, true); dec.free(); return c; });
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
  function freeMat(m) { try { if (m && m.delete) m.delete(); } catch (e) { /* ja liberado */ } }
  function errText(e) {
    if (typeof e === 'number' && S.cv && S.cv.exceptionFromPtr) { try { return S.cv.exceptionFromPtr(e).msg; } catch (x) { /* segue */ } }
    return (e && e.message) ? e.message : String(e);
  }

  // ------------------------------------------------------------ recorte da peca
  function hasCrop() { var c = S.crop; return c.l > 0 || c.t > 0 || c.r > 0 || c.b > 0; }
  function cropRect(W, H) {
    var c = S.crop;
    return {
      x0: Math.round(c.l / 100 * W), y0: Math.round(c.t / 100 * H),
      x1: W - Math.round(c.r / 100 * W), y1: H - Math.round(c.b / 100 * H)
    };
  }
  /** Mat 8 bits (255 dentro do recorte) no quadro da referencia, ou null sem recorte. Quem chama libera. */
  function cropMask(W, H) {
    if (!hasCrop()) return null;
    var r = cropRect(W, H), m = S.cv.Mat.zeros(H, W, S.cv.CV_8UC1);
    S.cv.rectangle(m, new S.cv.Point(r.x0, r.y0), new S.cv.Point(Math.max(r.x0, r.x1 - 1), Math.max(r.y0, r.y1 - 1)), new S.cv.Scalar(255), -1);
    return m;
  }

  function fullMask(W, H) {
    var m = new S.cv.Mat(H, W, S.cv.CV_8UC1); m.setTo(new S.cv.Scalar(255)); return m;
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

  // ------------------------------------------------------------ reinicio
  function freeShot(sh) {
    freeMat(sh.mat);
    if (sh.det) freeMat(sh.det.mask);
    freeMat(sh.refMask);
  }
  function resetShots() {
    S.shots.forEach(freeShot); S.shots = [];
    S.view.sec = false; $('tglSec').checked = false; $('tglSec').disabled = true; $('alphaWrap').hidden = true;
    renderShotList();
  }
  function resetReference() {
    resetShots();
    if (S.ref) { freeMat(S.ref.mat); if (S.ref.det) freeMat(S.ref.det.mask); }
    S.ref = null; S.forced = false; S.merged = null; S.triage = null;
    cmpReset(); cmpSync();
    if (S.model.state !== 'erro') modelStatus(S.model.state === 'pronto' ? 'Modelo pronto' : '', S.model.state === 'pronto' ? 'ok' : '');   // o aviso de falha fica na tela
    enableShots(false); $('overrideRow').hidden = true; $('copyJson').disabled = true; $('reanalyze').disabled = true;
    $('cropBox').hidden = true;
  }

  // ------------------------------------------------------------ captura de referencia
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
      S.ref = { mat: mat, canvas: img.canvas, meta: img.meta, ill: null, det: null, file: file, model: null };
      var ill = S.P.checkIllumination(mat);
      S.times.illumination = performance.now() - t0;
      S.ref.ill = ill;
      showIllumination(ill);
      $('cropBox').hidden = false;
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

  async function analyzeReference() {
    setPill($('refPill'), 'warn', 'analisando');
    $('refStatus').textContent = !S.classic.on ? 'Preparando o modelo treinado...'
      : S.mode === 'impresso' ? 'Descartando regiões com muito detalhe e procurando manchas...'
      : 'Rejeitando regiões sem dano e detectando candidatos...';
    await tick();
    var infoFoto = S.ref.meta.origW + ' × ' + S.ref.meta.origH + ' px (' + fmtBytes(S.ref.meta.bytes) + '), processada em ' + S.ref.meta.procW + ' × ' + S.ref.meta.procH + ' px.';
    if (S.model.on) {
      // o modelo e o detector principal: se nao carregar, liga o classico antes de seguir
      var ready = await ensureModel();
      if (!ready) fallbackToClassic('Modelo indisponível: ' + (S.model.error || 'não carregou') + '. O detector clássico foi ligado no lugar.');
    }
    if (S.ref.det) freeMat(S.ref.det.mask);
    var roi = cropMask(S.ref.canvas.width, S.ref.canvas.height);
    try { S.ref.det = detectClassicOrEmpty(S.ref.mat, roi, { mode: S.mode }); } finally { freeMat(roi); }
    S.times.detectRef = S.ref.det.stats.ms;
    $('refStatus').textContent = infoFoto;
    $('overrideRow').hidden = true;
    enableShots(true); $('reanalyze').disabled = false; $('copyJson').disabled = false;
    for (var i = 0; i < S.shots.length; i++) {
      if (S.shots[i].reg && S.shots[i].reg.ok) await analyzeShot(S.shots[i]);
    }
    rebuildMerged();
    drawView(); renderTriage(); renderShotList();      // o resultado do detector classico (se ligado) ja aparece
    if (S.model.on) {
      setPill($('refPill'), 'warn', 'modelo treinado');
      try { await modelForAll(); } catch (e) { modelFailed(e); }
      if (!S.model.on && S.ref.det.empty) {            // o modelo falhou no meio: faz a deteccao classica agora
        var roi2 = cropMask(S.ref.canvas.width, S.ref.canvas.height);
        try { freeMat(S.ref.det.mask); S.ref.det = S.P.detect(S.ref.mat, roi2, { mode: S.mode }); } finally { freeMat(roi2); }
        for (var j = 0; j < S.shots.length; j++) { if (S.shots[j].reg && S.shots[j].reg.ok) await analyzeShot(S.shots[j]); }
      }
      rebuildMerged();
      drawView(); renderTriage(); renderShotList();
    }
    setPill($('refPill'), 'ok', 'analisada');
  }

  /** Deteccao vazia, para quando o detector classico esta desligado: o resto do app continua igual. */
  function emptyDetection(W, H) {
    return { empty: true, boxes: [], mask: S.cv.Mat.zeros(H, W, S.cv.CV_8UC1),
      tiles: { cols: 0, rows: 0, size: 32, keep: new Uint8Array(0), evaluated: 0, candidates: 0, rejected: 0 },
      stats: { width: W, height: H, crackThr: null, damageFrac: 0, rejectedFrac: 0, crackCount: 0, lossCount: 0, ms: 0 } };
  }
  function detectClassicOrEmpty(rgba, roi, opts) {
    return S.classic.on ? S.P.detect(rgba, roi, opts) : emptyDetection(rgba.cols, rgba.rows);
  }

  // ------------------------------------------------------------ fotos adicionais
  async function onShots(files, set) {
    if (!files || !files.length || !S.cv || !S.ref || !S.ref.det || S.busy) return;
    S.busy = true;
    try {
      for (var i = 0; i < files.length; i++) {
        var sh = { id: S.nextShotId++, set: set, file: files[i], model: null, mat: null, meta: null, reg: null, scale: 1, det: null, refMask: null, refBoxes: [], warpedCanvas: null, state: 'lendo', msg: '' };
        S.shots.push(sh);
        renderShotList(); await tick();
        try {
          var img = await readImage(files[i]);
          sh.meta = img.meta; sh.mat = canvasToMat(img.canvas);
          sh.state = 'alinhando'; renderShotList(); await tick();
          var reg = S.P.registerCaptures(S.ref.mat, sh.mat);
          S.times.orb = reg.ms;
          if (reg.warped) { sh.warpedCanvas = matToCanvas(reg.warped); freeMat(reg.warped); reg.warped = null; }
          freeMat(reg.valid); reg.valid = null;
          sh.reg = reg;
          if (!reg.ok) { sh.state = 'falhou'; sh.msg = reg.reason; }
          else {
            sh.scale = S.P.homographyScale(reg.H);
            sh.state = 'detectando'; renderShotList(); await tick();
            await analyzeShot(sh);
            if (S.model.on) { try { await modelForShot(sh); } catch (e) { modelFailed(e); } }
            sh.state = 'ok';
          }
        } catch (e) { sh.state = 'falhou'; sh.msg = errText(e); }
        rebuildMerged();
        $('tglSec').disabled = !lastWarped();
        drawView(); renderTriage(); renderShotList();
      }
    } finally { S.busy = false; }
  }

  /** Detecta na foto adicional (na resolucao dela) e leva o resultado para o quadro da referencia. */
  async function analyzeShot(sh) {
    var W = S.ref.canvas.width, H = S.ref.canvas.height;
    if (sh.det) { freeMat(sh.det.mask); sh.det = null; }
    freeMat(sh.refMask); sh.refMask = null;
    // regiao valida da foto = quadro da referencia (ou o recorte) visto da foto; exclui bordas pretas e o que sobra do quadro
    var roiRef = cropMask(W, H) || fullMask(W, H), roiShot = null;
    try {
      roiShot = S.P.warpMaskToShot(roiRef, sh.reg.H, sh.mat.cols, sh.mat.rows);
      var sideEff = Math.max(W, H) / Math.max(0.05, sh.scale);
      sh.det = detectClassicOrEmpty(sh.mat, roiShot, { mode: S.mode, sideEff: sideEff });
      sh.refBoxes = sh.det.empty ? [] : S.P.mapBoxes(sh.det.boxes, sh.reg.H, W, H);
      sh.refMask = sh.det.empty ? null : S.P.warpMask(sh.det.mask, sh.reg.H, W, H);
    } finally { freeMat(roiRef); freeMat(roiShot); }
    S.times['detect' + sh.id] = sh.det.stats.ms;
  }

  function removeShot(id) {
    if (S.busy) return;
    var idx = S.shots.findIndex(function (s) { return s.id === id; });
    if (idx < 0) return;
    freeShot(S.shots[idx]); S.shots.splice(idx, 1);
    if (!lastWarped()) { S.view.sec = false; $('tglSec').checked = false; }
    $('tglSec').disabled = !lastWarped();
    rebuildMerged(); drawView(); renderTriage(); renderShotList();
  }

  function lastWarped() {
    for (var i = S.shots.length - 1; i >= 0; i--) if (S.shots[i].warpedCanvas && S.shots[i].reg && S.shots[i].reg.ok) return S.shots[i].warpedCanvas;
    return null;
  }

  function renderShotList() {
    var ul = $('shotList'); ul.textContent = '';
    $('shotListWrap').hidden = S.shots.length === 0;
    S.shots.forEach(function (sh, n) {
      var li = document.createElement('li');
      var head = document.createElement('div'); head.className = 'shot-head';
      var title = document.createElement('span');
      title.textContent = 'Foto ' + (n + 1) + ' · ' + setLabel(sh.set);
      var pill = document.createElement('span');
      var cls = sh.state === 'ok' ? 'ok' : (sh.state === 'falhou' ? 'crit' : 'warn');
      var txt = sh.state === 'ok' ? 'alinhada' : sh.state;
      pill.className = 'pill ' + cls; pill.textContent = txt;
      head.appendChild(title); head.appendChild(pill);
      li.appendChild(head);
      var info = document.createElement('div'); info.className = 'muted shot-info';
      if (sh.state === 'ok' && sh.reg) {
        var zoom = sh.scale < 0.8 ? ' · detalhe, ' + fmtNum(1 / sh.scale, 1) + '× mais resolução que a referência' : '';
        info.textContent = sh.reg.inliers + ' pontos concordantes de ' + sh.reg.good + zoom + ' · ' + sh.refBoxes.length + (S.mode === 'impresso' ? ' manchas' : ' danos');
      } else if (sh.state === 'falhou') info.textContent = sh.msg + '.';
      else info.textContent = (sh.meta ? sh.meta.name : '') + '...';
      li.appendChild(info);
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn small'; btn.textContent = 'Remover';
      btn.addEventListener('click', function () { removeShot(sh.id); });
      li.appendChild(btn);
      ul.appendChild(li);
    });
  }

  function rebuildMerged() {
    var W = S.ref.canvas.width, H = S.ref.canvas.height;
    var okShots = S.shots.filter(function (s) { return s.state === 'ok' && s.det; });
    S.merged = S.P.mergeAll(S.ref.det.boxes, okShots.map(function (s) { return { label: setLabel(s.set), boxes: s.refBoxes }; }), W, H);
    var frac = S.ref.det.stats.damageFrac;
    okShots.forEach(function (s) { frac = Math.max(frac, s.det.stats.damageFrac); });
    var groups = modelGroups();
    if (groups.length) {
      S.P.addModelBoxes(S.merged, groups, W, H);
      // area das marcas que so o modelo achou entra na area afetada da triagem
      var extra = 0;
      S.merged.forEach(function (e) { if (modelOnly(e)) extra += e.w * e.h; });
      frac += extra / (W * H);
    }
    S.triage = S.P.triage(frac, S.merged.length, S.mode);
  }

  // ------------------------------------------------------------ desenho
  function colorFor(e) {
    if (modelOnly(e)) return css('--c-model');
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
    var warped = lastWarped();
    if (opts.sec && warped) {
      ctx.globalAlpha = opts.alpha; ctx.drawImage(warped, 0, 0, W, H); ctx.globalAlpha = 1;
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
      S.shots.forEach(function (sh) {
        if (sh.state === 'ok' && sh.refMask) ctx.drawImage(tintMask(sh.refMask, sh.set === 'raking' ? [31, 209, 255] : [255, 75, 51], 90), 0, 0);
      });
      var lw = Math.max(2, W / 450);
      ctx.font = '600 ' + Math.max(13, Math.round(W / 55)) + 'px ' + css('--font-data');
      ctx.textBaseline = 'top';
      (S.merged || []).forEach(function (e) {
        var pad = lw * 2, x = e.x - pad, y = e.y - pad, w = e.w + pad * 2, h = e.h + pad * 2;
        ctx.lineWidth = lw + 3; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.strokeRect(x, y, w, h);
        ctx.lineWidth = lw; ctx.strokeStyle = colorFor(e); ctx.strokeRect(x, y, w, h);
        var label = '#' + e.id + ' ' + (TYPE_LETTER[e.type] || '?') + (e.motores && e.motores.length > 1 ? '+A' : '');
        var tw = ctx.measureText(label).width + 8, th = Math.max(13, Math.round(W / 55)) + 6;
        var ly = y - th >= 0 ? y - th : y, lx = Math.max(0, Math.min(x, W - tw));
        ctx.fillStyle = colorFor(e); ctx.fillRect(lx, ly, tw, th);
        ctx.fillStyle = '#111'; ctx.fillText(label, lx + 4, ly + 3);
      });
    }
    if (opts.crop && hasCrop()) {
      var rc = cropRect(W, H);
      ctx.fillStyle = 'rgba(10,14,13,0.6)';
      ctx.fillRect(0, 0, W, rc.y0); ctx.fillRect(0, rc.y1, W, H - rc.y1);
      ctx.fillRect(0, rc.y0, rc.x0, rc.y1 - rc.y0); ctx.fillRect(rc.x1, rc.y0, W - rc.x1, rc.y1 - rc.y0);
      ctx.setLineDash([Math.max(8, W / 80), Math.max(6, W / 110)]);
      ctx.lineWidth = Math.max(2, W / 400); ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(rc.x0, rc.y0, rc.x1 - rc.x0, rc.y1 - rc.y0);
      ctx.setLineDash([]);
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
    paintTo(cv0.getContext('2d'), W, H, { damage: hasDet && S.view.damage, tiles: hasDet && S.view.tiles, sec: S.view.sec, alpha: S.view.alpha, crop: true });
    $('chips').hidden = false; $('legend').hidden = !hasDet; $('mapBtnRow').hidden = !hasDet;
    $('tglDamage').disabled = !hasDet; $('tglTiles').disabled = !hasDet;
    $('alphaWrap').hidden = !(S.view.sec && lastWarped());
    $('viewInfo').textContent = W + ' × ' + H + ' px';
    cmpSync();
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
    $('triRej').textContent = det.empty ? '--' : pct(det.stats.rejectedFrac, 0);
    var total = det.stats.ms + (S.model.on && S.ref.model ? S.ref.model.ms : 0);
    S.shots.forEach(function (s) { if (s.det) total += s.det.stats.ms + (s.reg ? s.reg.ms : 0) + (S.model.on && s.model ? s.model.ms : 0); });
    $('triMs').textContent = ms(total);
    $('printNote').hidden = S.mode !== 'impresso';

    var tb = $('tblBody'); tb.textContent = '';
    S.merged.forEach(function (e) {
      var row = document.createElement('tr');
      var td = function (txt, cls) { var c = document.createElement('td'); c.textContent = txt; if (cls) c.className = cls; row.appendChild(c); return c; };
      td('#' + e.id, 'num');
      var tcell = td('');
      var dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = colorFor(e);
      tcell.appendChild(dot); tcell.appendChild(document.createTextNode(e.type));
      td((e.cx * 100).toFixed(0) + '%, ' + (e.cy * 100).toFixed(0) + '%', 'num');
      td((e.sources.length > 1 ? 'luz normal e rasante' : e.sources[0]) + (S.model.on ? ' · ' + motorText(e) : ''));
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
    rows.push(['Tipo de obra', S.mode === 'impresso' ? 'impresso / ilustração' : 'pintura']);
    rows.push(['Detector clássico', S.classic.on ? 'ligado' : 'desligado']);
    if (S.model.on) {
      rows.push(['Modelo treinado', 'ativo · confiança mínima ' + fmtNum(S.model.conf, 2) + (S.model.loadMs ? ' · carga ' + ms(S.model.loadMs) : '')]);
      if (S.ref && S.ref.model) rows.push(['Modelo: tempo / caixas candidatas (ref.)', ms(S.ref.model.ms) + ' / ' + S.ref.model.boxes.length]);
    }
    if (S.ref) {
      var m = S.ref.meta;
      rows.push(['Original', m.origW + ' × ' + m.origH + ' px · ' + fmtBytes(m.bytes)]);
      rows.push(['Processada', m.procW + ' × ' + m.procH + ' px']);
      if (hasCrop()) rows.push(['Recorte (esq./topo/dir./base)', S.crop.l + '% / ' + S.crop.t + '% / ' + S.crop.r + '% / ' + S.crop.b + '%']);
      if (S.ref.ill) rows.push(['Luminância', S.ref.ill.meanL.toFixed(1)]);
      if (S.times.illumination != null) rows.push(['Tempo da iluminação', ms(S.times.illumination)]);
      if (S.ref.det && !S.ref.det.empty) {
        var t = S.ref.det.tiles;
        rows.push(['Regiões avaliadas', t.evaluated + ' (' + t.rejected + ' descartadas)']);
        if (S.ref.det.stats.crackThr != null) rows.push(['Limiar de rachadura', S.ref.det.stats.crackThr.toFixed(1)]);
        rows.push(['Tempo de detecção (ref.)', ms(S.ref.det.stats.ms)]);
      }
    }
    S.shots.forEach(function (sh, n) {
      if (!sh.reg) return;
      var r = sh.reg, tag = 'Foto ' + (n + 1) + ' (' + setLabel(sh.set) + ')';
      rows.push([tag, sh.meta.origW + ' × ' + sh.meta.origH + ' px · ' + fmtBytes(sh.meta.bytes)]);
      rows.push([tag + ': ORB ref. / foto', r.kpRef + ' / ' + r.kpSec]);
      rows.push([tag + ': correspondências / inliers', r.good + ' / ' + r.inliers]);
      rows.push([tag + ': escala na referência', fmtNum(sh.scale, 2) + '×']);
      rows.push([tag + ': tempo (alinhar / detectar)', ms(r.ms) + ' / ' + (sh.det ? ms(sh.det.stats.ms) : '--')]);
    });
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
      tipoDeObra: S.mode,
      detectores: { modeloTreinado: S.model.on, classico: S.classic.on },
      recortePercentual: S.crop,
      parametros: S.P.params,
      referencia: S.ref ? { meta: S.ref.meta, iluminacao: S.ref.ill, deteccao: S.ref.det ? S.ref.det.stats : null,
        regioes: S.ref.det ? { avaliadas: S.ref.det.tiles.evaluated, candidatas: S.ref.det.tiles.candidates, descartadas: S.ref.det.tiles.rejected } : null } : null,
      fotosAdicionais: S.shots.map(function (sh) {
        return { tipo: setLabel(sh.set), estado: sh.state, meta: sh.meta, escalaNaReferencia: sh.scale,
          alinhamento: sh.reg ? { ok: sh.reg.ok, pontosRef: sh.reg.kpRef, pontosFoto: sh.reg.kpSec, correspondencias: sh.reg.good, inliers: sh.reg.inliers, ms: sh.reg.ms, homografia: sh.reg.H } : null,
          deteccao: sh.det ? sh.det.stats : null };
      }),
      modeloTreinado: S.model.on ? { ativo: true, arquivo: MODEL_URL, confiancaMinima: S.model.conf, experimental: false,
        referencia: S.ref && S.ref.model ? { ms: S.ref.model.ms, caixasCandidatas: S.ref.model.boxes.length } : null } : { ativo: false },
      danos: (S.merged || []).map(function (e) { return { id: e.id, tipo: e.type, x: e.x, y: e.y, largura: e.w, altura: e.h, centroNormalizado: [+e.cx.toFixed(4), +e.cy.toFixed(4)], vistoEm: e.sources, achadoPor: e.motores || ['classico'], confiancaModelo: e.scoreModelo != null ? +e.scoreModelo.toFixed(3) : undefined }; }),
      comparacaoModelos: S.ref && S.ref.cmp ? { confiancaMinima: cmp.conf, modelos: CMP_MODELS.map(function (m) {
        var r = S.ref.cmp[m.id], boxes = r && r.boxes ? cmpBoxes(S.ref, m.id) : null;
        return { id: m.id, arquivo: m.url, erro: r && r.erro || null, caixas: boxes ? boxes.length : null, areaMarcada: boxes ? +cmpUnionFrac(boxes, S.ref.canvas.width, S.ref.canvas.height).toFixed(4) : null, ms: r && r.ms != null ? Math.round(r.ms) : null };
      }) } : null,
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
    paintTo(ctx, W, H, { damage: true, tiles: S.mode === 'impresso', sec: false, alpha: 0, crop: false });
    ctx.fillStyle = '#101514'; ctx.fillRect(0, H, W, bar);
    var fs = Math.max(12, Math.round(bar * 0.26));
    ctx.font = '500 ' + fs + 'px ' + css('--font-data'); ctx.textBaseline = 'middle';
    var items = S.classic.on ? [[css('--c-both'), 'normal e rasante'], [css('--c-normal'), 'só luz normal'], [css('--c-raking'), 'só luz rasante']] : [];
    if (S.model.on) items.push([css('--c-model'), 'modelo treinado (A)']);
    var x = 14, y1 = H + bar * 0.3, y2 = H + bar * 0.74, sz = Math.round(fs * 0.9);
    items.forEach(function (it) {
      ctx.strokeStyle = it[0]; ctx.lineWidth = 3; ctx.strokeRect(x, y1 - sz / 2, sz, sz);
      ctx.fillStyle = '#e6eeec'; ctx.fillText(it[1], x + sz + 8, y1); x += sz + 8 + ctx.measureText(it[1]).width + 20;
    });
    var label = 'Prioridade de inspeção: ' + (S.triage.level === 'media' ? 'média' : S.triage.level) + '  ·  ' +
      (!S.classic.on ? 'A avaria encontrada pelo modelo treinado' : S.mode === 'impresso' ? 'M mancha (regiões escurecidas não foram analisadas)' : 'R rachadura  ·  C perda de cor');
    ctx.fillStyle = '#9db0ab'; ctx.fillText(label, 14, y2);
    $('mapImg').src = c.toDataURL('image/jpeg', 0.92);
    $('mapOut').hidden = false;
    if ($('mapOut').scrollIntoView) $('mapOut').scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------ controles de sensibilidade e tipo de obra
  function syncSliders() {
    var p = S.P.params;
    $('sCrack').value = p.crackSigma; $('sCrackVal').textContent = fmtNum(p.crackSigma, 1) + ' desvios';
    $('sLoss').value = p.lossThr; $('sLossVal').textContent = String(p.lossThr);
    $('sDark').value = p.printDarkThr; $('sDarkVal').textContent = String(p.printDarkThr);
    $('sDetail').value = p.printDetailMax; $('sDetailVal').textContent = Math.round(p.printDetailMax * 100) + '%';
    $('slidersPintura').hidden = S.mode !== 'pintura' || !S.classic.on;
    $('slidersImpresso').hidden = S.mode !== 'impresso' || !S.classic.on;
    var letras = [];
    if (S.classic.on) letras.push(S.mode === 'impresso' ? 'M mancha escura' : 'R rachadura · C perda de cor');
    if (S.model.on) letras.push('A avaria (modelo)');
    $('legendLetters').textContent = letras.join(' · ');
  }

  async function reanalyzeAll(msg) {
    if (S.busy || !S.ref || !S.ref.det) return;
    S.busy = true;
    try { await analyzeReference(); if (msg) toast(msg); } finally { S.busy = false; }
  }

  var cropTimer = null;
  function onCropInput(key, el, valEl) {
    S.crop[key] = parseInt(el.value, 10) || 0;
    valEl.textContent = S.crop[key] + '%';
    drawView();
  }
  function onCropChange() {
    clearTimeout(cropTimer);
    cropTimer = setTimeout(function () { reanalyzeAll('Recorte aplicado'); }, 200);
  }

  // ------------------------------------------------------------ eventos
  function bindFiles(id, handler) {
    $(id).addEventListener('change', function (ev) {
      var list = ev.target.files ? Array.prototype.slice.call(ev.target.files) : [];
      ev.target.value = ''; handler(list);
    });
  }
  bindFiles('refCam', function (l) { onReference(l[0]); });
  bindFiles('refFile', function (l) { onReference(l[0]); });
  bindFiles('nrmCam', function (l) { onShots(l, 'normal'); });
  bindFiles('nrmFile', function (l) { onShots(l, 'normal'); });
  bindFiles('rakCam', function (l) { onShots(l, 'raking'); });
  bindFiles('rakFile', function (l) { onShots(l, 'raking'); });

  $('override').addEventListener('click', async function () {
    if (S.busy || !S.ref) return; S.busy = true; S.forced = true;
    try { await analyzeReference(); } finally { S.busy = false; }
  });
  $('tglDamage').addEventListener('change', function (e) { S.view.damage = e.target.checked; drawView(); });
  $('tglTiles').addEventListener('change', function (e) { S.view.tiles = e.target.checked; drawView(); });
  $('tglSec').addEventListener('change', function (e) { S.view.sec = e.target.checked; drawView(); });
  $('alpha').addEventListener('input', function (e) { S.view.alpha = e.target.value / 100; $('alphaVal').textContent = e.target.value + '%'; drawView(); });
  $('sCrack').addEventListener('input', function (e) { S.P.params.crackSigma = parseFloat(e.target.value); $('sCrackVal').textContent = fmtNum(parseFloat(e.target.value), 1) + ' desvios'; });
  $('sLoss').addEventListener('input', function (e) { S.P.params.lossThr = parseFloat(e.target.value); $('sLossVal').textContent = e.target.value; });
  $('sDark').addEventListener('input', function (e) { S.P.params.printDarkThr = parseFloat(e.target.value); $('sDarkVal').textContent = e.target.value; });
  $('sDetail').addEventListener('input', function (e) { S.P.params.printDetailMax = parseFloat(e.target.value); $('sDetailVal').textContent = Math.round(parseFloat(e.target.value) * 100) + '%'; });
  $('reanalyze').addEventListener('click', function () { reanalyzeAll('Análise atualizada'); });

  // modelo treinado (experimental): liga e desliga sem tocar no detector classico
  function syncEngineChecks() { $('useModel').checked = S.model.on; $('useClassic').checked = S.classic.on; syncModelUI(); if (S.P) syncSliders(); }
  /** O modelo nao carregou ou falhou: liga o detector classico para o app nunca ficar sem detector. */
  function fallbackToClassic(texto) {
    S.model.on = false; S.classic.on = true; syncEngineChecks();
    modelStatus(texto, 'crit');
  }
  function modelFailed(e) { fallbackToClassic('Falha ao rodar o modelo: ' + errText(e) + '. Seguindo com o detector clássico.'); }
  function refreshAfterModel() {
    if (!S.ref || !S.ref.det) return;
    rebuildMerged(); drawView(); renderTriage(); renderShotList();
  }
  $('useModel').addEventListener('change', async function (e) {
    var want = e.target.checked;
    if (S.busy) { e.target.checked = !want; toast('Aguarde a análise terminar'); return; }
    if (!want && !S.classic.on) { e.target.checked = true; toast('Deixe pelo menos um detector ligado'); return; }
    S.busy = true;
    try {
      if (want) {
        e.target.disabled = true;
        var ok = await ensureModel();
        e.target.disabled = false;
        if (!ok) { e.target.checked = false; modelStatus('Modelo indisponível: ' + (S.model.error || 'não carregou') + '.', 'crit'); return; }
        S.model.on = true; syncEngineChecks();
        if (S.ref && S.ref.det) { await modelForAll(); refreshAfterModel(); toast('Modelo treinado ligado'); }
      } else {
        S.model.on = false; syncEngineChecks();
        modelStatus(S.model.state === 'pronto' ? 'Modelo pronto (desligado)' : '', S.model.state === 'pronto' ? 'ok' : '');
        refreshAfterModel();
      }
    } catch (err) { modelFailed(err); } finally { e.target.disabled = false; S.busy = false; }
  });
  $('useClassic').addEventListener('change', async function (e) {
    var want = e.target.checked;
    if (S.busy) { e.target.checked = !want; toast('Aguarde a análise terminar'); return; }
    if (!want && !S.model.on) { e.target.checked = true; toast('Deixe pelo menos um detector ligado'); return; }
    S.classic.on = want; syncEngineChecks();
    if (S.ref && S.ref.det) { S.busy = true; try { await analyzeReference(); toast(want ? 'Detector clássico ligado' : 'Detector clássico desligado'); } finally { S.busy = false; } }
  });
  $('sModel').addEventListener('input', function (e) {
    S.model.conf = parseFloat(e.target.value); $('sModelVal').textContent = fmtNum(S.model.conf, 2);
    refreshAfterModel();
  });
  $('copyJson').addEventListener('click', copyReport);
  $('cmpRun').addEventListener('click', cmpRun);
  $('cmpConf').addEventListener('input', function (e) { cmp.conf = parseFloat(e.target.value); $('cmpConfVal').textContent = fmtNum(cmp.conf, 2); cmpRender(); });
  $('makeImg').addEventListener('click', makeMapImage);

  ['modePintura', 'modeImpresso'].forEach(function (id) {
    $(id).addEventListener('change', function (e) {
      if (!e.target.checked) return;
      S.mode = e.target.value;
      // padrao por tipo de obra: pintura usa o modelo treinado; impresso usa o classico (o modelo nao foi treinado com impressos)
      S.model.on = S.mode === 'pintura'; S.classic.on = S.mode === 'impresso';
      syncEngineChecks();
      if (S.mode === 'impresso') { S.view.tiles = true; $('tglTiles').checked = true; }
      reanalyzeAll('Tipo de obra: ' + (S.mode === 'impresso' ? 'impresso / ilustração' : 'pintura'));
      renderKV();
    });
  });

  [['cropL', 'l'], ['cropT', 't'], ['cropR', 'r'], ['cropB', 'b']].forEach(function (pair) {
    var el = $(pair[0]), valEl = $(pair[0] + 'Val');
    el.addEventListener('input', function () { onCropInput(pair[1], el, valEl); });
    el.addEventListener('change', onCropChange);
  });
  $('cropReset').addEventListener('click', function () {
    S.crop = { l: 0, t: 0, r: 0, b: 0 };
    [['cropL'], ['cropT'], ['cropR'], ['cropB']].forEach(function (p) { $(p[0]).value = 0; $(p[0] + 'Val').textContent = '0%'; });
    drawView(); onCropChange();
  });

  renderKV();
  loadEngine();
})();
