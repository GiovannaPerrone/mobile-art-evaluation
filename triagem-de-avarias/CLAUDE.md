# CLAUDE.md

Contexto do projeto para o Claude. Leia antes de mexer em qualquer arquivo.

## O que é

Web app de **triagem de avarias em obras de arte**, de baixo custo, para museus com orçamento limitado. Trabalho acadêmico do Ibmec (artigo SBrT 2026, "Mobile-Assisted Organoleptic and Optical Evaluation for Museum Preservation").

Princípio central, que vale para todo texto, interface e código: **a ferramenta nunca substitui o profissional** (restaurador, museólogo). Ela só prioriza a fila de inspeção e poupa tempo na triagem inicial.

Prazo da demonstração: terça-feira, 06/10/2026. Precisa funcionar no celular (Samsung Galaxy Z Flip 7).

## Como funciona

Página estática, sem backend. Tudo roda no navegador do celular (on-device). O motor de visão é o OpenCV.js, carregado por CDN em `js/app.js` (primeira abertura baixa cerca de 13 MB).

| Arquivo | Papel |
|---|---|
| `index.html` | Marcação da tela |
| `css/style.css` | Aparência, tema claro e escuro (tokens em `:root`) |
| `js/pipeline.js` | Visão computacional (sem DOM). Funciona no navegador e no Node |
| `js/app.js` | Interface: leitura das fotos, botões, desenho do mapa, relatório JSON |
| `build.js` | Gera `dist/triagem-de-avarias.html` (arquivo único). Não edite o `dist/` à mão |
| `tests/` | Testes com imagens sintéticas (Node + jsdom) |

Pipeline (`js/pipeline.js`, função `createPipeline(cv)`):

1. `checkIllumination`: rejeita a captura fora da faixa de luminância (60 a 210), com saturação ou áreas escuras demais.
2. `detectDamage`: (a) rejeição por quadrados de 32 px, descartando regiões sem sinal de dano; (b) detecção nos quadrados candidatos. Classes: `rachadura` (black-hat) e `perda de cor` (distância em HSV ao fundo local, com prior de camada de preparo clara e pouco saturada).
3. `registerCaptures`: ORB + BFMatcher (teste de razão 0,75) + homografia RANSAC alinha a 2ª captura (luz rasante ou transmitida) à referência.
4. `mergeDetections`: une os danos das duas capturas (confirmação cruzada por IoU).
5. `triage`: prioridade baixa, média ou alta (limites heurísticos).

Todos os limiares ficam em `P.params`, no topo de `createPipeline`.

## Estado atual e decisões

- O detector é de **visão clássica**. Ainda **não há YOLO**. O artigo cita YOLO leve, então: ou o modelo é encaixado, ou o texto do artigo é ajustado (YOLO como trabalho futuro).
- Plano do YOLO: `yolov8n` ou `yolo11n`, 2 classes (`rachadura`, `perda_de_cor`), treinado no Google Colab, exportado para ONNX e executado no navegador com `onnxruntime-web`. As caixas do YOLO entram no lugar da etapa de detecção 2b; o resto do pipeline continua igual.
- Datasets candidatos (todos licença não comercial, citar a fonte):
  - ArtInsight (pinturas de cavalete, polígonos JSON, perda de camada de tinta): Zenodo, DOI 10.5281/zenodo.8429814
  - Heritage Cracks (paredes históricas, já em formato YOLO, classe "cracks"): Mendeley Data, DOI 10.17632/b32hyvv2nn.3
  - MuralDH (murais, máscaras PNG): github.com/tearsheaven/MuralDH
- Download e treino são feitos pela usuária (o ambiente do Claude não acessa esses sites). Decisão no domingo: se não houver modelo bom, manter o detector clássico.
- O artigo descreve um sensor de luz ambiente, mas o navegador não dá acesso a ele. O app usa a luminância da própria foto. O texto da seção II precisa refletir isso.
- Ignorar do artigo tudo a partir da "Semana 7" (é template de outro grupo, sobre mochila antifurto).

## Limitações conhecidas

- Testado só com imagens sintéticas, com 2 a 3 falsos positivos por imagem (bordas fortes de cor). Falta testar com fotos reais de obra.
- Rachaduras encostadas na borda da foto podem virar falso positivo.
- Perda de cor assume camada de preparo clara e pouco saturada.
- Alinhamento ORB falha em superfícies lisas ou com muito reflexo.

## Comandos

```
npm install        # uma vez
npm test           # test:pipeline + test:ui
npm run build      # gera dist/triagem-de-avarias.html
```

Para ver no navegador: Live Server (extensão do VS Code) em `index.html`. Para testar no celular, usar `http://IP-DO-PC:5500` na mesma rede Wi-Fi.

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
