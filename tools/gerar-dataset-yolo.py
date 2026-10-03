"""
Passo 3 do treino: transforma as fotos rotuladas em recortes de 640 x 640 px no formato do YOLO.

Entrada : dataset/trabalho/*.jpg  (fotos normalizadas pelo preparar-fotos.py)
          dataset/rotulos.json    (caixas exportadas pelo tools/rotular.html, em pixels da foto original)
Saida   : dataset/yolo/images/{train,val}, dataset/yolo/labels/{train,val}, dataset/yolo/data.yaml
          dataset/yolo.zip        (para subir no Google Colab)

Regras (todas ajustaveis nos argumentos):
  - As caixas sao convertidas para a escala de trabalho (lado maior = 2560 px).
  - Caixas com lado maior que --max-lado sao consideradas ambiguas (faixas grandes, logo inteiro):
    nao viram rotulo e os recortes que tocam nelas sao descartados, para nao ensinar "mancha = normal".
  - Caixa cortada pela borda do recorte: fica se pelo menos 50% dela esta visivel. Se ficar entre 10% e 50%,
    o recorte e descartado (caso ambiguo).
  - Recortes sem nenhuma caixa (negativos) entram na proporcao --negativos por recorte positivo.
  - A validacao usa fotos inteiras separadas (--val), nunca recortes soltos da mesma foto.
"""
import argparse, json, random, shutil, zipfile
from pathlib import Path
from PIL import Image

LADO_TRABALHO = 2560
TAMANHO = 640
PASSO = 320

def carregar(args):
    dados = json.loads(Path(args.rotulos).read_text(encoding='utf-8'))
    fotos = {}
    for foto in dados['fotos']:
        if not foto.get('revisada'):
            print('aviso: foto nao marcada como revisada, ignorada:', foto['arquivo'])
            continue
        escala = LADO_TRABALHO / max(foto['largura'], foto['altura'])
        caixas, ambiguas = [], []
        for c in foto['caixas']:
            caixa = (c['x'] * escala, c['y'] * escala, (c['x'] + c['w']) * escala, (c['y'] + c['h']) * escala)
            lado = max(caixa[2] - caixa[0], caixa[3] - caixa[1])
            (ambiguas if lado > args.max_lado else caixas).append(caixa)
        fotos[Path(foto['arquivo']).stem] = {'caixas': caixas, 'ambiguas': ambiguas}
    return fotos

def intersecao(a, b):
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    return max(0, x1 - x0) * max(0, y1 - y0)

def area(a): return max(0, a[2] - a[0]) * max(0, a[3] - a[1])

def recortes_da_foto(largura, altura):
    xs = list(range(0, max(1, largura - TAMANHO + 1), PASSO)); ys = list(range(0, max(1, altura - TAMANHO + 1), PASSO))
    if xs[-1] != largura - TAMANHO: xs.append(max(0, largura - TAMANHO))
    if ys[-1] != altura - TAMANHO: ys.append(max(0, altura - TAMANHO))
    return [(x, y, x + TAMANHO, y + TAMANHO) for y in ys for x in xs]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--trabalho', default='dataset/trabalho')
    ap.add_argument('--rotulos', default='dataset/rotulos.json')
    ap.add_argument('--saida', default='dataset/yolo')
    ap.add_argument('--val', nargs='*', default=['IMG_3696', 'IMG_3703'], help='fotos inteiras reservadas para validacao')
    ap.add_argument('--max-lado', type=float, default=300, help='lado maximo (px, escala 2560) de uma caixa valida')
    ap.add_argument('--negativos', type=float, default=1.0, help='recortes sem dano por recorte com dano')
    ap.add_argument('--semente', type=int, default=7)
    args = ap.parse_args()
    random.seed(args.semente)

    fotos = carregar(args)
    saida = Path(args.saida)
    if saida.exists(): shutil.rmtree(saida)
    for sub in ('images/train', 'images/val', 'labels/train', 'labels/val'): (saida / sub).mkdir(parents=True)

    resumo = {'train': [0, 0, 0], 'val': [0, 0, 0]}   # positivos, negativos, caixas
    descartados = 0
    for nome, info in fotos.items():
        caminho = Path(args.trabalho) / (nome + '.jpg')
        if not caminho.exists(): print('foto de trabalho nao encontrada:', caminho); continue
        imagem = Image.open(caminho).convert('RGB')
        conjunto = 'val' if nome in args.val else 'train'
        positivos, negativos = [], []
        for rec in recortes_da_foto(*imagem.size):
            if any(intersecao(rec, a) > 0 for a in info['ambiguas']):
                descartados += 1; continue
            linhas, ambiguo = [], False
            for caixa in info['caixas']:
                visivel = intersecao(rec, caixa) / max(1, area(caixa))
                if visivel <= 0: continue
                if visivel < 0.1: continue                  # so uma ponta: ignora
                if visivel < 0.5: ambiguo = True; break     # cortada demais: recorte ambiguo
                x0, y0 = max(caixa[0], rec[0]) - rec[0], max(caixa[1], rec[1]) - rec[1]
                x1, y1 = min(caixa[2], rec[2]) - rec[0], min(caixa[3], rec[3]) - rec[1]
                if x1 - x0 < 8 or y1 - y0 < 8: continue
                linhas.append('0 %.6f %.6f %.6f %.6f' % ((x0 + x1) / 2 / TAMANHO, (y0 + y1) / 2 / TAMANHO, (x1 - x0) / TAMANHO, (y1 - y0) / TAMANHO))
            if ambiguo: descartados += 1; continue
            (positivos if linhas else negativos).append((rec, linhas))
        escolhidos_neg = negativos if conjunto == 'val' else random.sample(negativos, min(len(negativos), round(len(positivos) * args.negativos)))
        for rec, linhas in positivos + escolhidos_neg:
            base = '%s_%d_%d' % (nome, rec[0], rec[1])
            imagem.crop(rec).save(saida / 'images' / conjunto / (base + '.jpg'), quality=88)
            (saida / 'labels' / conjunto / (base + '.txt')).write_text('\n'.join(linhas) + ('\n' if linhas else ''))
            resumo[conjunto][2] += len(linhas)
        resumo[conjunto][0] += len(positivos); resumo[conjunto][1] += len(escolhidos_neg)
        print('%s -> %s: %d recortes com dano, %d sem dano (de %d disponiveis), %d caixas validas, %d caixas ambiguas ignoradas'
              % (nome, conjunto, len(positivos), len(escolhidos_neg), len(negativos), len(info['caixas']), len(info['ambiguas'])))

    (saida / 'data.yaml').write_text('path: .\ntrain: images/train\nval: images/val\nnames:\n  0: avaria\n')
    for conjunto, (pos, neg, cx) in resumo.items():
        print('%s: %d recortes com dano + %d sem dano, %d caixas' % (conjunto, pos, neg, cx))
    print('recortes descartados por ambiguidade:', descartados)
    arquivo_zip = saida.parent / 'yolo.zip'
    with zipfile.ZipFile(arquivo_zip, 'w', zipfile.ZIP_DEFLATED) as z:
        for arq in sorted(saida.rglob('*')):
            if arq.is_file(): z.write(arq, arq.relative_to(saida))
    print('zip para o Colab:', arquivo_zip, '(%.1f MB)' % (arquivo_zip.stat().st_size / 1048576))

if __name__ == '__main__':
    main()
