/*
 * Modelo treinado (YOLOv8n, uma classe "avaria") rodando no aparelho com onnxruntime-web.
 * Sem DOM: funciona no navegador (window.createModelo) e em Node (module.exports), para poder ser testado.
 *
 * Como o modelo foi treinado: recortes de 640 x 640 px de imagens com o lado maior em 2560 px.
 * Por isso a inferencia usa a mesma escala: a foto e levada a 2560 px no lado maior (reduzida ou ampliada)
 * e percorrida em recortes de 640 px com passo de 480 px; as caixas dos recortes passam por NMS.
 * Entrada do modelo: 1 x 3 x 640 x 640 (RGB, 0 a 1). Saida: 1 x 5 x 8400 (cx, cy, largura, altura, confianca).
 */
(function (root) {
  'use strict';

  function createModelo(ort) {
    const M = {
      lado: 2560,          // lado maior da foto na inferencia
      tamanho: 640,        // recorte
      passo: 480,          // deslocamento entre recortes
      nms: 0.45,           // IoU maximo entre caixas mantidas
      confMin: 0.05        // abaixo disso nem guarda a caixa (o app filtra por cima, sem refazer a inferencia)
    };
    let sessao = null, nomeEntrada = null, nomeSaida = null;

    /** modelo: URL (navegador) ou Uint8Array/ArrayBuffer (Node). */
    M.carregar = async function (modelo) {
      sessao = await ort.InferenceSession.create(modelo, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      nomeEntrada = sessao.inputNames[0]; nomeSaida = sessao.outputNames[0];
      return { entrada: nomeEntrada, saida: nomeSaida };
    };
    M.pronto = function () { return !!sessao; };

    /** Non-maximum suppression. caixas: [x1, y1, x2, y2][], pontos: number[]. Devolve os indices mantidos. */
    M.suprimir = function (caixas, pontos, limiar) {
      const ordem = pontos.map((_, i) => i).sort((a, b) => pontos[b] - pontos[a]);
      const mantidos = [];
      const suprimido = new Uint8Array(caixas.length);
      for (let n = 0; n < ordem.length; n++) {
        const i = ordem[n];
        if (suprimido[i]) continue;
        mantidos.push(i);
        const a = caixas[i], areaA = (a[2] - a[0]) * (a[3] - a[1]);
        for (let m = n + 1; m < ordem.length; m++) {
          const j = ordem[m];
          if (suprimido[j]) continue;
          const b = caixas[j];
          const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
          const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
          const uniao = areaA + (b[2] - b[0]) * (b[3] - b[1]) - inter;
          if (inter / (uniao + 1e-9) >= (limiar == null ? M.nms : limiar)) suprimido[j] = 1;
        }
      }
      return mantidos;
    };

    /** Posicoes (x ou y) dos recortes ao longo de um lado de tamanho `total`. */
    function posicoes(total) {
      const fim = Math.max(total - M.tamanho, 0), lista = [];
      for (let p = 0; p <= fim; p += M.passo) lista.push(p);
      if (lista[lista.length - 1] !== fim) lista.push(fim);
      return lista;
    }

    /**
     * canvas: imagem com o lado maior em M.lado (o app cuida de levar a foto a essa escala).
     * opcoes: { progresso(feitos, total), aguardar() } (ambos opcionais; aguardar devolve uma Promise e deixa a tela respirar).
     * Devolve { caixas: [{ x, y, w, h, score }], recortes, ms } no quadro do canvas, com score >= M.confMin.
     */
    M.detectar = async function (canvas, opcoes) {
      if (!sessao) throw new Error('Modelo nao carregado');
      opcoes = opcoes || {};
      const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
      const W = canvas.width, H = canvas.height, T = M.tamanho;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const xs = posicoes(W), ys = posicoes(H), total = xs.length * ys.length;
      const entrada = new Float32Array(3 * T * T);
      const caixas = [], pontos = [];
      let feitos = 0;
      for (const y of ys) {
        for (const x of xs) {
          const rgba = ctx.getImageData(x, y, T, T).data, plano = T * T;
          for (let i = 0, p = 0; i < plano; i++, p += 4) {
            entrada[i] = rgba[p] / 255; entrada[plano + i] = rgba[p + 1] / 255; entrada[2 * plano + i] = rgba[p + 2] / 255;
          }
          const resultado = await sessao.run({ [nomeEntrada]: new ort.Tensor('float32', entrada, [1, 3, T, T]) });
          const s = resultado[nomeSaida].data, n = resultado[nomeSaida].dims[2];
          for (let i = 0; i < n; i++) {
            const confianca = s[4 * n + i];
            if (confianca < M.confMin) continue;
            const cx = s[i], cy = s[n + i], bw = s[2 * n + i], bh = s[3 * n + i];
            caixas.push([x + cx - bw / 2, y + cy - bh / 2, x + cx + bw / 2, y + cy + bh / 2]); pontos.push(confianca);
          }
          feitos++;
          if (opcoes.progresso) opcoes.progresso(feitos, total);
          if (opcoes.aguardar) await opcoes.aguardar();
        }
      }
      const mantidos = M.suprimir(caixas, pontos);
      const saida = mantidos.map((i) => {
        const x0 = Math.max(0, caixas[i][0]), y0 = Math.max(0, caixas[i][1]), x1 = Math.min(W, caixas[i][2]), y1 = Math.min(H, caixas[i][3]);
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, score: pontos[i] };
      }).filter((c) => c.w >= 2 && c.h >= 2);
      return { caixas: saida, recortes: total, ms: (typeof performance !== 'undefined' ? performance : Date).now() - t0 };
    };

    return M;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = createModelo;
  else root.createModelo = createModelo;
})(typeof window !== 'undefined' ? window : globalThis);
