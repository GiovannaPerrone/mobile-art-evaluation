/*
  Lista de achados mais legível — arquivo independente.

  Como usar: no index.html, depois do comparar.js

      <script src="js/achados.js"></script>

  Precisa da linha que já existe no fim do app.js:
      window.__triagem = { S: S, ... };

  O que faz, sem tocar no app.js:
    - acrescenta uma miniatura recortada da obra em cada linha da tabela,
      para o profissional ver do que se trata sem procurar no mapa;
    - ordena da marca mais confiante para a menos;
    - mostra a confiança do modelo quando houver.
*/

(function () {
  'use strict';

  var LADO = 72;    // tamanho da miniatura na tela, em pixels
  var FOLGA = 0.25; // quanto de contexto em volta da caixa (25% do lado maior)

  var api = function () { return window.__triagem; };
  var ajustando = false;   // evita que a nossa própria mudança nos chame de novo

  function estilo() {
    if (document.getElementById('achadosCss')) return;
    var s = document.createElement('style');
    s.id = 'achadosCss';
    s.textContent = [
      '.ach-mini{width:' + LADO + 'px;height:' + LADO + 'px;border-radius:6px;display:block;',
      '  border:2px solid rgba(255,255,255,.2);background:#0f1413}',
      '.ach-col{width:' + (LADO + 8) + 'px}',
      '.ach-conf{display:block;font:400 12px system-ui,sans-serif;opacity:.7;margin-top:2px}'
    ].join('');
    document.head.appendChild(s);
  }

  /** Recorta o pedaço da obra em volta da caixa, com um pouco de contexto. */
  function miniatura(entrada) {
    var A = api();
    var fonte = A.S.ref && A.S.ref.canvas;
    if (!fonte) return null;

    var folga = Math.max(8, Math.max(entrada.w, entrada.h) * FOLGA);
    var lado = Math.max(entrada.w, entrada.h) + folga * 2;      // recorte quadrado
    var cx = entrada.x + entrada.w / 2, cy = entrada.y + entrada.h / 2;
    var sx = Math.max(0, Math.min(fonte.width - lado, cx - lado / 2));
    var sy = Math.max(0, Math.min(fonte.height - lado, cy - lado / 2));
    var sl = Math.min(lado, fonte.width, fonte.height);

    var cv = document.createElement('canvas');
    cv.width = LADO * 2;            // o dobro, para não ficar borrado em tela retina
    cv.height = LADO * 2;
    cv.className = 'ach-mini';
    cv.style.width = LADO + 'px';
    cv.style.height = LADO + 'px';

    var ctx = cv.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(fonte, sx, sy, sl, sl, 0, 0, cv.width, cv.height);

    // a caixa desenhada por cima, na mesma proporção do recorte
    var k = cv.width / sl;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeRect((entrada.x - sx) * k, (entrada.y - sy) * k, entrada.w * k, entrada.h * k);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ff4b33';
    ctx.strokeRect((entrada.x - sx) * k, (entrada.y - sy) * k, entrada.w * k, entrada.h * k);

    cv.title = 'Trecho da obra em volta da marca #' + entrada.id;
    return cv;
  }

  /** Quanto a marca "vale": a confiança do modelo quando houver, senão a área. */
  function peso(e, totalArea) {
    if (e.scoreModelo != null) return 1 + e.scoreModelo;     // marcas do modelo vêm primeiro
    return (e.w * e.h) / totalArea;                          // as clássicas, pela área
  }

  function ajustar() {
    if (ajustando) return;
    var A = api();
    var corpo = document.getElementById('tblBody');
    if (!A || !corpo || !A.S.merged || !A.S.ref) return;

    var linhas = Array.prototype.slice.call(corpo.rows);
    if (!linhas.length || linhas.length !== A.S.merged.length) return;

    ajustando = true;
    try {
      cabecalho();
      var W = A.S.ref.canvas.width, H = A.S.ref.canvas.height, total = W * H;

      // junta cada linha ao dado que a gerou (o app cria as linhas na ordem de S.merged)
      var itens = linhas.map(function (tr, i) {
        return { tr: tr, e: A.S.merged[i], p: peso(A.S.merged[i], total) };
      });

      itens.forEach(function (it) {
        if (it.tr.dataset.achEnfeitado) return;
        it.tr.dataset.achEnfeitado = '1';

        var td = document.createElement('td');
        td.className = 'ach-col';
        var mini = miniatura(it.e);
        if (mini) td.appendChild(mini);
        it.tr.insertBefore(td, it.tr.firstChild);

        // confiança do modelo, quando existir, logo abaixo do tipo
        if (it.e.scoreModelo != null && it.tr.cells[2]) {
          var sp = document.createElement('span');
          sp.className = 'ach-conf';
          sp.textContent = 'confiança ' + it.e.scoreModelo.toFixed(2).replace('.', ',');
          it.tr.cells[2].appendChild(sp);
        }
      });

      // da mais confiante para a menos
      itens.sort(function (a, b) { return b.p - a.p; });
      var frag = document.createDocumentFragment();
      itens.forEach(function (it) { frag.appendChild(it.tr); });
      corpo.appendChild(frag);
    } finally {
      ajustando = false;
    }
  }

  /** Acrescenta a coluna da miniatura no cabeçalho da tabela, uma vez só. */
  function cabecalho() {
    var wrap = document.getElementById('tblWrap');
    if (!wrap) return;
    var tr = wrap.querySelector('thead tr');
    if (!tr || tr.dataset.achCabecalho) return;
    tr.dataset.achCabecalho = '1';
    var th = document.createElement('th');
    th.textContent = 'Trecho';
    th.className = 'ach-col';
    tr.insertBefore(th, tr.firstChild);
  }

  function iniciar() {
    estilo();
    var corpo = document.getElementById('tblBody');
    if (!corpo) return;
    // o app refaz a tabela a cada análise: isso nos avisa
    new MutationObserver(function () { setTimeout(ajustar, 0); })
      .observe(corpo, { childList: true });
    ajustar();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();