# Triagem de Avarias

Ferramenta de triagem inicial de avarias em obras de arte, pensada para museus com orçamento limitado. Roda inteira no navegador do celular (on-device), sem servidor e sem enviar fotos para lugar nenhum.

Trabalho: *Mobile-Assisted Organoleptic and Optical Evaluation for Museum Preservation* (Ibmec, SBrT 2026).

Princípio central: a ferramenta **nunca substitui o profissional**. Ela só organiza a fila de inspeção e poupa tempo antes do olhar do restaurador ou museólogo.

## Como abrir

**No celular (jeito usado na demonstração):** abra `https://giovannaperrone.github.io/mobile-art-evaluation/` no navegador. É o GitHub Pages deste repositório: cada `commit` na branch `main` atualiza o site em cerca de 1 minuto. Se o repositório for renomeado, o endereço muda junto (`https://USUARIO.github.io/NOME-DO-REPOSITORIO/`).

**No PC:** abra a pasta no VS Code, instale a extensão **Live Server** (Ritwick Dey), clique com o botão direito em `index.html` e escolha "Open with Live Server".

**Sem VS Code:** rode `npm run build`. O arquivo `dist/triagem-de-avarias.html` já tem tudo dentro e pode ser aberto direto ou hospedado em qualquer lugar.

Na primeira abertura a página baixa o OpenCV.js (cerca de 13 MB) de uma CDN. Precisa de internet nessa hora.

## Como usar

1. Escolha o **tipo de obra**: *Pintura* (procura rachaduras e perda de cor) ou *Impresso ou ilustração* (procura manchas escuras, como ferrugem e tinta solta, e ignora o desenho).
2. Tire a foto de referência (luz normal, peça inteira no quadro).
3. Em "Recortar a peça", corte mesa, parede e objetos ao redor até a linha tracejada ficar sobre a borda da obra.
4. Opcional: em "Mais fotos", adicione quantas fotos quiser, de detalhe (aproxime de uma região) e/ou com luz rasante. Cada uma é alinhada à referência por ORB e analisada na resolução dela.
5. Leia a prioridade e a tabela. Use "Regiões descartadas" para ver o que não foi analisado.

## Estrutura

```
triagem-de-avarias/
  index.html            tela (só a marcação)
  css/style.css         aparência, claro e escuro
  js/pipeline.js        visão computacional: iluminação, rejeição, detecção (pintura e impresso), ORB
  js/app.js             interface: leitura das fotos, botões, desenho do mapa, relatório
  build.js              junta tudo num único HTML (dist/)
  tests/                testes com imagens sintéticas e script para foto real
  package.json
```

Regra para mexer: tudo que é conta de visão fica em `js/pipeline.js`. Tudo que é tela fica em `js/app.js`, `index.html` e `css/style.css`.

## O que o pipeline faz (`js/pipeline.js`)

| Etapa | Função | O que acontece |
|---|---|---|
| 1. Iluminação | `checkIllumination` | Mede luminância média, pixels saturados e pixels escuros. Rejeita a captura fora da faixa (padrão 60 a 210). |
| 2a. Rejeição | dentro de `detectDamage` | Divide a imagem em quadrados de 32 px e descarta os que não têm sinal de dano (black-hat para rachaduras, distância ao fundo local em HSV para perda de cor). |
| 2b. Detecção | dentro de `detectDamage` | Nos quadrados candidatos, separa componentes conexos e filtra por tamanho e formato. Resultado: caixas de **rachadura** e **perda de cor**. |
| 2c. Impresso | `detectPrint` | Modo para ilustração e arte impressa. Descarta regiões com muito detalhe impresso (densidade de contornos acima de 36%) e, nas regiões planas, procura manchas escuras compactas: remove os traços finos por abertura morfológica e compara com a cor local (mediana). Resultado: caixas de **mancha**. |
| 3. Condition Map | `registerCaptures`, `mergeDetections` | ORB acha pontos de interesse nas duas fotos, a homografia (RANSAC) alinha a 2ª foto à referência, e os danos das duas capturas viram um mapa único. |
| Triagem | `triage` | Soma área afetada e número de danos e dá prioridade baixa, média ou alta. Os limites são heurísticos. |

Todos os limiares estão em `P.params`, no topo de `createPipeline`. Quatro têm controle deslizante na tela ("Ajustar sensibilidade"), dois por tipo de obra.

Fotos adicionais: cada foto é alinhada à referência (`registerCaptures`), analisada na resolução dela (`sideEff` mantém os tamanhos físicos iguais aos da foto geral), e as caixas voltam ao quadro da referência por `mapBoxes`. `mergeAll` junta tudo e marca em quais capturas cada dano apareceu.

## Limitações conhecidas

- O detector é de visão clássica (morfologia, HSV, densidade de contornos). **Ainda não há modelo YOLO.** O artigo cita YOLO, então o texto precisa refletir isso ou o modelo precisa ser encaixado.
- A "iluminação" vem da luminância da própria foto. O navegador não dá acesso ao sensor de luz ambiente do aparelho.
- **Modo impresso:** em ilustração, uma mancha pequena não se distingue do desenho. Por isso o app descarta as regiões com muito detalhe (na peça de teste, uns 75% da área) e só analisa as planas. Nas descartadas, a análise continua sendo do profissional. Ainda sobram falsos positivos em bordas de objetos escuros.
- Modo pintura: a perda de cor assume camada de preparo clara e pouco saturada; rachaduras encostadas na borda da foto podem virar falso positivo. Em arte impressa, esse modo marca o desenho inteiro (200+ caixas na peça de teste); use o modo impresso.
- A luz rasante não filtra falso positivo: na peça de teste a foto "rasante" não mostrou sombras de relevo, e a diferença entre as fotos alinhadas só destacou os traços do desenho (desalinhamento de 1 a 2 px). Ela serve para mais cobertura, não para confirmar dano.
- Os parâmetros do modo impresso foram calibrados em uma única peça (steelbook de jogo, foto com 7 áreas de dano apontadas à mão). Falta validar em mais peças e em fotos de museu.

## Testes

```
npm install
npm test
```

- `npm run test:pipeline` gera uma pintura sintética com 3 rachaduras e 1 perda de cor, confere a detecção, a rejeição por iluminação e o alinhamento ORB.
- `npm run test:ui` simula a página inteira (jsdom): foto de referência, foto rasante, foto de detalhe (confere que foi reconhecida como zoom), modo impresso, recorte, remoção de foto, tabela, mapa e relatório. Gera `tests/saida/mapa-teste.jpg`.
- `node tests/real-foto.js foto.jpg [rotulos.png]` roda o modo impresso numa foto real (fora do repositório) e gera `tests/saida/real-foto.jpg`. Com `rotulos.png` (8 bits, áreas de dano conhecidas) conta quantas áreas receberam marcação. Variável `RECORTE=esq,topo,dir,base` (frações) define o recorte.

## Dados para a seção de resultados

Em "Dados da execução", a página mostra dispositivo, resolução original e processada, tamanho do arquivo, luminância, quadrados descartados, pontos ORB, inliers e o tempo de cada etapa. O botão "Copiar relatório (JSON)" leva tudo isso para a área de transferência. Esses números servem direto para os Experimentos 1 e 2 do artigo (resolução efetiva e iluminação).
