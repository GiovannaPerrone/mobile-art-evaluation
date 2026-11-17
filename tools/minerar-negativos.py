"""
Negativos dificeis (hard negative mining): roda um modelo nas pinturas LIMPAS de treino e guarda,
como recortes de 640 x 640 px SEM caixa, os lugares onde ele marcou dano sem haver dano.
No proximo treino, o modelo ve os proprios erros como exemplo de "isto nao e avaria".

Usa as mesmas pinturas limpas do gerar-dano-sintetico.py (revisadas sem caixa; as de "teste" nunca entram).

Uso (na pasta do projeto):
    python tools/minerar-negativos.py models/yolo-A-sint3.onnx --base dataset/yolo-A-sint3 --sufixo sint4
Saida:
    dataset/negativos-dificeis/          recortes sem caixa (images/train + labels/train vazios)
    dataset/amostras-negativos/          alguns recortes com a caixa falsa desenhada, para conferir
    dataset/yolo-A-<sufixo>/ e .zip      base + negativos dificeis (validacao igual a da base)
Precisa de onnxruntime, numpy, pillow e opencv-python.
"""
import argparse
import importlib.util
import shutil
import zipfile
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

aqui = Path(__file__).resolve().parent
TAMANHO, LADO = 640, 2560


def carregar(nome_arquivo, nome_modulo):
    especificacao = importlib.util.spec_from_file_location(nome_modulo, aqui / nome_arquivo)
    modulo = importlib.util.module_from_spec(especificacao)
    especificacao.loader.exec_module(modulo)
    return modulo


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('modelo', help='modelo ONNX que vai mostrar os proprios erros (ex.: models/yolo-A-sint3.onnx)')
    parser.add_argument('--dataset', default='dataset')
    parser.add_argument('--base', default='dataset/yolo-A-sint3', help='conjunto que recebe os negativos')
    parser.add_argument('--sufixo', default='sint4')
    parser.add_argument('--confianca', type=float, default=0.10, help='confianca do app: o erro que importa e o que aparece na tela')
    parser.add_argument('--por-pintura', type=int, default=6, help='maximo de recortes por pintura (evita uma pintura dominar)')
    parser.add_argument('--maximo', type=int, default=200)
    args = parser.parse_args()

    avaliar = carregar('avaliar-modelo.py', 'avaliar_modelo')
    gerador_sintetico = carregar('gerar-dano-sintetico.py', 'gerar_dano')
    pasta_dataset = Path(args.dataset)
    limpas, _ = gerador_sintetico.pinturas_limpas(pasta_dataset)
    sessao, entrada = avaliar.carregar_modelo(args.modelo)

    pasta_negativos = pasta_dataset / 'negativos-dificeis'
    pasta_amostras = pasta_dataset / 'amostras-negativos'
    for pasta in (pasta_negativos, pasta_amostras):
        if pasta.exists():
            shutil.rmtree(pasta)
    (pasta_negativos / 'images' / 'train').mkdir(parents=True)
    (pasta_negativos / 'labels' / 'train').mkdir(parents=True)
    pasta_amostras.mkdir()

    total, caixas_falsas = 0, 0
    for caminho in limpas:
        imagem = ImageOps.exif_transpose(Image.open(caminho)).convert('RGB')
        imagem_2560, caixas, pontuacoes = avaliar.prever(sessao, entrada, imagem, args.confianca)
        caixas_falsas += len(caixas)
        largura, altura = imagem_2560.size
        if largura < TAMANHO or altura < TAMANHO or not len(caixas):
            print('%s: %d caixas falsas' % (caminho.name, len(caixas)))
            continue
        escolhidos = []
        for indice in np.argsort(-pontuacoes):              # os erros mais confiantes primeiro
            if len(escolhidos) >= args.por_pintura or total >= args.maximo:
                break
            x0c, y0c, x1c, y1c = caixas[indice]
            centro_x, centro_y = (x0c + x1c) / 2, (y0c + y1c) / 2
            # nao repete recorte: pula erro que ja caiu no meio de um recorte escolhido
            if any(abs(centro_x - (x + TAMANHO / 2)) < TAMANHO / 3 and abs(centro_y - (y + TAMANHO / 2)) < TAMANHO / 3
                   for x, y in escolhidos):
                continue
            x = int(np.clip(centro_x - TAMANHO / 2 + np.random.uniform(-120, 120), 0, largura - TAMANHO))
            y = int(np.clip(centro_y - TAMANHO / 2 + np.random.uniform(-120, 120), 0, altura - TAMANHO))
            escolhidos.append((x, y))
            recorte = imagem_2560.crop((x, y, x + TAMANHO, y + TAMANHO))
            nome = 'negdif_%s_%d_%d' % (caminho.stem, x, y)
            recorte.save(pasta_negativos / 'images' / 'train' / (nome + '.jpg'), quality=92)
            (pasta_negativos / 'labels' / 'train' / (nome + '.txt')).write_text('')
            if total < 24:
                desenho = cv2.cvtColor(np.asarray(recorte), cv2.COLOR_RGB2BGR).copy()
                cv2.rectangle(desenho, (int(x0c - x), int(y0c - y)), (int(x1c - x), int(y1c - y)), (0, 0, 255), 2)
                cv2.imwrite(str(pasta_amostras / (nome + '.jpg')), desenho)
            total += 1
        print('%s: %d caixas falsas, %d recortes guardados' % (caminho.name, len(caixas), len(escolhidos)), flush=True)

    print('\npinturas limpas: %d | caixas falsas a conf %.2f: %d | negativos dificeis: %d recortes'
          % (len(limpas), args.confianca, caixas_falsas, total))

    pasta_final = pasta_dataset / ('yolo-A-' + args.sufixo)
    if pasta_final.exists():
        shutil.rmtree(pasta_final)
    shutil.copytree(args.base, pasta_final)
    for sub in ('images', 'labels'):
        for arquivo in (pasta_negativos / sub / 'train').iterdir():
            shutil.copy(arquivo, pasta_final / sub / 'train' / arquivo.name)
    (pasta_final / 'data.yaml').write_text('path: .\ntrain: images/train\nval: images/val\nnames:\n  0: avaria\n')
    arquivo_zip = pasta_dataset / (pasta_final.name + '.zip')
    with zipfile.ZipFile(arquivo_zip, 'w', zipfile.ZIP_DEFLATED) as saida_zip:
        for arquivo in sorted(pasta_final.rglob('*')):
            if arquivo.is_file():
                saida_zip.write(arquivo, arquivo.relative_to(pasta_final))
    treino = len(list((pasta_final / 'images' / 'train').glob('*.jpg')))
    print('%s: %d recortes de treino -> %s' % (pasta_final.name, treino, arquivo_zip))


if __name__ == '__main__':
    np.random.seed(7)
    main()
