"""
Gera dano SINTETICO (por codigo, sem IA generativa) em pinturas LIMPAS e monta recortes de 640 x 640 px
no formato do YOLO, com a caixa nascendo junto com o dano.

Tipos de dano, imitando o que aparece nos rotulos reais (os tres ultimos sao os SUTIS, --sutis):
  - perda de tinta: mancha irregular e alongada que mostra a camada de preparo (creme/bege) ou a tela,
    mantendo a textura de baixo, com borda escura fina (degrau da tinta)
  - lacuna escura: buraco pequeno e escuro (como os furos em douramento)
  - perda sutil: perda pequena e apagada, o preparo aparece so em parte, misturado a cor do lugar
  - desgaste: tinta afinada (mais clara, menos saturada, com pontinhos), sem borda nitida
  - lascas: grupo de 4 a 10 lascas minusculas numa area pequena; a caixa cobre o grupo
  - craquele (DESLIGADO por padrao, ligue com --craquele 0.2): rede de rachaduras numa regiao; a caixa
    cobre a regiao inteira. Fica desligado porque varias pinturas "limpas" ja tem craquele fino real sem
    caixa (a autora nao marca craquele de idade), e misturar os dois ensinaria coisas contraditorias.

Entrada : pinturas limpas = fotos REVISADAS SEM NENHUMA CAIXA nos JSON do rotular.html.
          So entram as marcadas como "treino" (ou sem linha) nos CSV de fontes; "teste" nunca entra.
Saida   : dataset/yolo-sintetico/images/train + labels/train   (so recortes sinteticos)
          dataset/<base>-sint/  = base (ex.: yolo-A) + recortes sinteticos no treino; validacao igual a da base
          dataset/<base>-sint.zip  (para o Colab)
          dataset/sintetico-amostras/  (algumas imagens com as caixas desenhadas, para conferir a olho)

Uso (na pasta do projeto):
    python tools/gerar-dano-sintetico.py --base yolo-A --recortes 140
    python tools/gerar-dano-sintetico.py --base yolo-A --recortes 86 --sutis 0.5 --sufixo sint2

Versao com correcao de falso alarme em reflexo (sint3):
    python tools/gerar-dano-sintetico.py --base yolo-A --recortes 86 --sem-desgaste --negativos-brilho 86 --sufixo sint3

Regra de bolso: no maximo tantos recortes sinteticos quanto recortes reais com dano na base.
"""
import argparse
import csv
import json
import random
import shutil
import zipfile
from pathlib import Path

import cv2
import numpy as np

TAMANHO = 640
PARES_ROTULOS_PASTAS = [
    ('rotulos-tabalho-met.json', 'trabalho-met'),
    ('rotulos-met-selecionadas.json', 'trabalho-met-candidatas-selecionadas'),
    ('rotulos-novas2.json', 'trabalho-met-novas2'),
]
CSVS_FONTES = ['fontes-met.csv', 'fontes-met-novas.csv', 'fontes-met-novas2.csv',
               'fontes-met-candidatas-selecionadas.csv', 'fontes-met-candidatas-tela.csv']
# cores (BGR) da camada de preparo e da tela exposta
CORES_PREPARO = [(170, 200, 220), (180, 210, 225), (150, 185, 205), (120, 150, 180), (95, 120, 150), (200, 220, 230)]


# ---------------------------------------------------------------- ferramentas de forma

def ruido_suave(altura, largura, escala, gerador):
    """Ruido suave (valores 0 a 1) feito de ruido branco pequeno ampliado."""
    pequena = gerador.random((max(2, altura // escala + 2), max(2, largura // escala + 2))).astype(np.float32)
    grande = cv2.resize(pequena, (largura, altura), interpolation=cv2.INTER_CUBIC)
    return (grande - grande.min()) / (grande.max() - grande.min() + 1e-6)


def mancha_irregular(lado_maior, alongamento, gerador):
    """Mascara (0 ou 1) de uma mancha irregular, girada e alongada. Devolve a mascara recortada."""
    largura = max(8, int(lado_maior))
    altura = max(6, int(lado_maior / alongamento))
    tela = int(np.hypot(largura, altura)) + 8
    y, x = np.mgrid[0:tela, 0:tela].astype(np.float32)
    centro = tela / 2
    angulo = gerador.uniform(0, np.pi)
    xr = (x - centro) * np.cos(angulo) + (y - centro) * np.sin(angulo)
    yr = -(x - centro) * np.sin(angulo) + (y - centro) * np.cos(angulo)
    elipse = (xr / (largura / 2)) ** 2 + (yr / (altura / 2)) ** 2
    # borda recortada em varias escalas: contorno geral + dentes finos (lascado)
    borda = (0.45 * ruido_suave(tela, tela, max(3, tela // 5), gerador)
             + 0.30 * ruido_suave(tela, tela, max(2, tela // 14), gerador)
             + 0.35 * ruido_suave(tela, tela, 2, gerador))
    mascara = (elipse + borda < 1.15).astype(np.uint8)
    # fica com o maior pedaco e com as lascas soltas que estao perto dele
    quantidade, rotulos, estatisticas, _ = cv2.connectedComponentsWithStats(mascara)
    if quantidade <= 1:
        return None
    maior = 1 + int(np.argmax(estatisticas[1:, cv2.CC_STAT_AREA]))
    perto = cv2.dilate((rotulos == maior).astype(np.uint8), np.ones((7, 7), np.uint8))
    mantidos = [maior] + [i for i in range(1, quantidade) if i != maior and estatisticas[i, cv2.CC_STAT_AREA] >= 4
                          and perto[rotulos == i].any()]
    mascara = np.isin(rotulos, mantidos).astype(np.uint8)
    pontos = cv2.findNonZero(mascara)
    x0, y0, w, h = cv2.boundingRect(pontos)
    return mascara[y0:y0 + h, x0:x0 + w]


def rede_de_craquele(altura, largura, tamanho_celula, gerador):
    """Mascara de rachaduras (0 a 1) tipo Voronoi, com tortuosidade."""
    pontos = []
    for cy in range(-tamanho_celula, altura + tamanho_celula, tamanho_celula):
        for cx in range(-tamanho_celula, largura + tamanho_celula, tamanho_celula):
            pontos.append((cx + gerador.uniform(0, tamanho_celula), cy + gerador.uniform(0, tamanho_celula)))
    pontos = np.array(pontos, np.float32)
    y, x = np.mgrid[0:altura, 0:largura].astype(np.float32)
    # entorta as coordenadas para a rachadura nao ficar reta
    x = x + (ruido_suave(altura, largura, 12, gerador) - 0.5) * tamanho_celula * 0.5
    y = y + (ruido_suave(altura, largura, 12, gerador) - 0.5) * tamanho_celula * 0.5
    primeira = np.full((altura, largura), 1e9, np.float32)
    segunda = np.full((altura, largura), 1e9, np.float32)
    for px, py in pontos:
        distancia = np.sqrt((x - px) ** 2 + (y - py) ** 2)
        menor = distancia < primeira
        segunda = np.where(menor, primeira, np.minimum(segunda, distancia))
        primeira = np.where(menor, distancia, primeira)
    espessura = gerador.uniform(0.8, 1.8)
    rachadura = np.clip(1.0 - (segunda - primeira) / espessura, 0, 1)
    # algumas rachaduras somem (craquele real nao e uma rede completa)
    rachadura *= (ruido_suave(altura, largura, max(4, tamanho_celula // 2), gerador) > 0.3).astype(np.float32)
    return rachadura


# ---------------------------------------------------------------- aplicar dano no recorte

def aplicar_perda_de_tinta(recorte, x, y, mascara, gerador):
    h, w = mascara.shape
    regiao = recorte[y:y + h, x:x + w].astype(np.float32)
    cinza = cv2.cvtColor(regiao.astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)
    textura = cinza - cv2.GaussianBlur(cinza, (0, 0), 3)          # so o detalhe fino (trama da tela)
    cor = np.array(random.choice(CORES_PREPARO), np.float32) * gerador.uniform(0.85, 1.08)
    granulado = cv2.GaussianBlur(gerador.normal(0, 9, (h, w)).astype(np.float32), (0, 0), 0.8)
    sombreado = (ruido_suave(h, w, max(2, min(h, w) // 3), gerador) - 0.5) * 30   # preparo nao e uma cor chapada
    preenchimento = cor[None, None, :] + (textura * 2.2 + granulado + sombreado)[..., None]
    suave = cv2.GaussianBlur(mascara.astype(np.float32), (3, 3), 0)[..., None]
    resultado = regiao * (1 - suave) + preenchimento * suave
    # degrau da tinta: anel escuro fino logo fora da mancha
    anel = cv2.dilate(mascara, np.ones((3, 3), np.uint8)) - mascara
    anel = cv2.GaussianBlur(anel.astype(np.float32), (3, 3), 0)[..., None]
    resultado = resultado * (1 - 0.35 * anel)
    recorte[y:y + h, x:x + w] = np.clip(resultado, 0, 255).astype(np.uint8)


def aplicar_lacuna_escura(recorte, x, y, mascara, gerador):
    h, w = mascara.shape
    regiao = recorte[y:y + h, x:x + w].astype(np.float32)
    escuro = np.array([gerador.uniform(25, 55)] * 3, np.float32) * np.array([1.0, 1.05, 1.15])
    granulado = cv2.GaussianBlur(gerador.normal(0, 6, (h, w)).astype(np.float32), (0, 0), 0.8)[..., None]
    suave = cv2.GaussianBlur(mascara.astype(np.float32), (3, 3), 0)[..., None]
    resultado = regiao * (1 - suave) + (escuro[None, None, :] + granulado) * suave
    recorte[y:y + h, x:x + w] = np.clip(resultado, 0, 255).astype(np.uint8)


def aplicar_craquele(recorte, x, y, largura, altura, gerador):
    tamanho_celula = int(gerador.uniform(10, 24))
    rachadura = rede_de_craquele(altura, largura, tamanho_celula, gerador)
    # some suavemente na borda da regiao
    yy, xx = np.mgrid[0:altura, 0:largura].astype(np.float32)
    fade = np.clip(np.minimum.reduce([xx, yy, largura - 1 - xx, altura - 1 - yy]) / (0.2 * min(largura, altura)), 0, 1)
    rachadura = rachadura * fade * gerador.uniform(0.55, 0.85)
    regiao = recorte[y:y + altura, x:x + largura].astype(np.float32)
    luz = np.roll(np.roll(rachadura, 1, axis=0), 1, axis=1)        # fio de luz ao lado (relevo)
    resultado = regiao * (1 - rachadura[..., None]) + 25 * rachadura[..., None]
    resultado = resultado + 18 * np.clip(luz - rachadura, 0, 1)[..., None]
    recorte[y:y + altura, x:x + largura] = np.clip(resultado, 0, 255).astype(np.uint8)
    pontos = cv2.findNonZero((rachadura > 0.15).astype(np.uint8))
    if pontos is None:
        return None
    bx, by, bw, bh = cv2.boundingRect(pontos)
    return (x + bx, y + by, x + bx + bw, y + by + bh)


def aplicar_perda_sutil(recorte, x, y, mascara, gerador):
    """Perda pequena e de baixo contraste: o preparo aparece so em parte, misturado a cor do lugar."""
    h, w = mascara.shape
    regiao = recorte[y:y + h, x:x + w].astype(np.float32)
    cor_local = regiao.reshape(-1, 3).mean(axis=0)
    preparo = np.array(random.choice(CORES_PREPARO), np.float32)
    mistura = gerador.uniform(0.35, 0.65)                      # quanto do preparo aparece
    cor = cor_local * (1 - mistura) + preparo * mistura
    cinza = cv2.cvtColor(regiao.astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)
    textura = cinza - cv2.GaussianBlur(cinza, (0, 0), 3)
    granulado = cv2.GaussianBlur(gerador.normal(0, 5, (h, w)).astype(np.float32), (0, 0), 0.8)
    preenchimento = cor[None, None, :] + (textura * 1.5 + granulado)[..., None]
    opacidade = gerador.uniform(0.7, 0.95)
    suave = cv2.GaussianBlur(mascara.astype(np.float32), (5, 5), 0)[..., None] * opacidade
    recorte[y:y + h, x:x + w] = np.clip(regiao * (1 - suave) + preenchimento * suave, 0, 255).astype(np.uint8)


def aplicar_desgaste(recorte, x, y, mascara, gerador):
    """Abrasao: a tinta afinou. Clareia um pouco, tira saturacao e deixa pontinhos do preparo.
    A borda e esfumada, entao a area trabalhada inclui uma margem em volta da mascara."""
    h, w = mascara.shape
    sigma = max(2.0, min(h, w) / 8)
    margem = int(3 * sigma)
    x0, y0 = max(0, x - margem), max(0, y - margem)
    x1, y1 = min(TAMANHO, x + w + margem), min(TAMANHO, y + h + margem)
    grande = np.zeros((y1 - y0, x1 - x0), np.float32)
    grande[y - y0:y - y0 + h, x - x0:x - x0 + w] = mascara
    suave = np.clip(cv2.GaussianBlur(grande, (0, 0), sigma) * 1.5, 0, 1)[..., None]
    regiao = recorte[y0:y1, x0:x1].astype(np.float32)
    hsv = cv2.cvtColor(regiao.astype(np.uint8), cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[..., 1] *= gerador.uniform(0.6, 0.85)
    hsv[..., 2] = np.clip(hsv[..., 2] * gerador.uniform(1.04, 1.14) + gerador.uniform(2, 10), 0, 255)
    gasto = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR).astype(np.float32)
    pontos = (gerador.random(grande.shape) > gerador.uniform(0.95, 0.985)).astype(np.float32)
    pontos = cv2.GaussianBlur(pontos, (3, 3), 0)[..., None]
    preparo = np.array(random.choice(CORES_PREPARO), np.float32)[None, None, :]
    gasto = gasto * (1 - 0.6 * pontos) + preparo * 0.6 * pontos
    recorte[y0:y1, x0:x1] = np.clip(regiao * (1 - suave) + gasto * suave, 0, 255).astype(np.uint8)


def aplicar_lascas(recorte, x, y, largura, altura, gerador):
    """Grupo de lascas minusculas (3 a 10 px) numa area pequena. A caixa cobre o grupo."""
    preparo = np.array(random.choice(CORES_PREPARO), np.float32)
    marcadas = []
    for _ in range(int(gerador.integers(4, 11))):
        eixo_maior = gerador.uniform(1.5, 5.0)
        eixo_menor = eixo_maior / gerador.uniform(1.0, 2.5)
        lado = int(2 * eixo_maior + 4)
        if lado >= largura or lado >= altura:
            continue
        mascara = np.zeros((lado, lado), np.uint8)
        cv2.ellipse(mascara, (lado // 2, lado // 2), (max(1, int(round(eixo_maior))), max(1, int(round(eixo_menor)))),
                    float(gerador.uniform(0, 180)), 0, 360, 1, -1)
        px = x + int(gerador.integers(0, largura - lado)); py = y + int(gerador.integers(0, altura - lado))
        regiao = recorte[py:py + lado, px:px + lado].astype(np.float32)
        mistura = gerador.uniform(0.45, 0.85)
        cor = regiao.reshape(-1, 3).mean(axis=0) * (1 - mistura) + preparo * mistura
        suave = cv2.GaussianBlur(mascara.astype(np.float32), (3, 3), 0)[..., None]
        recorte[py:py + lado, px:px + lado] = np.clip(regiao * (1 - suave) + cor[None, None, :] * suave, 0, 255).astype(np.uint8)
        pontos = cv2.findNonZero(mascara)
        bx, by, bw, bh = cv2.boundingRect(pontos)
        marcadas.append((px + bx, py + by, px + bx + bw, py + by + bh))
    if len(marcadas) < 2:
        return None
    return (min(c[0] for c in marcadas) - 1, min(c[1] for c in marcadas) - 1,
            max(c[2] for c in marcadas) + 1, max(c[3] for c in marcadas) + 1)


def aplicar_brilho(recorte, gerador):
    """Reflexo de luz (NAO e dano): mancha clara esfumada, faixa de reflexo ou pontos de brilho.
    Usado nos recortes NEGATIVOS, sem caixa, para o modelo aprender que brilho nao e avaria."""
    altura, largura = recorte.shape[:2]
    imagem = recorte.astype(np.float32)
    branco = np.array([gerador.uniform(235, 255), gerador.uniform(240, 255), gerador.uniform(245, 255)], np.float32)
    yy, xx = np.mgrid[0:altura, 0:largura].astype(np.float32)
    tipo = gerador.choice(['mancha', 'faixa', 'pontos'], p=[0.45, 0.35, 0.2])
    if tipo == 'mancha':
        cx, cy = gerador.uniform(0, largura), gerador.uniform(0, altura)
        rx, ry = gerador.uniform(20, 180), gerador.uniform(15, 140)
        angulo = gerador.uniform(0, np.pi)
        xr = (xx - cx) * np.cos(angulo) + (yy - cy) * np.sin(angulo)
        yr = -(xx - cx) * np.sin(angulo) + (yy - cy) * np.cos(angulo)
        alfa = np.exp(-((xr / rx) ** 2 + (yr / ry) ** 2) * gerador.uniform(1.5, 4.0)) * gerador.uniform(0.4, 0.9)
    elif tipo == 'faixa':
        angulo = gerador.uniform(0, np.pi)
        distancia = (xx - largura / 2) * np.cos(angulo) + (yy - altura / 2) * np.sin(angulo) - gerador.uniform(-250, 250)
        meia_largura = gerador.uniform(8, 70)
        alfa = np.exp(-(distancia / meia_largura) ** 2) * gerador.uniform(0.25, 0.7)
        alfa *= ruido_suave(altura, largura, 40, gerador) * 0.6 + 0.4
    else:
        alfa = np.zeros((altura, largura), np.float32)
        for _ in range(int(gerador.integers(3, 15))):
            cv2.circle(alfa, (int(gerador.integers(0, largura)), int(gerador.integers(0, altura))),
                       int(gerador.integers(2, 9)), float(gerador.uniform(0.6, 1.0)), -1)
        alfa = cv2.GaussianBlur(alfa, (0, 0), gerador.uniform(1.5, 4.0))
    alfa = np.clip(alfa, 0, 1)[..., None]
    recorte[:] = np.clip(imagem * (1 - alfa) + branco[None, None, :] * alfa, 0, 255).astype(np.uint8)


def visivel(antes, depois, caixa, minimo=0.25, limiar=14):
    """Confere se o dano aparece: parte dos pixels da caixa mudou de forma perceptivel."""
    x0, y0, x1, y1 = [int(v) for v in caixa]
    x0, y0 = max(0, x0), max(0, y0)
    diferenca = np.abs(depois[y0:y1, x0:x1].astype(np.int16) - antes[y0:y1, x0:x1].astype(np.int16)).sum(axis=2)
    if diferenca.size == 0:
        return False
    return (diferenca > limiar).mean() >= minimo or (diferenca > 3 * limiar).sum() >= 6


def sobrepoe(caixa, caixas, folga=6):
    for outra in caixas:
        if caixa[0] < outra[2] + folga and outra[0] < caixa[2] + folga and caixa[1] < outra[3] + folga and outra[1] < caixa[3] + folga:
            return True
    return False


TIPOS = ['perda', 'lacuna', 'craquele', 'perda_sutil', 'desgaste', 'lascas']
PESOS_TIPOS = [0.45, 0.15, 0.0, 0.2, 0.1, 0.1]   # ajustado em main por --craquele e --sutis


def gerar_recorte(imagem, gerador):
    altura, largura = imagem.shape[:2]
    x0 = int(gerador.integers(0, max(1, largura - TAMANHO + 1)))
    y0 = int(gerador.integers(0, max(1, altura - TAMANHO + 1)))
    recorte = imagem[y0:y0 + TAMANHO, x0:x0 + TAMANHO].copy()
    if recorte.shape[0] < TAMANHO or recorte.shape[1] < TAMANHO:
        return None, None
    caixas = []
    for _ in range(int(gerador.integers(1, 5))):
        tipo = gerador.choice(TIPOS, p=PESOS_TIPOS)
        for _tentativa in range(15):
            if tipo == 'craquele':
                largura_regiao = int(gerador.uniform(70, 240)); altura_regiao = int(gerador.uniform(60, 200))
                x = int(gerador.integers(8, TAMANHO - largura_regiao - 8)); y = int(gerador.integers(8, TAMANHO - altura_regiao - 8))
                if sobrepoe((x, y, x + largura_regiao, y + altura_regiao), caixas):
                    continue
                caixa = aplicar_craquele(recorte, x, y, largura_regiao, altura_regiao, gerador)
                if caixa:
                    caixas.append(caixa)
                break
            if tipo == 'lascas':
                largura_regiao = int(gerador.uniform(25, 80)); altura_regiao = int(gerador.uniform(25, 80))
                x = int(gerador.integers(8, TAMANHO - largura_regiao - 8)); y = int(gerador.integers(8, TAMANHO - altura_regiao - 8))
                if sobrepoe((x, y, x + largura_regiao, y + altura_regiao), caixas):
                    continue
                antes = recorte.copy()
                caixa = aplicar_lascas(recorte, x, y, largura_regiao, altura_regiao, gerador)
                if caixa and visivel(antes, recorte, caixa, minimo=0.05):
                    caixas.append(caixa)
                else:
                    recorte[:] = antes
                break
            if tipo == 'lacuna':
                lado, alongamento = gerador.uniform(14, 45), gerador.uniform(1.0, 1.6)
            elif tipo == 'perda_sutil':
                lado, alongamento = float(np.exp(gerador.uniform(np.log(10), np.log(55)))), gerador.uniform(1.2, 4.0)
            elif tipo == 'desgaste':
                lado, alongamento = gerador.uniform(40, 140), gerador.uniform(1.0, 2.5)
            else:
                lado, alongamento = float(np.exp(gerador.uniform(np.log(18), np.log(170)))), gerador.uniform(1.2, 4.5)
            mascara = mancha_irregular(lado, alongamento, gerador)
            if mascara is None or max(mascara.shape) > TAMANHO - 20:
                continue
            h, w = mascara.shape
            x = int(gerador.integers(4, TAMANHO - w - 4)); y = int(gerador.integers(4, TAMANHO - h - 4))
            if sobrepoe((x, y, x + w, y + h), caixas):
                continue
            antes = recorte.copy()
            {'lacuna': aplicar_lacuna_escura, 'perda_sutil': aplicar_perda_sutil,
             'desgaste': aplicar_desgaste}.get(tipo, aplicar_perda_de_tinta)(recorte, x, y, mascara, gerador)
            caixa = (x - 1, y - 1, x + w + 1, y + h + 1)
            if visivel(antes, recorte, caixa, minimo=0.25 if tipo != 'desgaste' else 0.15, limiar=14 if tipo != 'desgaste' else 10):
                caixas.append(caixa)
            else:
                recorte[:] = antes          # sumiu no fundo: desfaz, para nao rotular o nada
            break
    return recorte, caixas


# ---------------------------------------------------------------- pinturas limpas

def pinturas_limpas(pasta_dataset):
    uso = {}
    for nome_csv in CSVS_FONTES:
        caminho = pasta_dataset / nome_csv
        if not caminho.exists():
            continue
        with open(caminho, encoding='utf-8-sig', newline='') as arquivo:
            for linha in csv.DictReader(arquivo):
                coluna_uso = next((k for k in linha if k and 'uso' in k), None)
                uso[Path(linha.get('arquivo', '')).name] = (linha.get(coluna_uso) or '').strip().lower()
    escolhidas, puladas = [], []
    for nome_json, nome_pasta in PARES_ROTULOS_PASTAS:
        caminho_json = pasta_dataset / nome_json
        if not caminho_json.exists():
            continue
        for foto in json.loads(caminho_json.read_text(encoding='utf-8'))['fotos']:
            if not foto.get('revisada') or foto.get('caixas'):
                continue
            nome = Path(foto['arquivo']).name
            caminho_imagem = pasta_dataset / nome_pasta / nome
            if uso.get(nome, '') == 'teste':
                puladas.append(nome); continue
            if caminho_imagem.exists():
                escolhidas.append(caminho_imagem)
    return sorted(set(escolhidas)), puladas


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--dataset', default='dataset')
    parser.add_argument('--base', default='yolo-A', help='conjunto real que recebe os sinteticos (ex.: yolo-A, yolo-C2)')
    parser.add_argument('--recortes', type=int, default=140, help='quantos recortes sinteticos gerar')
    parser.add_argument('--amostras', type=int, default=12, help='recortes salvos com caixas desenhadas, para conferir')
    parser.add_argument('--craquele', type=float, default=0.0,
                        help='fracao de danos do tipo craquele (0 a 1). Padrao 0: as pinturas "limpas" ja tem '
                             'craquele fino real sem caixa, e craquele sintetico com caixa ao lado confundiria o modelo')
    parser.add_argument('--sutis', type=float, default=0.4,
                        help='fracao de danos sutis (perda pequena e apagada, desgaste, grupo de lascas). Padrao 0.4')
    parser.add_argument('--sem-desgaste', action='store_true',
                        help='nao gera o desgaste (nevoa clara), que se parece com reflexo de luz')
    parser.add_argument('--negativos-brilho', type=int, default=0,
                        help='recortes SEM dano e SEM caixa com reflexos de luz artificiais (ensinam que brilho nao e dano)')
    parser.add_argument('--sufixo', default='sint', help='nome da saida: yolo-<sufixo>, <base>-<sufixo>.zip')
    parser.add_argument('--semente', type=int, default=7)
    args = parser.parse_args()
    restante = 1.0 - args.craquele
    fortes, sutis = restante * (1 - args.sutis), restante * args.sutis
    #             perda          lacuna         craquele       perda_sutil   desgaste      lascas
    if args.sem_desgaste:
        PESOS_TIPOS[:] = [0.75 * fortes, 0.25 * fortes, args.craquele, 0.6 * sutis, 0.0, 0.4 * sutis]
    else:
        PESOS_TIPOS[:] = [0.75 * fortes, 0.25 * fortes, args.craquele, 0.5 * sutis, 0.25 * sutis, 0.25 * sutis]

    random.seed(args.semente)
    gerador = np.random.default_rng(args.semente)
    pasta_dataset = Path(args.dataset)
    limpas, puladas = pinturas_limpas(pasta_dataset)
    print('pinturas limpas usadas: %d (puladas por serem de teste: %d)' % (len(limpas), len(puladas)))
    if not limpas:
        raise SystemExit('nenhuma pintura limpa encontrada')

    pasta_sintetico = pasta_dataset / ('yolo-' + args.sufixo)
    pasta_amostras = pasta_dataset / ('amostras-' + args.sufixo)
    for pasta in (pasta_sintetico, pasta_amostras):
        if pasta.exists():
            shutil.rmtree(pasta)
    (pasta_sintetico / 'images' / 'train').mkdir(parents=True)
    (pasta_sintetico / 'labels' / 'train').mkdir(parents=True)
    pasta_amostras.mkdir()

    imagens = {}
    total_caixas = 0
    gerados = 0
    while gerados < args.recortes:
        caminho = limpas[gerados % len(limpas)]
        if caminho not in imagens:
            imagens[caminho] = cv2.imread(str(caminho))
        recorte, caixas = gerar_recorte(imagens[caminho], gerador)
        if recorte is None or not caixas:
            continue
        nome = 'sint_%s_%04d' % (caminho.stem, gerados)
        cv2.imwrite(str(pasta_sintetico / 'images' / 'train' / (nome + '.jpg')), recorte, [cv2.IMWRITE_JPEG_QUALITY, 92])
        linhas = ['0 %.6f %.6f %.6f %.6f' % ((c[0] + c[2]) / 2 / TAMANHO, (c[1] + c[3]) / 2 / TAMANHO,
                                             (c[2] - c[0]) / TAMANHO, (c[3] - c[1]) / TAMANHO) for c in caixas]
        (pasta_sintetico / 'labels' / 'train' / (nome + '.txt')).write_text('\n'.join(linhas) + '\n')
        if gerados < args.amostras:
            desenho = recorte.copy()
            for c in caixas:
                cv2.rectangle(desenho, (c[0], c[1]), (c[2], c[3]), (0, 255, 255), 1)
            cv2.imwrite(str(pasta_amostras / (nome + '.jpg')), np.hstack([recorte, desenho]))
        total_caixas += len(caixas)
        gerados += 1
    print('sinteticos: %d recortes, %d caixas -> %s' % (gerados, total_caixas, pasta_sintetico))

    # negativos com brilho: recorte limpo + reflexo artificial, rotulo vazio
    feitos_brilho = 0
    while feitos_brilho < args.negativos_brilho:
        caminho = limpas[(gerados + feitos_brilho) % len(limpas)]
        if caminho not in imagens:
            imagens[caminho] = cv2.imread(str(caminho))
        imagem = imagens[caminho]
        altura, largura = imagem.shape[:2]
        if altura < TAMANHO or largura < TAMANHO:
            feitos_brilho += 1; continue
        x0 = int(gerador.integers(0, largura - TAMANHO + 1)); y0 = int(gerador.integers(0, altura - TAMANHO + 1))
        recorte = imagem[y0:y0 + TAMANHO, x0:x0 + TAMANHO].copy()
        for _ in range(int(gerador.integers(1, 4))):
            aplicar_brilho(recorte, gerador)
        nome = 'brilho_%s_%04d' % (caminho.stem, feitos_brilho)
        cv2.imwrite(str(pasta_sintetico / 'images' / 'train' / (nome + '.jpg')), recorte, [cv2.IMWRITE_JPEG_QUALITY, 92])
        (pasta_sintetico / 'labels' / 'train' / (nome + '.txt')).write_text('')
        if feitos_brilho < 6:
            cv2.imwrite(str(pasta_amostras / (nome + '.jpg')), recorte)
        feitos_brilho += 1
    if args.negativos_brilho:
        print('negativos com brilho (sem caixa): %d recortes' % feitos_brilho)
    gerados_total = gerados + feitos_brilho

    # base real + sinteticos (validacao igual a da base)
    pasta_base = pasta_dataset / args.base
    pasta_final = pasta_dataset / (args.base + '-' + args.sufixo)
    if pasta_final.exists():
        shutil.rmtree(pasta_final)
    shutil.copytree(pasta_base, pasta_final)
    for sub in ('images', 'labels'):
        for arquivo in (pasta_sintetico / sub / 'train').iterdir():
            shutil.copy(arquivo, pasta_final / sub / 'train' / arquivo.name)
    (pasta_final / 'data.yaml').write_text('path: .\ntrain: images/train\nval: images/val\nnames:\n  0: avaria\n')
    arquivo_zip = pasta_dataset / (pasta_final.name + '.zip')
    with zipfile.ZipFile(arquivo_zip, 'w', zipfile.ZIP_DEFLATED) as saida_zip:
        for arquivo in sorted(pasta_final.rglob('*')):
            if arquivo.is_file():
                saida_zip.write(arquivo, arquivo.relative_to(pasta_final))
    treino = len(list((pasta_final / 'images' / 'train').glob('*.jpg')))
    validacao = len(list((pasta_final / 'images' / 'val').glob('*.jpg')))
    print('%s: %d recortes de treino (%d reais + %d sinteticos), %d de validacao -> %s'
          % (pasta_final.name, treino, treino - gerados_total, gerados_total, validacao, arquivo_zip))
    print('confira as amostras em', pasta_amostras)


if __name__ == '__main__':
    main()
