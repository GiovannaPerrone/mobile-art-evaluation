# Triagem de Avarias

Ferramenta de triagem inicial de avarias em obras de arte, pensada para museus com orçamento limitado. Roda inteira no navegador do celular (on-device), sem servidor e sem enviar fotos para lugar nenhum.

Trabalho: *Mobile-Assisted Organoleptic and Optical Evaluation for Museum Preservation* (Ibmec, SBrT 2026).

Princípio central: a ferramenta **nunca substitui o profissional**. Ela só organiza a fila de inspeção e poupa tempo antes do olhar do restaurador ou museólogo.

## Como abrir

**Jeito mais simples (PC):** abra a pasta no VS Code, instale a extensão **Live Server** (Ritwick Dey), clique com o botão direito em `index.html` e escolha "Open with Live Server".

**No celular:** com o Live Server rodando e o celular no mesmo Wi-Fi, abra `http://IP-DO-PC:5500` no navegador do celular. No Windows, o IP aparece em `ipconfig` (linha "Endereço IPv4").

**Sem VS Code:** rode `npm run build`. O arquivo `dist/triagem-de-avarias.html` já tem tudo dentro e pode ser aberto direto, enviado por e-mail ou hospedado em qualquer lugar.

Na primeira abertura a página baixa o OpenCV.js (cerca de 13 MB) de uma CDN. Precisa de internet nessa hora.

## Estrutura

```
triagem-de-avarias/
  index.html            tela (só a marcação)
  css/style.css         aparência, claro e escuro
  js/pipeline.js        visão computacional: iluminação, rejeição, detecção, ORB
  js/app.js             interface: leitura das fotos, botões, desenho do mapa, relatório
  build.js              junta tudo num único HTML (dist/)
  tests/                testes com imagens sintéticas
  package.json
```

Regra para mexer: tudo que é conta de visão fica em `js/pipeline.js`. Tudo que é tela fica em `js/app.js`, `index.html` e `css/style.css`.

## O que o pipeline faz (`js/pipeline.js`)

| Etapa | Função | O que acontece |
|---|---|---|
| 1. Iluminação | `checkIllumination` | Mede luminância média, pixels saturados e pixels escuros. Rejeita a captura fora da faixa (padrão 60 a 210). |
| 2a. Rejeição | dentro de `detectDamage` | Divide a imagem em quadrados de 32 px e descarta os que não têm sinal de dano (black-hat para rachaduras, distância ao fundo local em HSV para perda de cor). |
| 2b. Detecção | dentro de `detectDamage` | Nos quadrados candidatos, separa componentes conexos e filtra por tamanho e formato. Resultado: caixas de **rachadura** e **perda de cor**. |
| 3. Condition Map | `registerCaptures`, `mergeDetections` | ORB acha pontos de interesse nas duas fotos, a homografia (RANSAC) alinha a 2ª foto à referência, e os danos das duas capturas viram um mapa único. |
| Triagem | `triage` | Soma área afetada e número de danos e dá prioridade baixa, média ou alta. Os limites são heurísticos. |

Todos os limiares estão em `P.params`, no topo de `createPipeline`. Dois deles têm controle deslizante na tela ("Ajustar sensibilidade").

## Limitações conhecidas

- O detector é de visão clássica (morfologia e HSV). **Ainda não há modelo YOLO.** O artigo cita YOLO, então o texto precisa refletir isso ou o modelo precisa ser encaixado.
- A "iluminação" vem da luminância da própria foto. O navegador não dá acesso ao sensor de luz ambiente do aparelho.
- A detecção de perda de cor assume que a camada de preparo exposta é clara e pouco saturada.
- Foi testada com imagens sintéticas e ainda com poucas fotos reais. Nos testes sintéticos houve 2 a 3 falsos positivos por imagem, em geral em bordas fortes de cor.
- Rachaduras que encostam na borda da foto podem aparecer como falso positivo.

## Testes

```
npm install
npm test
```

- `npm run test:pipeline` gera uma pintura sintética com 3 rachaduras e 1 perda de cor, confere a detecção, a rejeição por iluminação e o alinhamento ORB.
- `npm run test:ui` simula a página inteira (jsdom), escolhe as fotos, confere tabela, mapa e relatório. Gera `tests/saida/mapa-teste.jpg`.

## Dados para a seção de resultados

Em "Dados da execução", a página mostra dispositivo, resolução original e processada, tamanho do arquivo, luminância, quadrados descartados, pontos ORB, inliers e o tempo de cada etapa. O botão "Copiar relatório (JSON)" leva tudo isso para a área de transferência. Esses números servem direto para os Experimentos 1 e 2 do artigo (resolução efetiva e iluminação).
