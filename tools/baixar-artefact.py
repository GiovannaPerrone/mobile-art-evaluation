"""
Baixa do ARTeFACT (Hugging Face: danielaivanova/damaged-media, licenca AFL-3.0) so as pinturas (tela e madeira) e deixa tudo
pronto para a gente olhar. NAO mexe no treino: e uma etapa de inspecao.

Uso (no seu Windows, com internet; ~1,9 GB de download):
    python tools/baixar-artefact.py

Para cada pintura grava, em dataset/artefact/:
    img/<id>.jpg        imagem com o lado maior em 2560 px (a escala do treino)
    mask/<id>.png       mascara de dano na mesma escala (reduzida sem misturar valores)
    revisao/<id>.jpg    imagem com a mascara colorida por cima, em 1500 px (para eu olhar)
    indice.csv          id, material, tipo, conteudo, tamanho original, valores da mascara e descricao do dano
Os arquivos baixados ficam em dataset/artefact-parquet/ (pode apagar depois). Continua de onde parou se for interrompido.
"""
import csv, io
from pathlib import Path
import numpy as np
import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
REPO = 'danielaivanova/damaged-media'
PARTES = [2, 5, 6, 7, 8, 10, 15, 16, 24, 25, 26, 27]  # as 12 partes (de 28) que tem tela ou pintura
LADO, LADO_REVISAO = 2560, 1500


def redimensionar(imagem, lado, filtro):
    escala = lado / max(imagem.size)
    return imagem.resize((round(imagem.width * escala), round(imagem.height * escala)), filtro)


def main():
    saida = Path('dataset/artefact')
    for sub in ('img', 'mask', 'revisao'): (saida / sub).mkdir(parents=True, exist_ok=True)
    caminho_indice = saida / 'indice.csv'
    ja_feitos = set()
    if caminho_indice.exists():
        ja_feitos = {l['id'] for l in csv.DictReader(open(caminho_indice, encoding='utf-8-sig'))}
    novo = not caminho_indice.exists()
    campos = ['id', 'material', 'tipo', 'conteudo', 'largura_original', 'altura_original', 'valores_da_mascara', 'descricao_do_dano']
    with open(caminho_indice, 'a', encoding='utf-8-sig', newline='') as arq_indice:
        escritor = csv.DictWriter(arq_indice, fieldnames=campos)
        if novo: escritor.writeheader()
        for numero in PARTES:
            nome = 'data/train-%05d-of-00028.parquet' % numero
            print('parte %d: baixando %s ...' % (numero, nome), flush=True)
            caminho = hf_hub_download(REPO, nome, repo_type='dataset', local_dir='dataset/artefact-parquet')
            for lote in pq.ParquetFile(caminho).iter_batches(batch_size=2):
                for linha in lote.to_pylist():
                    if not (linha['material'] == 'Canvas' or linha['type'] == 'Painting'): continue
                    identificador = str(linha['id']).replace('/', '_').replace('\\', '_').replace(' ', '_')
                    if identificador in ja_feitos: continue
                    foto = Image.open(io.BytesIO(linha['image']['bytes'])).convert('RGB')
                    mascara = Image.open(io.BytesIO(linha['annotation']['bytes']))
                    colorida = Image.open(io.BytesIO(linha['annotation_rgb']['bytes'])).convert('RGB')
                    largura, altura = foto.size
                    if mascara.size != foto.size: mascara = mascara.resize(foto.size, Image.NEAREST)
                    if colorida.size != foto.size: colorida = colorida.resize(foto.size, Image.NEAREST)
                    valores, contagens = np.unique(np.asarray(mascara), return_counts=True)
                    resumo = ' '.join('%s:%d' % (v, c) for v, c in zip(valores.tolist(), contagens.tolist()))
                    redimensionar(foto, LADO, Image.LANCZOS).save(saida / 'img' / (identificador + '.jpg'), quality=92)
                    redimensionar(mascara, LADO, Image.NEAREST).save(saida / 'mask' / (identificador + '.png'))
                    pequena = redimensionar(foto, LADO_REVISAO, Image.LANCZOS)
                    sobre = redimensionar(colorida, LADO_REVISAO, Image.NEAREST)
                    Image.blend(pequena, sobre, 0.5).save(saida / 'revisao' / (identificador + '.jpg'), quality=85)
                    escritor.writerow(dict(id=identificador, material=linha['material'], tipo=linha['type'], conteudo=linha['content'],
                                           largura_original=largura, altura_original=altura, valores_da_mascara=resumo,
                                           descricao_do_dano=(linha['damage_description'] or '').replace('\n', ' ')))
                    arq_indice.flush()
                    print('  %s (%s, %s) ok' % (identificador, linha['material'], linha['type']), flush=True)
    print('\nPronto. Veja dataset/artefact/indice.csv e a pasta dataset/artefact/revisao/.')


if __name__ == '__main__':
    main()
