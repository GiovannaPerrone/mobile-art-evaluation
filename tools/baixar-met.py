"""
Baixa do Met (Open Access, CC0) as imagens listadas num CSV de fontes e deixa tudo pronto para rotular.

Uso (na pasta do projeto, no seu Windows, com internet):
    python tools/baixar-met.py dataset/fontes-met-novas.csv
    python tools/baixar-met.py dataset/fontes-met-candidatas-tela.csv trabalho-met-candidatas   (pasta de trabalho separada)

O que faz, para cada linha do CSV:
  1. baixa a imagem (coluna "url_da_imagem") para dataset/met-originais/met_<id>.jpg
  2. corrige a rotacao do EXIF e leva o lado maior a 2560 px (a escala de treino do modelo)
     e salva em dataset/trabalho-met/met_<id>.jpg  <- e esta pasta que voce abre no rotular.html
     (com o 2o argumento, salva em dataset/<esse nome>/ em vez de dataset/trabalho-met/)
Pula o que ja foi baixado, espera 1 s entre downloads (o Met bloqueia quem baixa rapido demais)
e nunca sobrescreve arquivo existente.
"""
import csv
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageOps

LADO = 2560


def main():
    caminho_csv = Path(sys.argv[1] if len(sys.argv) > 1 else 'dataset/fontes-met-novas.csv')
    pasta_originais = Path('dataset/met-originais')
    pasta_trabalho = Path('dataset') / (sys.argv[2] if len(sys.argv) > 2 else 'trabalho-met')
    pasta_originais.mkdir(parents=True, exist_ok=True)
    pasta_trabalho.mkdir(parents=True, exist_ok=True)

    with open(caminho_csv, encoding='utf-8-sig', newline='') as arquivo:
        linhas = list(csv.DictReader(arquivo))
    print(f'{len(linhas)} imagens no CSV')

    falhas = []
    for numero, linha in enumerate(linhas, 1):
        nome = linha['arquivo']
        destino = pasta_originais / nome
        if not destino.exists():
            pedido = urllib.request.Request(linha['url_da_imagem'], headers={'User-Agent': 'Mozilla/5.0 (projeto academico, Ibmec)'})
            try:
                with urllib.request.urlopen(pedido, timeout=60) as resposta:
                    destino.write_bytes(resposta.read())
                print(f'[{numero}/{len(linhas)}] baixada {nome}')
            except Exception as erro:
                print(f'[{numero}/{len(linhas)}] FALHOU {nome}: {erro}')
                falhas.append(nome)
                continue
            time.sleep(1.0)
        saida = pasta_trabalho / nome
        if not saida.exists():
            imagem = ImageOps.exif_transpose(Image.open(destino)).convert('RGB')
            escala = LADO / max(imagem.size)
            novo_tamanho = (round(imagem.width * escala), round(imagem.height * escala))
            imagem.resize(novo_tamanho, Image.LANCZOS).save(saida, quality=92)
            print(f'    normalizada: {imagem.width}x{imagem.height} -> {novo_tamanho[0]}x{novo_tamanho[1]}')

    print(f'\nPronto. Abra tools/rotular.html e escolha a pasta {pasta_trabalho}.')
    if falhas:
        print('Falharam (rode de novo mais tarde):', ', '.join(falhas))


if __name__ == '__main__':
    main()
