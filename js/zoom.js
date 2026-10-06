/*
  Zoom e arrastar no mapa — arquivo independente.

  Como usar: incluir no index.html DEPOIS do app.js

      <script src="js/zoom.js"></script>

  Não mexe em nada do app.js. Funciona no mapa principal (#stage) e no
  painel de comparação (#cmpStage): acha o <canvas> que estiver dentro e
  aplica um transform de CSS por cima. O desenho continua igual — o canvas
  é redesenhado na resolução de sempre, só a apresentação é ampliada.

  Gestos:
    roda do mouse            zoom no ponto do cursor
    arrastar com o mouse     move a imagem
    pinça (dois dedos)       zoom
    um dedo arrastando       move
    duplo clique / dois toques   volta ao tamanho original
    botões + − 1:1           para quem prefere tocar
    teclas + − 0 e setas     quando o mapa está em foco
*/

(function () {
  'use strict';

  var MIN = 1;      // não deixa diminuir além do tamanho que cabe na tela
  var MAX = 8;      // 8× é suficiente para ver as caixas menores
  var PASSO = 1.25; // quanto cada clique nos botões amplia

  // ---------------------------------------------------------------- estilos
  // Injetados aqui para o arquivo ser autossuficiente: se preferirem,
  // movam para o css/style.css e apaguem esta função.
  function injetarEstilo() {
    if (document.getElementById('zoomCss')) return;
    var s = document.createElement('style');
    s.id = 'zoomCss';
    s.textContent = [
      '.zoom-area{overflow:hidden;touch-action:none;position:relative;cursor:grab}',
      '.zoom-area.arrastando{cursor:grabbing}',
      '.zoom-area canvas{transform-origin:0 0;will-change:transform;display:block}',
      '.zoom-ctrl{position:absolute;right:8px;bottom:8px;display:flex;gap:4px;z-index:5}',
      '.zoom-ctrl button{min-width:40px;min-height:40px;padding:0 10px;border-radius:8px;',
      '  border:1px solid rgba(255,255,255,.25);background:rgba(16,21,20,.8);color:#e6eeec;',
      '  font:600 15px system-ui,sans-serif;cursor:pointer}',
      '.zoom-ctrl button:hover{background:rgba(16,21,20,.95)}',
      '.zoom-nivel{align-self:center;padding:0 8px;font:600 13px system-ui,sans-serif;',
      '  color:#e6eeec;background:rgba(16,21,20,.8);border-radius:8px;line-height:40px}'
    ].join('');
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------- um mapa
  function ligar(el) {
    if (!el || el.dataset.zoomLigado) return;
    el.dataset.zoomLigado = '1';
    el.classList.add('zoom-area');
    el.tabIndex = 0;   // permite usar o teclado

    var st = { el: el, s: 1, tx: 0, ty: 0, w: 0, h: 0 };
    var pontos = {};   // dedos ou mouse em contato, por id
    var pinca = null;  // distância e centro quando há dois dedos

    function canvas() { return el.querySelector('canvas'); }

    function aplicar() {
      var c = canvas();
      if (!c) return;
      limitar(c);
      c.style.transform = 'translate(' + st.tx + 'px,' + st.ty + 'px) scale(' + st.s + ')';
      if (nivel) nivel.textContent = (st.s < 1.05 ? 1 : Math.round(st.s * 10) / 10) + '×';
    }

    // Impede a imagem de sair da área visível; se couber inteira, centraliza.
    function limitar(c) {
      var vw = el.clientWidth, vh = el.clientHeight;
      var dw = c.offsetWidth * st.s, dh = c.offsetHeight * st.s;
      st.tx = dw <= vw ? (vw - dw) / 2 : Math.min(0, Math.max(vw - dw, st.tx));
      st.ty = dh <= vh ? (vh - dh) / 2 : Math.min(0, Math.max(vh - dh, st.ty));
    }

    // Amplia mantendo fixo o ponto (cx, cy) da área visível.
    function ampliarEm(fator, cx, cy) {
      var s0 = st.s, s1 = Math.max(MIN, Math.min(MAX, s0 * fator));
      if (s1 === s0) return;
      st.tx = cx - (cx - st.tx) * (s1 / s0);
      st.ty = cy - (cy - st.ty) * (s1 / s0);
      st.s = s1;
      aplicar();
    }

    function voltarAoNormal() { st.s = 1; st.tx = 0; st.ty = 0; aplicar(); }

    function centro() { var r = el.getBoundingClientRect(); return { x: r.width / 2, y: r.height / 2 }; }
    function local(ev) { var r = el.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }

    // ------------------------------------------------------------ roda do mouse
    el.addEventListener('wheel', function (ev) {
      if (!canvas()) return;
      ev.preventDefault();                       // sem isso a página inteira rola
      var p = local(ev);
      ampliarEm(ev.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
    }, { passive: false });

    // ------------------------------------------------------------ mouse e dedos
    // Pointer Events tratam mouse, caneta e toque pelo mesmo caminho.
    el.addEventListener('pointerdown', function (ev) {
      if (!canvas()) return;
      el.setPointerCapture(ev.pointerId);
      pontos[ev.pointerId] = local(ev);
      el.classList.add('arrastando');
      var ids = Object.keys(pontos);
      if (ids.length === 2) {
        var a = pontos[ids[0]], b = pontos[ids[1]];
        pinca = { d: Math.hypot(b.x - a.x, b.y - a.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      }
    });

    el.addEventListener('pointermove', function (ev) {
      if (!pontos[ev.pointerId] || !canvas()) return;
      ev.preventDefault();
      var p = local(ev), ids = Object.keys(pontos);

      if (ids.length >= 2 && pinca) {
        // dois dedos: a razão entre as distâncias dá o quanto ampliar
        pontos[ev.pointerId] = p;
        var a = pontos[ids[0]], b = pontos[ids[1]];
        var d = Math.hypot(b.x - a.x, b.y - a.y);
        var cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        if (pinca.d > 0) {
          st.tx += cx - pinca.cx;                // acompanha o centro dos dedos
          st.ty += cy - pinca.cy;
          ampliarEm(d / pinca.d, cx, cy);
        }
        pinca = { d: d, cx: cx, cy: cy };
        return;
      }

      // um ponto: arrasta
      var ant = pontos[ev.pointerId];
      st.tx += p.x - ant.x;
      st.ty += p.y - ant.y;
      pontos[ev.pointerId] = p;
      aplicar();
    });

    function soltar(ev) {
      delete pontos[ev.pointerId];
      if (Object.keys(pontos).length < 2) pinca = null;
      if (!Object.keys(pontos).length) el.classList.remove('arrastando');
    }
    el.addEventListener('pointerup', soltar);
    el.addEventListener('pointercancel', soltar);

    // ------------------------------------------------------------ duplo toque
    el.addEventListener('dblclick', function (ev) {
      ev.preventDefault();
      if (st.s > 1.05) voltarAoNormal();
      else { var p = local(ev); ampliarEm(2.5, p.x, p.y); }
    });

    // O Safari do iPhone tenta ampliar a página inteira com a pinça.
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (n) {
      el.addEventListener(n, function (ev) { ev.preventDefault(); });
    });

    // ------------------------------------------------------------ teclado
    el.addEventListener('keydown', function (ev) {
      var c = centro(), passo = 40;
      if (ev.key === '+' || ev.key === '=') { ampliarEm(PASSO, c.x, c.y); ev.preventDefault(); }
      else if (ev.key === '-' || ev.key === '_') { ampliarEm(1 / PASSO, c.x, c.y); ev.preventDefault(); }
      else if (ev.key === '0') { voltarAoNormal(); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft') { st.tx += passo; aplicar(); ev.preventDefault(); }
      else if (ev.key === 'ArrowRight') { st.tx -= passo; aplicar(); ev.preventDefault(); }
      else if (ev.key === 'ArrowUp') { st.ty += passo; aplicar(); ev.preventDefault(); }
      else if (ev.key === 'ArrowDown') { st.ty -= passo; aplicar(); ev.preventDefault(); }
    });

    // ------------------------------------------------------------ botões
    var nivel = null;
    (function criarBotoes() {
      var pai = el.parentElement;
      if (!pai) return;
      if (getComputedStyle(pai).position === 'static') pai.style.position = 'relative';
      var box = document.createElement('div');
      box.className = 'zoom-ctrl';
      nivel = document.createElement('span');
      nivel.className = 'zoom-nivel';
      nivel.textContent = '1×';
      function botao(txt, rotulo, acao) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = txt; b.setAttribute('aria-label', rotulo);
        b.addEventListener('click', acao);
        return b;
      }
      box.appendChild(nivel);
      box.appendChild(botao('−', 'Diminuir o zoom', function () { var c = centro(); ampliarEm(1 / PASSO, c.x, c.y); }));
      box.appendChild(botao('+', 'Aumentar o zoom', function () { var c = centro(); ampliarEm(PASSO, c.x, c.y); }));
      box.appendChild(botao('1:1', 'Voltar ao tamanho original', voltarAoNormal));
      pai.appendChild(box);
    })();

    // ------------------------------------------------------------ foto nova
    // O app recria o canvas a cada análise. Quando o tamanho muda, é outra
    // imagem: volta ao tamanho original para não abrir ampliado.
    var obs = new MutationObserver(function () {
      var c = canvas();
      if (!c) return;
      if (c.width !== st.w || c.height !== st.h) {
        st.w = c.width; st.h = c.height;
        voltarAoNormal();
      } else {
        aplicar();   // o canvas foi redesenhado: mantém o zoom atual
      }
    });
    obs.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['width', 'height'] });

    aplicar();
  }

  // ---------------------------------------------------------------- início
  function iniciar() {
    injetarEstilo();
    ligar(document.getElementById('stage'));
    ligar(document.getElementById('cmpStage'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();