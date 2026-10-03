"""
Converte as mascaras do ARTeFACT (dataset/artefact/) em caixas YOLO no mesmo formato que o rotulador exporta,
para entrar no gerador de conjuntos como mais um lote.

Saidas:
  dataset/rotulos-artefact.json   (formato do rotular.html: fotos -> arquivo, largura, altura, revisada, caixas x/y/w/h)
  dataset/fontes-artefact.csv     (arquivo, tecnica, uso (treino ou teste), fonte, licenca)
  dataset/artefact/caixas-revisao/<id>.jpg   (imagem com as caixas desenhadas, para conferir)

Uso:
  python tools/artefact-para-lote.py
  python tools/artefact-para-lote.py --classes 1,2,9 --cobertura-max 0.35 --teste-ids guay2s8f,fsj39ohc,...
"""
import argparse, csv, json, random
from pathlib import Path
import numpy as np, cv2
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None

TESTES_PADRAO = 'guay2s8f,fsj39ohc,adbn1t5w,1itw2smq,4k319he1,ar4o0udk'  # sufixos de ids de telas (canvas) separadas para teste


def caixas_da_mascara(binaria, args):
    lado_maior = max(binaria.shape)
    nucleo = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (args.juntar, args.juntar))
    unida = cv2.dilate(binaria, nucleo)
    n, rotulos = cv2.connectedComponents(unida)
    caixas = []
    for k in range(1, n):
        comp = (rotulos == k) & (binaria > 0)
        ys, xs = np.nonzero(comp)
        if len(xs) < args.area_min: continue
        x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        if max(x1 - x0, y1 - y0) <= args.max_caixa:
            blocos = [(x0, y0, x1, y1, len(xs))]
        else:
            blocos = []
            for gy in range(y0, y1, args.grade):
                for gx in range(x0, x1, args.grade):
                    sel = (xs >= gx) & (xs < gx + args.grade) & (ys >= gy) & (ys < gy + args.grade)
                    if sel.sum() < args.area_min: continue
                    bx, by = xs[sel], ys[sel]
                    blocos.append((bx.min(), by.min(), bx.max() + 1, by.max() + 1, int(sel.sum())))
        for bx0, by0, bx1, by1, area in blocos:
            if max(bx1 - bx0, by1 - by0) < args.lado_min: continue
            cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
            w = max(bx1 - bx0 + 2 * args.folga, args.lado_min)
            h = max(by1 - by0 + 2 * args.folga, args.lado_min)
            caixas.append((cx - w / 2, cy - h / 2, w, h, area))
    return caixas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pasta', default='dataset/artefact')
    ap.add_argument('--classes', default='1,2,9', help='valores da mascara que viram caixa (1 perda, 2 descascado, 9 rachadura)')
    ap.add_argument('--cobertura-max', type=float, default=0.35, help='descarta imagem se as classes escolhidas cobrem mais que isso')
    ap.add_argument('--perda-max', type=float, default=0.03, help='a classe 1 so vira caixa se cobrir menos que isso da imagem')
    ap.add_argument('--juntar', type=int, default=31, help='dilatacao (px) para unir pedacos vizinhos antes de contar componentes')
    ap.add_argument('--area-min', type=int, default=250, help='pixels minimos de mascara por caixa')
    ap.add_argument('--lado-min', type=int, default=28, help='lado minimo da caixa (px, imagem de 2560)')
    ap.add_argument('--max-caixa', type=int, default=450, help='componentes maiores que isso sao divididos em grade')
    ap.add_argument('--grade', type=int, default=320)
    ap.add_argument('--folga', type=int, default=6)
    ap.add_argument('--max-por-imagem', type=int, default=160)
    ap.add_argument('--teste-ids', default=TESTES_PADRAO)
    ap.add_argument('--saida-json', default='dataset/rotulos-artefact.json')
    ap.add_argument('--saida-csv', default='dataset/fontes-artefact.csv')
    args = ap.parse_args()
    classes = [int(c) for c in args.classes.split(',')]
    testes = [t.strip() for t in args.teste_ids.split(',') if t.strip()]
    pasta = Path(args.pasta)
    revisao = pasta / 'caixas-revisao'
    revisao.mkdir(exist_ok=True)
    indice = list(csv.DictReader(open(pasta / 'indice.csv', encoding='utf-8-sig')))
    fotos, fontes = [], []
    print('%-10s %-6s %7s %7s %6s' % ('id', 'tipo', 'cobert.', 'caixas', 'uso'))
    totais = {'treino': [0, 0], 'teste': [0, 0]}
    for linha in indice:
        i = linha['id']
        material = linha['material']
        imagem = Image.open(pasta / 'img' / (i + '.jpg')).convert('RGB')
        mascara = np.array(Image.open(pasta / 'mask' / (i + '.png')))
        # classe 1 (perda de material) em area grande costuma ser o fundo ao redor de fragmentos/molduras, nao avaria: so entra se for pequena
        classes_da_imagem = [c for c in classes if c != 1 or (mascara == 1).mean() < args.perda_max]
        binaria = np.isin(mascara, classes_da_imagem).astype(np.uint8)
        cobertura = binaria.mean()
        uso = 'teste' if any(i.endswith(t) for t in testes) else 'treino'
        if cobertura == 0:
            print('%-10s %-6s %7.3f  (sem as classes escolhidas, ignorada)' % (i[-8:], material[:6], cobertura)); continue
        if cobertura > args.cobertura_max and uso == 'treino':
            print('%-10s %-6s %7.3f  (cobertura alta, ignorada)' % (i[-8:], material[:6], cobertura)); continue
        caixas = caixas_da_mascara(binaria, args)
        if len(caixas) > args.max_por_imagem:
            caixas = sorted(caixas, key=lambda c: -c[4])[:args.max_por_imagem]
        if not caixas:
            print('%-10s %-6s %7.3f  (nenhuma caixa valida)' % (i[-8:], material[:6], cobertura)); continue
        fotos.append({'arquivo': i + '.jpg', 'largura': imagem.width, 'altura': imagem.height, 'revisada': True,
                      'caixas': [{'x': round(float(c[0]), 1), 'y': round(float(c[1]), 1), 'w': round(float(c[2]), 1), 'h': round(float(c[3]), 1)} for c in caixas]})
        fontes.append({'arquivo': i + '.jpg', 'tecnica': material, 'uso (treino ou teste)': uso,
                       'fonte': 'ARTeFACT (Ivanova et al.), huggingface danielaivanova/damaged-media', 'licenca': 'AFL-3.0'})
        totais[uso][0] += 1; totais[uso][1] += len(caixas)
        print('%-10s %-6s %7.3f %7d %6s' % (i[-8:], material[:6], cobertura, len(caixas), uso), flush=True)
        reduzida = imagem.copy(); fator = 1400 / max(imagem.size)
        reduzida = reduzida.resize((round(imagem.width * fator), round(imagem.height * fator)))
        desenho = ImageDraw.Draw(reduzida)
        for c in caixas:
            desenho.rectangle([c[0] * fator, c[1] * fator, (c[0] + c[2]) * fator, (c[1] + c[3]) * fator], outline=(255, 40, 40), width=2)
        reduzida.save(revisao / (i + '.jpg'), quality=85)
    Path(args.saida_json).write_text(json.dumps({'fotos': fotos}, ensure_ascii=False), encoding='utf-8')
    with open(args.saida_csv, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['arquivo', 'tecnica', 'uso (treino ou teste)', 'fonte', 'licenca'])
        w.writeheader(); w.writerows(fontes)
    print('\nTREINO: %d imagens, %d caixas | TESTE: %d imagens, %d caixas' % (*totais['treino'], *totais['teste']))
    print('gravados:', args.saida_json, args.saida_csv)


if __name__ == '__main__':
    main()
