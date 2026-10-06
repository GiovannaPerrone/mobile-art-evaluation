/*
  Comparação lado a lado dos três modelos — arquivo independente.

  Como usar:
    1) no fim do js/app.js, antes de "loadEngine();", acrescente UMA linha:

         window.__triagem = { S: S, cmp: cmp, CMP_MODELS: CMP_MODELS, cmpBoxes: cmpBoxes, cmpUnionFrac: cmpUnionFrac };

    2) no index.html, depois do zoom.js:

         <script src="js/comparar.js"></script>

  O que faz: abaixo da imagem com as marcas sobrepostas, mostra as três
  miniaturas separadas (A, C2 e C4), cada uma só com as suas caixas, e um
  botão que junta as três numa imagem única — a que serve ao artigo.

  A imagem sobreposta continua ali: ela mostra onde os modelos discordam no
  mesmo ponto. As miniaturas mostram cada um isolado.
*/

(function () {
  'use strict';

  var LARG_MINI = 700;   // largura de desenho de cada miniatura
  var api = function () { return window.__triagem; };

  function estilo() {
    if (document.getElementById('cmpLadoCss')) return;
    var s = document.createElement('style');
    s.id = 'cmpLadoCss';
    s.textContent = [
      '.cmp-lado{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px}',
      '@media (max-width:720px){.cmp-lado{grid-template-columns:1fr}}',
      '.cmp-mini{margin:0}',
      '.cmp-mini canvas{width:100%;height:auto;display:block;border-radius:8px;border:2px solid transparent}',
      '.cmp-mini figcaption{font:600 13px system-ui,sans-serif;margin-top:6px;display:flex;',
      '  align-items:center;gap:6px;flex-wrap:wrap}',
      '.cmp-mini .num{font-weight:400;opacity:.75}',
      '.cmp-mini .erro{font-weight:400;opacity:.75;font-style:italic}'
    ].join('');
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------- estrutura
  var caixa, botao, saida, img;

  function montar() {
    if (caixa) return;
    var stage = document.getElementById('cmpStage');
    if (!stage || !stage.parentNode) return;

    caixa = document.createElement('div');
    caixa.className = 'cmp-lado';
    caixa.hidden = true;

    var linha = document.createElement('div');
    linha.className = 'btn-row';
    linha.hidden = true;
    botao = document.createElement('button');
    botao.type = 'button';
    botao.className = 'btn';
    botao.textContent = 'Baixar imagem da comparação';
    botao.addEventListener('click', gerarImagem);
    linha.appendChild(botao);

    saida = document.createElement('div');
    saida.className = 'map-out';
    saida.hidden = true;
    img = document.createElement('img');
    img.alt = 'Comparação dos três modelos lado a lado';
    var dica = document.createElement('p');
    dica.className = 'muted';
    dica.textContent = 'No celular, toque e segure a imagem para salvar.';
    saida.appendChild(img);
    saida.appendChild(dica);

    stage.parentNode.insertBefore(caixa, stage.nextSibling);
    caixa.parentNode.insertBefore(linha, caixa.nextSibling);
    linha.parentNode.insertBefore(saida, linha.nextSibling);
    botao._linha = linha;
  }

  // ---------------------------------------------------------------- desenho
  /** Uma miniatura: a foto e só as caixas daquele modelo, com a letra no canto. */
  function desenharMini(cv, modelo, boxes, W, H) {
    var A = api(), ref = A.S.ref;
    var k = Math.min(1, LARG_MINI / W);
    cv.width = Math.round(W * k);
    cv.height = Math.round(H * k);
    var ctx = cv.getContext('2d');
    ctx.drawImage(ref.canvas, 0, 0, cv.width, cv.height);

    var lw = Math.max(1.5, cv.width / 300);
    var fs = Math.max(10, Math.round(cv.width / 40));
    ctx.font = '700 ' + fs + 'px system-ui, sans-serif';
    ctx.textBaseline = 'top';

    boxes.forEach(function (b) {
      var x = b.x * k, y = b.y * k, w = b.w * k, h = b.h * k;
      ctx.lineWidth = lw + 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeRect(x, y, w, h);
      ctx.lineWidth = lw;
      ctx.strokeStyle = modelo.cor;
      ctx.strokeRect(x, y, w, h);

      // letra do modelo no canto da caixa: distingue sem depender só da cor
      var tw = ctx.measureText(modelo.id).width + 6, th = fs + 4;
      var ly = y - th >= 0 ? y - th : y;
      ctx.fillStyle = modelo.cor;
      ctx.fillRect(x, ly, tw, th);
      ctx.fillStyle = '#111';
      ctx.fillText(modelo.id, x + 3, ly + 2);
    });

    cv.style.borderColor = modelo.cor;
  }

  function pct(x) { return (x * 100).toFixed(1).replace('.', ',') + '%'; }

  function renderizar() {
    var A = api();
    if (!A || !A.S.ref || !A.S.ref.cmp) { if (caixa) esconder(); return; }
    montar();
    var ref = A.S.ref, W = ref.canvas.width, H = ref.canvas.height;

    caixa.textContent = '';
    var algum = false;

    A.CMP_MODELS.forEach(function (m) {
      var r = ref.cmp[m.id];
      var fig = document.createElement('figure');
      fig.className = 'cmp-mini';
      var cap = document.createElement('figcaption');

      if (!r || (!r.boxes && !r.erro)) return;   // ainda não rodou este modelo

      if (r.erro) {
        var p = document.createElement('p');
        p.className = 'empty';
        p.textContent = 'Modelo ' + m.id + ' indisponível.';
        fig.appendChild(p);
        cap.innerHTML = '';
        var sw0 = document.createElement('i');
        sw0.className = 'cmp-sw';
        sw0.style.background = m.cor;
        var b0 = document.createElement('b');
        b0.textContent = m.id;
        var e0 = document.createElement('span');
        e0.className = 'erro';
        e0.textContent = r.erro;
        cap.appendChild(sw0); cap.appendChild(b0); cap.appendChild(e0);
      } else {
        algum = true;
        var cv = document.createElement('canvas');
        var boxes = A.cmpBoxes(ref, m.id);
        desenharMini(cv, m, boxes, W, H);
        fig.appendChild(cv);

        var sw = document.createElement('i');
        sw.className = 'cmp-sw';
        sw.style.background = m.cor;
        var b = document.createElement('b');
        b.textContent = m.id;
        var n = document.createElement('span');
        n.className = 'num';
        n.textContent = boxes.length + ' caixas · ' + pct(A.cmpUnionFrac(boxes, W, H)) + ' da área';
        cap.appendChild(sw); cap.appendChild(b); cap.appendChild(n);
      }

      fig.appendChild(cap);
      caixa.appendChild(fig);
    });

    caixa.hidden = !algum;
    if (botao && botao._linha) botao._linha.hidden = !algum;
  }

  function esconder() {
    if (caixa) caixa.hidden = true;
    if (botao && botao._linha) botao._linha.hidden = true;
    if (saida) saida.hidden = true;
  }

  // ---------------------------------------------------------------- imagem final
  /** Junta as três miniaturas numa imagem só, com título, legenda e o aviso de triagem. */
  function gerarImagem() {
    var A = api();
    if (!A || !A.S.ref || !A.S.ref.cmp) return;
    var ref = A.S.ref, W = ref.canvas.width, H = ref.canvas.height;

    var usar = A.CMP_MODELS.filter(function (m) { return ref.cmp[m.id] && ref.cmp[m.id].boxes; });
    if (!usar.length) return;

    var lw = 640;                                  // largura de cada painel
    var lh = Math.round(H * (lw / W));
    var gap = 14, top = 52, cap = 44, base = 56;
    var total = usar.length * lw + (usar.length - 1) * gap;

    var c = document.createElement('canvas');
    c.width = total;
    c.height = top + lh + cap + base;
    var ctx = c.getContext('2d');

    ctx.fillStyle = '#0f1413';
    ctx.fillRect(0, 0, c.width, c.height);

    ctx.fillStyle = '#e6eeec';
    ctx.font = '600 24px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('Comparação dos modelos · confiança mínima ' +
      String(A.cmp.conf).replace('.', ','), 16, top / 2);

    usar.forEach(function (m, i) {
      var x = i * (lw + gap);
      var mini = document.createElement('canvas');
      desenharMini(mini, m, A.cmpBoxes(ref, m.id), W, H);
      ctx.drawImage(mini, x, top, lw, lh);
      ctx.strokeStyle = m.cor;
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 1.5, top + 1.5, lw - 3, lh - 3);

      var boxes = A.cmpBoxes(ref, m.id);
      ctx.fillStyle = m.cor;
      ctx.fillRect(x, top + lh + 10, 14, 14);
      ctx.fillStyle = '#e6eeec';
      ctx.font = '600 19px system-ui, sans-serif';
      ctx.fillText('Modelo ' + m.id, x + 22, top + lh + 17);
      ctx.font = '400 16px system-ui, sans-serif';
      ctx.fillStyle = '#9db0ab';
      ctx.fillText(boxes.length + ' caixas · ' +
        pct(A.cmpUnionFrac(boxes, W, H)) + ' da área', x + 22, top + lh + 38);
    });

    ctx.fillStyle = '#9db0ab';
    ctx.font = '400 16px system-ui, sans-serif';
    ctx.fillText('Ferramenta de triagem inicial: não substitui a análise do restaurador ou museólogo.',
      16, c.height - base / 2);

    var url = c.toDataURL('image/jpeg', 0.92);
    img.src = url;
    saida.hidden = false;

    // No notebook baixa direto; no celular, vale o "toque e segure" da dica.
    try {
      var a = document.createElement('a');
      a.href = url;
      a.download = 'comparacao-modelos.jpg';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) { /* o navegador não deixou baixar: a imagem fica na tela */ }

    if (saida.scrollIntoView) saida.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- gatilhos
  function iniciar() {
    estilo();
    var stage = document.getElementById('cmpStage');
    if (!stage) return;

    // o app redesenha o canvas da comparação a cada mudança: isso nos avisa
    new MutationObserver(renderizar).observe(stage, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['width', 'height']
    });

    var conf = document.getElementById('cmpConf');
    if (conf) conf.addEventListener('input', renderizar);

    renderizar();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();