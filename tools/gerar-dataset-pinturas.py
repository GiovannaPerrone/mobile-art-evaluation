"""
Monta o dataset de treino com as pinturas do ArtInsight (perda da camada de pintura, anotada por
especialistas da Universidad de Granada) mais as caixas que a autora marcou no rotular.html.

Gera dois conjuntos no formato do YOLO, cada um com seu zip para o Google Colab:
  A: so as pinturas (ArtInsight + pinturas do Met)       -> dataset/yolo-A-pinturas.zip
  B: A + recortes do steelbook + pecas de metal do Met   -> dataset/yolo-B-pinturas-steelbook.zip
Classe unica, "avaria" (rachadura, mancha, perda de tinta e avaria geral viram a mesma classe: ha
poucos exemplos de cada tipo para o modelo aprender classes separadas).

Entrada : dataset/pinturas-limpas/*.jpg           (lado maior = 2560 px, sem desenho por cima)
          dataset/artinsight/.../lpl/{train,test}  (fotos originais e poligonos dos especialistas)
          dataset/rotulos-pinturas.json           (caixas da autora, em pixels da imagem de 2560 px)
          dataset/yolo.zip                        (recortes do steelbook, so para o conjunto B)
          dataset/extras-para-rotular/met_*.jpg   (pinturas e metais do Met Open Access, CC0, 2560 px)
          dataset/rotulos-extras.json             (caixas da autora nas imagens do Met, em pixels da imagem original)
          dataset/fontes-met.csv                  (coluna "uso": so as linhas "treino" entram; "teste" nunca entra)

As pinturas de TESTE do ArtInsight (pasta test) nunca entram aqui. Uma pintura de treino fica
reservada para validacao (--val).

Regras (mesmo espirito do gerar-dataset-yolo.py):
  - Poligono dos especialistas vira caixa pela parte visivel dentro do recorte de 640 x 640 px.
  - Poligono grande (lado maior da caixa total acima de --max-lado, como as faixas de borda da tela):
    os recortes que tocam nele sao descartados, para nao ensinar "borda da tela = dano".
  - Parte visivel entre 10% e 50% de um dano: recorte descartado (ambiguo). Abaixo de 10%: so uma ponta.
  - Caixa da autora com 50% ou mais da area dentro de um poligono dos especialistas e duplicata
    (ou marca de gravidade) e nao vira caixa nova.
  - Recorte sem nenhuma marcacao e sem nenhum poligono tocando entra como negativo, na proporcao
    --negativos por recorte positivo (na validacao entram todos).
"""
import argparse, csv, json, random, shutil, zipfile
from pathlib import Path
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None
TAMANHO = 640
PASSO = 320


def area_poligono(pontos):
    soma = 0.0
    for i in range(len(pontos)):
        x0, y0 = pontos[i]; x1, y1 = pontos[(i + 1) % len(pontos)]
        soma += x0 * y1 - x1 * y0
    return abs(soma) / 2


def intersecao(a, b):
    return max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))


def area(a):
    return max(0, a[2] - a[0]) * max(0, a[3] - a[1])


def recortes_da_foto(largura, altura):
    xs = list(range(0, max(1, largura - TAMANHO + 1), PASSO)); ys = list(range(0, max(1, altura - TAMANHO + 1), PASSO))
    if xs[-1] != largura - TAMANHO: xs.append(max(0, largura - TAMANHO))
    if ys[-1] != altura - TAMANHO: ys.append(max(0, altura - TAMANHO))
    return [(x, y, x + TAMANHO, y + TAMANHO) for y in ys for x in xs]


def linha_yolo(x0, y0, x1, y1):
    return '0 %.6f %.6f %.6f %.6f' % ((x0 + x1) / 2 / TAMANHO, (y0 + y1) / 2 / TAMANHO, (x1 - x0) / TAMANHO, (y1 - y0) / TAMANHO)


def carregar_poligonos_treino(pasta_lpl):
    """Poligonos dos especialistas so das imagens de treino: nome -> (lista de poligonos, tamanho original)."""
    pasta = Path(pasta_lpl)
    resultado = {}
    gabarito = json.loads((pasta / 'train' / 'lpl_train.json').read_text(encoding='utf-8'))
    for entrada in gabarito.values():
        nome = entrada['filename']
        tamanho_original = Image.open(pasta / 'train' / nome).size
        poligonos = [list(zip(r['shape_attributes']['all_points_x'], r['shape_attributes']['all_points_y']))
                     for r in entrada['regions'].values()]
        resultado[nome] = (poligonos, tamanho_original)
    return resultado


def preparar_pintura(nome, imagem, poligonos_originais, tamanho_original, caixas_autora, args):
    largura, altura = imagem.size
    escala = largura / tamanho_original[0]
    poligonos = []
    for pontos_orig in poligonos_originais:
        pontos = [(x * escala, y * escala) for x, y in pontos_orig]
        xs = [p[0] for p in pontos]; ys = [p[1] for p in pontos]
        caixa_total = (min(xs), min(ys), max(xs), max(ys))
        poligonos.append({'pontos': pontos, 'caixa': caixa_total, 'area': area_poligono(pontos),
                          'grande': max(caixa_total[2] - caixa_total[0], caixa_total[3] - caixa_total[1]) > args.max_lado})

    # mascara dos especialistas, para reconhecer caixas da autora que repetem o que eles ja marcaram
    mascara = Image.new('L', (largura, altura), 0)
    desenho = ImageDraw.Draw(mascara)
    for p in poligonos:
        desenho.polygon(p['pontos'], fill=255)

    suas, duplicadas = [], 0
    for c in caixas_autora:
        caixa = (c['x'], c['y'], c['x'] + c['w'], c['y'] + c['h'])
        dentro = mascara.crop(tuple(int(round(v)) for v in caixa)).histogram()[255] / max(1, area(caixa))
        if dentro >= 0.5:
            duplicadas += 1
            continue
        lado = max(caixa[2] - caixa[0], caixa[3] - caixa[1])
        suas.append({'caixa': caixa, 'grande': lado > args.max_lado})

    positivos, negativos, descartados = [], [], 0
    for rec in recortes_da_foto(largura, altura):
        ambiguo, tocou, linhas = False, False, []
        for p in poligonos:
            if intersecao(rec, p['caixa']) <= 0: continue
            parte = Image.new('L', (TAMANHO, TAMANHO), 0)
            ImageDraw.Draw(parte).polygon([(x - rec[0], y - rec[1]) for x, y in p['pontos']], fill=255)
            visivel_px = parte.histogram()[255]
            if visivel_px == 0: continue
            tocou = True
            if p['grande']: ambiguo = True; break
            fracao = visivel_px / max(1.0, p['area'])
            if fracao < 0.1: continue
            if fracao < 0.5: ambiguo = True; break
            x0, y0, x1, y1 = parte.getbbox()
            if x1 - x0 >= 8 and y1 - y0 >= 8: linhas.append(linha_yolo(x0, y0, x1, y1))
        if ambiguo: descartados += 1; continue
        for s in suas:
            if intersecao(rec, s['caixa']) <= 0: continue
            tocou = True
            if s['grande']: ambiguo = True; break
            fracao = intersecao(rec, s['caixa']) / max(1.0, area(s['caixa']))
            if fracao < 0.1: continue
            if fracao < 0.5: ambiguo = True; break
            x0, y0 = max(s['caixa'][0], rec[0]) - rec[0], max(s['caixa'][1], rec[1]) - rec[1]
            x1, y1 = min(s['caixa'][2], rec[2]) - rec[0], min(s['caixa'][3], rec[3]) - rec[1]
            if x1 - x0 >= 8 and y1 - y0 >= 8: linhas.append(linha_yolo(x0, y0, x1, y1))
        if ambiguo: descartados += 1; continue
        if linhas: positivos.append((rec, linhas))
        elif tocou: descartados += 1          # tem dano por perto, mas pequeno demais para virar rotulo: nao serve de negativo
        else: negativos.append((rec, []))
    return positivos, negativos, descartados, len(poligonos), len(suas), duplicadas


def gravar_recorte(imagem, rec, linhas, pasta, conjunto, nome_base):
    imagem.crop(rec).save(pasta / 'images' / conjunto / (nome_base + '.jpg'), quality=88)
    (pasta / 'labels' / conjunto / (nome_base + '.txt')).write_text('\n'.join(linhas) + ('\n' if linhas else ''))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pinturas', default='dataset/pinturas-limpas')
    ap.add_argument('--lpl', default='dataset/artinsight/DatasetArtInsight/Dataset/lpl')
    ap.add_argument('--rotulos', default='dataset/rotulos-pinturas.json')
    ap.add_argument('--steelbook-zip', default='dataset/yolo.zip')
    ap.add_argument('--extras', default='dataset/extras-para-rotular')
    ap.add_argument('--rotulos-extras', default='dataset/rotulos-extras.json')
    ap.add_argument('--fontes-met', default='dataset/fontes-met.csv')
    ap.add_argument('--max-lado-metal', type=float, default=300, help='lado maximo valido nas pecas de metal (como no steelbook)')
    ap.add_argument('--saida', default='dataset')
    ap.add_argument('--val', nargs='*', default=['Pintura_0.18'], help='pinturas de treino reservadas para validacao')
    ap.add_argument('--max-lado', type=float, default=600, help='lado maximo (px, escala 2560) de uma lacuna valida')
    ap.add_argument('--negativos', type=float, default=1.0)
    ap.add_argument('--semente', type=int, default=7)
    args = ap.parse_args()
    random.seed(args.semente)

    poligonos_treino = carregar_poligonos_treino(args.lpl)
    rotulos = {Path(f['arquivo']).name: f for f in json.loads(Path(args.rotulos).read_text(encoding='utf-8'))['fotos']}
    saida = Path(args.saida)
    conjuntos = {'A': saida / 'yolo-A', 'B': saida / 'yolo-B'}
    for pasta in conjuntos.values():
        if pasta.exists(): shutil.rmtree(pasta)
        for sub in ('images/train', 'images/val', 'labels/train', 'labels/val'): (pasta / sub).mkdir(parents=True)

    resumo = {'train': [0, 0, 0], 'val': [0, 0, 0]}
    for nome, (poligonos_originais, tamanho_original) in sorted(poligonos_treino.items()):
        ficha = rotulos.get(nome)
        if ficha is None or not ficha.get('revisada'):
            print('aviso: sem rotulos revisados, ignorada:', nome); continue
        escala_autora = None
        imagem = Image.open(Path(args.pinturas) / nome).convert('RGB')
        if (ficha['largura'], ficha['altura']) != imagem.size:
            print('aviso: tamanho dos rotulos diferente da imagem limpa, ignorada:', nome, (ficha['largura'], ficha['altura']), imagem.size); continue
        positivos, negativos, descartados, n_poligonos, n_suas, n_duplicadas = preparar_pintura(
            nome, imagem, poligonos_originais, tamanho_original, ficha['caixas'], args)
        conjunto = 'val' if Path(nome).stem in args.val else 'train'
        escolhidos = negativos if conjunto == 'val' else random.sample(negativos, min(len(negativos), round(len(positivos) * args.negativos)))
        for rec, linhas in positivos + escolhidos:
            base = '%s_%d_%d' % (Path(nome).stem, rec[0], rec[1])
            for pasta in conjuntos.values(): gravar_recorte(imagem, rec, linhas, pasta, conjunto, base)
            resumo[conjunto][2] += len(linhas)
        resumo[conjunto][0] += len(positivos); resumo[conjunto][1] += len(escolhidos)
        print('%s -> %s: %d recortes com dano, %d sem dano (de %d), %d descartados | %d poligonos dos especialistas, '
              '%d caixas da autora usadas, %d repetiam os especialistas' % (nome, conjunto, len(positivos), len(escolhidos),
              len(negativos), descartados, n_poligonos, n_suas, n_duplicadas))

    # imagens do Met marcadas como "treino" no fontes-met.csv (as de "teste" nunca entram)
    tipos = {}
    with open(args.fontes_met, encoding='utf-8-sig', newline='') as arquivo_csv:
        for linha in csv.DictReader(arquivo_csv):
            if linha['uso (treino ou teste)'].strip() == 'treino': tipos[Path(linha['arquivo']).name] = linha['tipo'].strip()
    rotulos_extras = {Path(f['arquivo']).name: f for f in json.loads(Path(args.rotulos_extras).read_text(encoding='utf-8'))['fotos']}
    resumo_met = {'pintura': [0, 0, 0], 'metal': [0, 0, 0]}
    for nome, tipo in sorted(tipos.items()):
        ficha = rotulos_extras.get(nome)
        if ficha is None or not ficha.get('revisada'):
            print('aviso: Met sem rotulos revisados, ignorada:', nome); continue
        imagem = Image.open(Path(args.extras) / nome).convert('RGB')
        escala = imagem.width / ficha['largura']
        if abs(imagem.height - ficha['altura'] * escala) > 2:
            print('aviso: proporcao dos rotulos diferente da imagem, ignorada:', nome); continue
        caixas = [{'x': c['x'] * escala, 'y': c['y'] * escala, 'w': c['w'] * escala, 'h': c['h'] * escala} for c in ficha['caixas']]
        metal = tipo.lower().startswith('metal')
        opcoes = argparse.Namespace(**{**vars(args), 'max_lado': args.max_lado_metal if metal else args.max_lado})
        positivos, negativos, descartados, _, n_suas, _ = preparar_pintura(nome, imagem, [], imagem.size, caixas, opcoes)
        escolhidos = random.sample(negativos, min(len(negativos), round(len(positivos) * args.negativos)))
        destinos = [conjuntos['B']] if metal else list(conjuntos.values())
        for rec, linhas in positivos + escolhidos:
            for pasta in destinos: gravar_recorte(imagem, rec, linhas, pasta, 'train', 'met_%s_%d_%d' % (Path(nome).stem.replace('met_', ''), rec[0], rec[1]))
        grupo = 'metal' if metal else 'pintura'
        resumo_met[grupo][0] += len(positivos); resumo_met[grupo][1] += len(escolhidos)
        resumo_met[grupo][2] += sum(len(l) for _, l in positivos)
        print('%s (%s, %s) -> train: %d recortes com dano, %d sem dano (de %d), %d descartados, %d caixas da autora'
              % (nome, tipo, 'so B' if metal else 'A e B', len(positivos), len(escolhidos), len(negativos), descartados, n_suas))
    print('MET: pinturas %s | metais %s  [com dano, sem dano, caixas]' % (resumo_met['pintura'], resumo_met['metal']))

    print('ARTINSIGHT (conjunto A, sem o Met):')
    for c, (pos, neg, cx) in resumo.items(): print('  %s: %d com dano + %d sem dano, %d caixas' % (c, pos, neg, cx))

    # conjunto B: acrescenta os recortes do steelbook
    with zipfile.ZipFile(args.steelbook_zip) as z:
        for info in z.infolist():
            if info.is_dir() or not info.filename.startswith(('images/', 'labels/')): continue
            destino = conjuntos['B'] / info.filename
            destino.parent.mkdir(parents=True, exist_ok=True)
            destino.write_bytes(z.read(info))

    for letra, pasta in conjuntos.items():
        (pasta / 'data.yaml').write_text('path: .\ntrain: images/train\nval: images/val\nnames:\n  0: avaria\n')
        quantidades = {c: len(list((pasta / 'images' / c).glob('*.jpg'))) for c in ('train', 'val')}
        nome_zip = saida / ('yolo-A-pinturas.zip' if letra == 'A' else 'yolo-B-pinturas-steelbook.zip')
        with zipfile.ZipFile(nome_zip, 'w', zipfile.ZIP_DEFLATED) as z:
            for arq in sorted(pasta.rglob('*')):
                if arq.is_file(): z.write(arq, arq.relative_to(pasta))
        print('conjunto %s: %d recortes de treino, %d de validacao -> %s (%.1f MB)'
              % (letra, quantidades['train'], quantidades['val'], nome_zip, nome_zip.stat().st_size / 1048576))


if __name__ == '__main__':
    main()
