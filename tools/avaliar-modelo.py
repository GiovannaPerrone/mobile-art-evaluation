"""
Avalia modelos ONNX (YOLO de uma classe) em imagens de teste que nunca entraram no treino.
Tudo na escala de trabalho (lado maior = 2560 px). Uso (na raiz do projeto): python3 tools/avaliar-modelo.py models/x.onnx nome 0.25 0.10
Precisa de onnxruntime, numpy e pillow. Escreve resultados_<nome>.json e saida_<nome>/ no diretorio atual.
Gabaritos: caixas da autora (Met, albuns), poligonos dos especialistas (ArtInsight) com e sem as caixas da autora.
"""
import sys, json, os
import numpy as np, onnxruntime as ort
from PIL import Image, ImageOps, ImageDraw

RAIZ = os.environ.get('RAIZ_DATASET') or ('dataset' if os.path.isdir('dataset') else '/mnt/user-data/uploads/triagem-de-avarias/dataset')
LADO, TAM, PASSO = 2560, 640, 480


def carregar_modelo(caminho):
    sess = ort.InferenceSession(caminho, providers=['CPUExecutionProvider'])
    return sess, sess.get_inputs()[0].name


def nms(caixas, scores, limiar=0.45):
    ordem = np.argsort(-scores); manter = []
    while len(ordem):
        i = ordem[0]; manter.append(i)
        if len(ordem) == 1: break
        resto = ordem[1:]
        x1 = np.maximum(caixas[i, 0], caixas[resto, 0]); y1 = np.maximum(caixas[i, 1], caixas[resto, 1])
        x2 = np.minimum(caixas[i, 2], caixas[resto, 2]); y2 = np.minimum(caixas[i, 3], caixas[resto, 3])
        inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
        a = (caixas[i, 2] - caixas[i, 0]) * (caixas[i, 3] - caixas[i, 1])
        b = (caixas[resto, 2] - caixas[resto, 0]) * (caixas[resto, 3] - caixas[resto, 1])
        ordem = resto[inter / (a + b - inter + 1e-9) < limiar]
    return manter


def prever(sess, entrada, imagem, confianca_minima):
    """Retorna imagem em 2560 px e todas as caixas com conf >= confianca_minima (depois do NMS)."""
    w, h = imagem.size; esc = LADO / max(w, h)
    img = imagem.resize((round(w * esc), round(h * esc)), Image.LANCZOS)
    W, H = img.size
    xs = list(range(0, max(W - TAM, 0) + 1, PASSO)); ys = list(range(0, max(H - TAM, 0) + 1, PASSO))
    if xs[-1] != max(W - TAM, 0): xs.append(max(W - TAM, 0))
    if ys[-1] != max(H - TAM, 0): ys.append(max(H - TAM, 0))
    todas, pont = [], []
    for y in ys:
        for x in xs:
            rec = img.crop((x, y, x + TAM, y + TAM))
            arr = np.asarray(rec, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
            saida = sess.run(None, {entrada: arr})[0][0]
            for cx, cy, bw, bh, s in saida.T:
                if s >= confianca_minima:
                    todas.append([x + cx - bw / 2, y + cy - bh / 2, x + cx + bw / 2, y + cy + bh / 2]); pont.append(s)
    if not todas: return img, np.zeros((0, 4)), np.zeros(0)
    todas = np.array(todas); pont = np.array(pont)
    k = nms(todas, pont)
    return img, todas[k], pont[k]


def iou_matriz(a, b):
    if len(a) == 0 or len(b) == 0: return np.zeros((len(a), len(b)))
    x1 = np.maximum(a[:, None, 0], b[None, :, 0]); y1 = np.maximum(a[:, None, 1], b[None, :, 1])
    x2 = np.minimum(a[:, None, 2], b[None, :, 2]); y2 = np.minimum(a[:, None, 3], b[None, :, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    aa = ((a[:, 2] - a[:, 0]) * (a[:, 3] - a[:, 1]))[:, None]; bb = ((b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1]))[None, :]
    return inter / (aa + bb - inter + 1e-9)


def caixas_json(arquivo, nome):
    dados = json.load(open(os.path.join(RAIZ, arquivo), encoding='utf-8'))
    for f in dados['fotos']:
        if f['arquivo'] == nome:
            e = LADO / max(f['largura'], f['altura'])
            return np.array([[c['x'] * e, c['y'] * e, (c['x'] + c['w']) * e, (c['y'] + c['h']) * e] for c in f['caixas']]).reshape(-1, 4)
    raise KeyError(nome)


def poligonos_especialistas(nome_pintura, tamanho_limpa):
    dados = json.load(open(os.path.join(RAIZ, 'artinsight/DatasetArtInsight/Dataset/lpl/test/lpl_test.json')))
    orig = Image.open(os.path.join(RAIZ, 'artinsight/DatasetArtInsight/Dataset/lpl/test', nome_pintura)).size
    e = tamanho_limpa[0] / orig[0]
    pols = []
    for entrada in dados.values():
        if entrada['filename'] != nome_pintura: continue
        for r in entrada['regions'].values():
            pols.append([(x * e, y * e) for x, y in zip(r['shape_attributes']['all_points_x'], r['shape_attributes']['all_points_y'])])
    return pols


def mascara_gabarito(tamanho, caixas, poligonos):
    m = Image.new('L', tamanho, 0); d = ImageDraw.Draw(m)
    for p in poligonos: d.polygon(p, fill=255)
    for c in caixas: d.rectangle(list(c), fill=255)
    return np.asarray(m) > 0


def montar_conjuntos():
    """Lista de (grupo, nome_do_teste, caminho, caixas_gt (n,4), poligonos_gt)."""
    itens = []
    for nome in ('met_436429.jpg', 'met_436514.jpg', 'met_27651.jpg'):
        itens.append(('Met (autora)', nome, f'extras-para-rotular/{nome}', caixas_json('rotulos-extras.json', nome), []))
    for nome in ('Pintura_0.10.jpg', 'Pintura_0.16.jpg'):
        caminho = f'pinturas-limpas/{nome}'
        tam = Image.open(os.path.join(RAIZ, caminho)).size
        pols = poligonos_especialistas(nome, tam)
        itens.append(('ArtInsight (especialistas)', nome, caminho, np.zeros((0, 4)), pols))
        itens.append(('ArtInsight (especialistas + autora)', nome, caminho, caixas_json('rotulos-pinturas.json', nome), pols))
    for nome in ('IMG_3705.jpeg', 'IMG_3706.jpeg', 'IMG_3707.jpeg', 'IMG_3708.jpeg', 'IMG_3709.jpeg'):
        itens.append(('Albuns com dano (autora)', nome, f'teste-kpop/{nome}', caixas_json('rotulos-albuns.json', nome), []))
    itens.append(('Album limpo', 'IMG_3704.jpeg', 'teste-kpop/IMG_3704.jpeg', np.zeros((0, 4)), []))
    return itens


def main():
    modelo, nome_modelo = sys.argv[1], sys.argv[2]
    confs = [float(c) for c in sys.argv[3:]] or [0.25]
    sess, entrada = carregar_modelo(modelo)
    itens = montar_conjuntos()
    cache = {}
    linhas = []
    pasta_saida = f'saida_{nome_modelo}'; os.makedirs(pasta_saida, exist_ok=True)
    for grupo, nome, caminho, gt, pols in itens:
        if caminho not in cache:
            im = ImageOps.exif_transpose(Image.open(os.path.join(RAIZ, caminho))).convert('RGB')
            cache[caminho] = prever(sess, entrada, im, min(confs))
        img, caixas, pont = cache[caminho]
        W, H = img.size
        mask_gt = mascara_gabarito((W, H), gt, pols)
        area_gt = mask_gt.mean()
        # caixas de gabarito em forma de caixa (poligono vira caixa envolvente) para recall por instancia
        gt_all = [np.array(g) for g in gt]
        for p in pols:
            xs = [q[0] for q in p]; ys = [q[1] for q in p]
            gt_all.append(np.array([min(xs), min(ys), max(xs), max(ys)]))
        gt_all = np.array(gt_all).reshape(-1, 4)
        for conf in confs:
            sel = pont >= conf
            cx = caixas[sel]
            mp = Image.new('L', (W, H), 0); dp = ImageDraw.Draw(mp)
            for c in cx: dp.rectangle(list(c), fill=255)
            mask_pred = np.asarray(mp) > 0
            area_pred = mask_pred.mean()
            prec_px = (mask_pred & mask_gt).sum() / max(1, mask_pred.sum()) if mask_pred.any() else 0.0
            rec_px = (mask_pred & mask_gt).sum() / max(1, mask_gt.sum()) if mask_gt.any() else 0.0
            iou = iou_matriz(gt_all, cx)
            n_gt = len(gt_all)
            toc = int((iou.max(axis=1) >= 0.1).sum()) if n_gt and len(cx) else 0
            ac = int((iou.max(axis=1) >= 0.3).sum()) if n_gt and len(cx) else 0
            cx_certas = int((iou.max(axis=0) >= 0.1).sum()) if n_gt and len(cx) else 0
            linhas.append(dict(grupo=grupo, nome=nome, conf=conf, n_gt=n_gt, caixas=len(cx), area_gt=area_gt, area_pred=area_pred,
                               prec_px=prec_px, rec_px=rec_px, ganho=(prec_px / area_gt if area_gt > 0 else 0), toc=toc, ac=ac, cx_certas=cx_certas))
            if abs(conf - confs[0]) < 1e-9:
                vis = img.copy(); dv = ImageDraw.Draw(vis, 'RGBA')
                ys_, xs_ = np.where(mask_gt)
                over = Image.fromarray((mask_gt * 90).astype(np.uint8)); vis.paste(Image.new('RGB', (W, H), (0, 255, 80)), (0, 0), over)
                for c in cx: dv.rectangle(list(c), outline=(255, 30, 30, 255), width=6)
                vis.thumbnail((1100, 1100)); vis.save(os.path.join(pasta_saida, f"{grupo.split()[0]}_{nome.split('.')[0]}_{'ea' if 'autora)' in grupo and 'especialistas' in grupo else 'x'}.jpg"), quality=85)
    json.dump(linhas, open(f'resultados_{nome_modelo}.json', 'w'), indent=1)
    for conf in confs:
        print(f'\n=== {nome_modelo} | conf >= {conf} ===')
        print('grupo | imagem | GT | caixas | area GT | area marcada | precisao px | cobertura px | ganho s/ acaso | tocadas | IoU>=.3')
        for l in [x for x in linhas if x['conf'] == conf]:
            print(f"{l['grupo']} | {l['nome']} | {l['n_gt']} | {l['caixas']} | {l['area_gt']*100:.1f}% | {l['area_pred']*100:.1f}% | "
                  f"{l['prec_px']*100:.0f}% | {l['rec_px']*100:.0f}% | {l['ganho']:.2f}x | {l['toc']}/{l['n_gt']} | {l['ac']}/{l['n_gt']}")


if __name__ == '__main__':
    main()
