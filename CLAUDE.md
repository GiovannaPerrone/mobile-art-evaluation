# CLAUDE.md

Contexto do projeto para o Claude. Leia antes de mexer em qualquer arquivo.

## O que é

Web app de **triagem de avarias em obras de arte**, de baixo custo, para museus com orçamento limitado. Trabalho acadêmico do Ibmec (artigo SBrT 2026, "Mobile-Assisted Organoleptic and Optical Evaluation for Museum Preservation").

Princípio central, que vale para todo texto, interface e código: **a ferramenta nunca substitui o profissional** (restaurador, museólogo). Ela só prioriza a fila de inspeção e poupa tempo na triagem inicial.

Prazo da demonstração: terça-feira, 06/10/2026. Precisa funcionar no celular (Galaxy A57 e iPhone).

## Como funciona

Página estática, sem backend. Tudo roda no navegador do celular (on-device). O motor de visão é o OpenCV.js, carregado por CDN em `js/app.js` (primeira abertura baixa cerca de 13 MB).

| Arquivo | Papel |
|---|---|
| `index.html` | Marcação da tela |
| `css/style.css` | Aparência, tema claro e escuro (tokens em `:root`) |
| `js/pipeline.js` | Visão computacional (sem DOM). Funciona no navegador e no Node |
| `js/modelo.js` | Modelo treinado (YOLOv8n ONNX) com onnxruntime-web, sem DOM. Recortes de 640 px, NMS |
| `js/app.js` | Interface: leitura das fotos, botões, desenho do mapa, relatório JSON |
| `models/yolo-A-pinturas.onnx` | Modelo treinado (12 MB), carregado só se a opção experimental for ligada |
| `build.js` | Gera `dist/triagem-de-avarias.html` (arquivo único). Não edite o `dist/` à mão |
| `tests/` | Testes com imagens sintéticas (Node + jsdom) |

Pipeline (`js/pipeline.js`, função `createPipeline(cv)`):

1. `checkIllumination`: rejeita a captura fora da faixa de luminância (60 a 210), com saturação ou áreas escuras demais.
2. `detectDamage`: (a) rejeição por quadrados de 32 px, descartando regiões sem sinal de dano; (b) detecção nos quadrados candidatos. Classes: `rachadura` (black-hat) e `perda de cor` (distância em HSV ao fundo local, com prior de camada de preparo clara e pouco saturada).
3. `registerCaptures`: ORB + BFMatcher (teste de razão 0,75) + homografia RANSAC alinha a 2ª captura (luz rasante ou transmitida) à referência.
4. `mergeAll`: une os danos da referência e de qualquer número de fotos adicionais (detalhes e/ou luz rasante), com confirmação cruzada por IoU. Cada foto adicional é alinhada por ORB, analisada na resolução dela (`sideEff`) e levada ao quadro da referência por `mapBoxes`.
5. `triage`: prioridade baixa, média ou alta (limites heurísticos, diferentes no modo impresso).

Dois tipos de obra (seletor na tela): **pintura** (`detectDamage`, rachaduras e perda de cor) e **impresso ou ilustração** (`detectPrint`, manchas). O modo impresso descarta regiões com muito detalhe impresso e, nas planas, remove traços finos por abertura e compara com a cor local. Nasceu de uma falha real: em arte impressa o modo pintura marcou ~200 "rachaduras" sobre o contorno do desenho. Também há recorte da peça (4 sliders) para tirar mesa e objetos ao redor.

Todos os limiares ficam em `P.params`, no topo de `createPipeline`.

## Estado atual e decisões

- O motor principal e o padrão é o **detector clássico** (OpenCV.js). Ele também é o plano B se o modelo não carregar.
- **YOLO integrado como modo experimental** ("Detector adicional" > "Modelo treinado (experimental)", desligado por padrão). YOLOv8n de uma classe ("avaria"), exportado para ONNX e executado com `onnxruntime-web` 1.30.0 (WASM, CDN jsDelivr). A foto vai a 2560 px no lado maior e é percorrida em recortes de 640 px com passo 480 (mesma escala do treino); NMS 0,45; confiança padrão 0,10 (slider). As caixas só do modelo aparecem em violeta com a letra A; as que o detector clássico também achou ganham o campo `motores` com os dois. Primeiro uso baixa ~12 MB; ~8 s por foto no Chromium headless, o celular deve ser mais lento.
- Modelos treinados no Colab (`tools/` tem os scripts de dataset e avaliação; `dataset/` não vai para o git):
  - **A** (pinturas, ArtInsight + rótulos da autora; 142 treino/9 val): é o que está no app. Melhor em dentro do domínio (perda de tinta em pinturas ArtInsight, 42/165 polígonos tocados a conf 0,10), quase silencioso em álbuns. **Não generaliza** para pinturas do Met nem para a viseira de metal.
  - **B** (A + steelbook): só ajuda na viseira de metal e inunda os álbuns em confiança baixa. Não está no app.
  - Combinar A com o clássico dá ganho modesto (51/165); os dois quase não se sobrepõem.
- Só o modelo A vai para o git (`models/yolo-A-pinturas.onnx`). O B e o modelo antigo ficam fora.
- Licenças: ArtInsight CC-BY-4.0 (Zenodo 15640972 e 8429815), Met Open Access CC0, Heritage Cracks CC BY-NC 4.0, MaskCLP. O repositório é público: citar as fontes.
- O artigo descreve um sensor de luz ambiente, mas o navegador não dá acesso a ele. O app usa a luminância da própria foto. O texto da seção II precisa refletir isso.
- Ignorar do artigo tudo a partir da "Semana 7" (é template de outro grupo, sobre mochila antifurto).

## Limitações conhecidas

- Modo pintura clássico: testado só com imagens sintéticas e poucas pinturas reais (6 a 10 de 165 polígonos ArtInsight tocados). Em arte impressa ele não serve.
- Modelo treinado: conjuntos de teste minúsculos e gabarito incompleto; os testes do ArtInsight são do mesmo dataset do treino; rachaduras rotuladas em áreas largas; imagens do Met ampliadas. Os números servem como indício, não como métrica final. Fotos do modelo anotadas pela autora, não por especialistas.
- Modo impresso: calibrado em uma peça só (steelbook de Cyberpunk 2077 da Giovanna, 7 áreas de dano circuladas por ela). Nessa peça: 49 manchas, as 7 áreas com ao menos uma marcação, ~75% da área descartada por detalhe, ~0,3 s no Node. A foto de teste não está no repositório. Rodar com `node tests/real-foto.js`.
- A luz rasante não filtrou falso positivo na peça de teste (sem sombras de relevo visíveis; a diferença entre fotos só destacou traços do desenho). Serve como cobertura extra.
- Rachaduras encostadas na borda da foto podem virar falso positivo.
- Perda de cor assume camada de preparo clara e pouco saturada.
- Alinhamento ORB falha em superfícies lisas ou com muito reflexo.

## Comandos

```
npm install        # uma vez
npm test           # test:pipeline + test:modelo + test:ui (o de inferência pula se faltar o .onnx)
node tests/modelo-foto.js foto.jpg   # classico + modelo numa foto real
node tests/real-foto.js foto.jpg [rotulos.png]   # foto real, modo impresso
npm run build      # gera dist/triagem-de-avarias.html
```

Site publicado (GitHub Pages, branch `main`, pasta raiz): `https://giovannaperrone.github.io/mobile-art-evaluation/` (o repositório foi renomeado para `mobile-art-evaluation`; o endereço antigo `.../triagem-de-avarias/` não existe mais). Cada commit atualiza o site em cerca de 1 minuto. Live Server não funcionou na rede dela, por isso o celular usa o Pages.

## Regras ao mexer no código

- Rode `npm test` depois de cada mudança em `js/pipeline.js` ou `js/app.js`.
- Contas de visão ficam em `js/pipeline.js`. Tela fica em `index.html`, `css/` e `js/app.js`.
- Textos da interface em português do Brasil.
- Toda Mat do OpenCV.js criada precisa de `.delete()` (não há coletor de lixo para elas).
- Cores vêm dos tokens de `css/style.css`, nunca literais, para funcionar nos dois temas.

## Como trabalhar com a Giovanna

- Responder em português, tom informal e direto.
- Explicar em passos pequenos, um de cada vez, e dizer o porquê.
- Usar nomes de variáveis descritivos (por exemplo `numero`, não `s`).
- Sem emojis.
- Ser honesta sobre limites e incertezas, sem bajulação.
