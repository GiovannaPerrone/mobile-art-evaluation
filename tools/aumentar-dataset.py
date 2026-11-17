"""
Data augmentation OFFLINE do conjunto de treino do YOLO (formato gerado pelos scripts de tools/).

Entrada : uma pasta de dataset no formato YOLO, por exemplo dataset/yolo-A
              images/train/*.jpg   labels/train/*.txt   images/val/...   labels/val/...   data.yaml
Saida   : uma pasta nova (a original NAO e alterada), por exemplo dataset/yolo-A-aug
              - train: cada recorte original + N copias aumentadas (nome terminado em _aug1, _aug2, ...)
              - val  : copiado igual ao original, SEM aumento (a validacao precisa continuar "limpa")
              - um zip pronto para subir no Colab

Uso:
    pip install albumentations opencv-python-headless pillow numpy
    python tools/aumentar-dataset.py dataset/yolo-A dataset/yolo-A-aug --copias 3

Regras importantes:
  - Aumenta so o treino. Validacao e teste nunca recebem aumento.
  - As caixas acompanham a transformacao (giro, escala, perspectiva). Caixa que sobra com menos de
    50% visivel e descartada (a mesma regra dos scripts de gerar dataset).
  - Recorte sem dano (negativo) tambem e aumentado: continua sem caixa.
  - O aumento so mexe no que uma foto de celular de verdade varia: luz, cor, foco, ruido, compressao,
    pequena inclinacao e escala. Nada que invente dano novo.
"""
import argparse
import random
import shutil
import zipfile
from pathlib import Path

import albumentations as A
import cv2
import numpy as np

EXTENSOES_IMAGEM = ('.jpg', '.jpeg', '.png')


def montar_transformacao(forca):
    """Sequencia de aumentos. 'forca' (0 a 1) escala a intensidade de todos."""
    return A.Compose(
        [
            # geometria: a mancha e o craquele nao tem "lado certo"
            A.HorizontalFlip(p=0.5),
            A.VerticalFlip(p=0.5),
            A.RandomRotate90(p=0.5),
            A.Affine(
                scale=(1 - 0.25 * forca, 1 + 0.25 * forca),
                rotate=(-10 * forca, 10 * forca),
                translate_percent=(-0.05 * forca, 0.05 * forca),
                border_mode=cv2.BORDER_CONSTANT,   # nada de espelhar a borda: duplicaria o dano sem caixa
                fill=(114, 114, 114),
                p=0.7,
            ),
            A.Perspective(scale=(0.02, 0.06 * forca + 0.02), border_mode=cv2.BORDER_CONSTANT, fill=(114, 114, 114), p=0.3),
            # luz e cor: a foto de celular muda de iluminacao e balanco de branco
            A.RandomBrightnessContrast(brightness_limit=0.25 * forca, contrast_limit=0.25 * forca, p=0.8),
            A.HueSaturationValue(hue_shift_limit=int(8 * forca), sat_shift_limit=int(25 * forca), val_shift_limit=int(20 * forca), p=0.6),
            A.RandomGamma(gamma_limit=(80, 120), p=0.3),
            # qualidade da imagem: foco, ruido e compressao
            A.OneOf(
                [
                    A.GaussianBlur(blur_limit=(3, 5), p=1.0),
                    A.MotionBlur(blur_limit=(3, 7), p=1.0),
                ],
                p=0.3,
            ),
            A.GaussNoise(std_range=(0.01, 0.05), p=0.3),
            A.ImageCompression(quality_range=(60, 95), p=0.4),
        ],
        bbox_params=A.BboxParams(format='yolo', label_fields=['classes'], min_visibility=0.5, min_area=16),
    )


def ler_caixas(caminho_rotulo):
    """Le um .txt do YOLO: 'classe cx cy w h' (valores de 0 a 1). Devolve (caixas, classes)."""
    caixas, classes = [], []
    if caminho_rotulo.exists():
        for linha in caminho_rotulo.read_text().splitlines():
            partes = linha.split()
            if len(partes) != 5:
                continue
            classes.append(int(float(partes[0])))
            valores = [min(max(float(v), 0.0), 1.0) for v in partes[1:]]
            caixas.append(valores)
    return caixas, classes


def gravar_caixas(caminho_rotulo, caixas, classes):
    linhas = ['%d %.6f %.6f %.6f %.6f' % (classe, *caixa) for classe, caixa in zip(classes, caixas)]
    caminho_rotulo.write_text('\n'.join(linhas) + ('\n' if linhas else ''))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('entrada', help='pasta do dataset YOLO original (ex.: dataset/yolo-A)')
    parser.add_argument('saida', help='pasta nova para o dataset aumentado (ex.: dataset/yolo-A-aug)')
    parser.add_argument('--copias', type=int, default=3, help='copias aumentadas por recorte de treino')
    parser.add_argument('--forca', type=float, default=1.0, help='intensidade dos aumentos, 0 a 1 (padrao 1)')
    parser.add_argument('--semente', type=int, default=7)
    args = parser.parse_args()

    random.seed(args.semente)
    np.random.seed(args.semente)
    entrada, saida = Path(args.entrada), Path(args.saida)
    if saida.exists():
        shutil.rmtree(saida)
    for subpasta in ('images/train', 'images/val', 'labels/train', 'labels/val'):
        (saida / subpasta).mkdir(parents=True)

    # validacao: copia igual, sem aumento
    for imagem in sorted((entrada / 'images' / 'val').glob('*')):
        if imagem.suffix.lower() in EXTENSOES_IMAGEM:
            shutil.copy(imagem, saida / 'images' / 'val' / imagem.name)
            rotulo = entrada / 'labels' / 'val' / (imagem.stem + '.txt')
            if rotulo.exists():
                shutil.copy(rotulo, saida / 'labels' / 'val' / rotulo.name)

    transformacao = montar_transformacao(args.forca)
    total_originais = total_aumentadas = caixas_originais = caixas_aumentadas = 0
    for caminho_imagem in sorted((entrada / 'images' / 'train').glob('*')):
        if caminho_imagem.suffix.lower() not in EXTENSOES_IMAGEM:
            continue
        caminho_rotulo = entrada / 'labels' / 'train' / (caminho_imagem.stem + '.txt')
        caixas, classes = ler_caixas(caminho_rotulo)

        # original entra igual
        shutil.copy(caminho_imagem, saida / 'images' / 'train' / caminho_imagem.name)
        gravar_caixas(saida / 'labels' / 'train' / (caminho_imagem.stem + '.txt'), caixas, classes)
        total_originais += 1
        caixas_originais += len(caixas)

        imagem = cv2.cvtColor(cv2.imread(str(caminho_imagem)), cv2.COLOR_BGR2RGB)
        for numero in range(1, args.copias + 1):
            resultado = transformacao(image=imagem, bboxes=caixas, classes=classes)
            # recorte positivo que perdeu todas as caixas (saiu do quadro) nao vira negativo falso: pula
            if caixas and not resultado['bboxes']:
                continue
            nome = '%s_aug%d' % (caminho_imagem.stem, numero)
            cv2.imwrite(str(saida / 'images' / 'train' / (nome + '.jpg')),
                        cv2.cvtColor(resultado['image'], cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 95])
            gravar_caixas(saida / 'labels' / 'train' / (nome + '.txt'), resultado['bboxes'], resultado['classes'])
            total_aumentadas += 1
            caixas_aumentadas += len(resultado['bboxes'])

    (saida / 'data.yaml').write_text('path: .\ntrain: images/train\nval: images/val\nnames:\n  0: avaria\n')
    arquivo_zip = saida.parent / (saida.name + '.zip')
    with zipfile.ZipFile(arquivo_zip, 'w', zipfile.ZIP_DEFLATED) as zip_saida:
        for arquivo in sorted(saida.rglob('*')):
            if arquivo.is_file():
                zip_saida.write(arquivo, arquivo.relative_to(saida))

    quantidade_val = len(list((saida / 'images' / 'val').glob('*')))
    print('treino original : %d recortes, %d caixas' % (total_originais, caixas_originais))
    print('treino aumentado: +%d recortes, +%d caixas' % (total_aumentadas, caixas_aumentadas))
    print('treino final    : %d recortes' % (total_originais + total_aumentadas))
    print('validacao       : %d recortes (sem aumento)' % quantidade_val)
    print('zip para o Colab:', arquivo_zip)


if __name__ == '__main__':
    main()
