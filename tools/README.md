# Ferramentas de treino do modelo

Fluxo para treinar o detector YOLO com fotos próprias. As fotos ficam em `dataset/`, que **não vai para o GitHub** (`.gitignore`), porque o repositório é público.

1. `preparar-fotos.py`: corrige a rotação do EXIF e reduz o lado maior para 2560 px, a escala de trabalho do modelo.
   `python tools/preparar-fotos.py dataset/treino-steelbook dataset/trabalho`
2. `rotular.html`: ferramenta para desenhar as caixas de dano nas fotos de `dataset/trabalho`. Abra com duplo clique (ou Live Server). Exporta `rotulos.json`; salve esse arquivo em `dataset/`.
3. `gerar-dataset-yolo.py`: corta as fotos rotuladas em recortes de 640 x 640 px no formato do YOLO e gera `dataset/yolo.zip`. Descarta caixas muito grandes (faixas, logo inteiro) e os recortes que passam por elas. Reserva 2 fotos inteiras para validação.
   `python tools/gerar-dataset-yolo.py` (precisa de Python e `pip install pillow`; também foi rodado pelo Claude e o zip já está em `dataset/`).
4. `treinar-yolo.ipynb`: caderno do Google Colab. Envie o `yolo.zip`, treine, veja as métricas, teste em fotos novas e baixe o `avaria.onnx`.
5. (próximo passo) colocar `avaria.onnx` em `models/` e ligar ao app com `onnxruntime-web`.

## Como rotular

- Uma classe só: `avaria`.
- Marque: ferrugem e manchas escuras de corrosão, tinta soltando ou lascada (por exemplo, o amarelo da lombada), arranhões e riscos que cortam a tinta.
- Não marque: o desenho impresso (painéis escuros, letras, contornos) e reflexo de luz (manchas brancas e brilhantes).
- Manchas muito próximas (a menos de uns 100 px) entram numa caixa só. Mancha isolada ganha caixa própria, de pelo menos uns 40 px.
- Marque "Revisada" em toda foto que terminar, inclusive as que tiverem poucas ou nenhuma caixa: foto revisada sem caixas ensina ao modelo o que não é dano.
