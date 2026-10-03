"""
Compara modelos ONNX nas imagens de TESTE do Met (nunca entraram no treino do C2) e nas de teste antigas.
Roda em partes, com cache por imagem (cada chamada processa ate --orcamento segundos e continua da proxima).

  python3 tools/avaliar-met-teste.py rodar models/yolo-A-pinturas.onnx A      [--orcamento 150]
  python3 tools/avaliar-met-teste.py rodar models/yolo-C2-pinturas-met.onnx C2
  python3 tools/avaliar-met-teste.py resumo A C2

Medidas por imagem, com a confianca minima indicada (0.10 e 0.25):
  caixas   = quantas caixas o modelo marcou
  tocadas  = caixas do gabarito da autora que receberam alguma marca (IoU >= 0.1)
  area     = fracao da imagem coberta pelas marcas (nas imagens SEM dano marcado, isso mede alarme falso)
"""
import sys, os, json, time, csv, importlib.util
import numpy as np
from pathlib import Path
from PIL import Image, ImageOps

aqui = Path(__file__).resolve().parent
esp = importlib.util.spec_from_file_location('avaliar_modelo', aqui / 'avaliar-modelo.py')
base = importlib.util.module_from_spec(esp); esp.loader.exec_module(base)

CACHE = Path(os.environ.get('HOME', '.')) / 'cache-avaliacao'
CONFS = (0.10, 0.25)
LADO = 2560
# (id da imagem, caminho da imagem, json de rotulos, csv de fontes)
TESTES = [(f'met_{i}.jpg', f'dataset/trabalho-met/met_{i}.jpg', 'dataset/rotulos-tabalho-met.json', 'dataset/fontes-met-novas.csv')
          for i in (436078, 437862, 436582, 437158, 437220, 437677, 436068, 437698)]
TESTES += [(f'met_{i}.jpg', f'dataset/trabalho-met-novas2/met_{i}.jpg', 'dataset/rotulos-novas2.json', 'dataset/fontes-met-novas2.csv') for i in (435950, 45232)]
TESTES += [(f'met_{i}.jpg', f'dataset/extras-para-rotular/met_{i}.jpg', 'dataset/rotulos-extras.json', None) for i in (436429, 436514, 27651)]
# 6 telas do ARTeFACT separadas para teste (nunca entram no treino C4); gabarito vem das mascaras (dataset/rotulos-artefact.json)
for _sufixo in ('guay2s8f', 'fsj39ohc', 'adbn1t5w', '1itw2smq', '4k319he1', 'ar4o0udk'):
    for _arq in sorted(Path('dataset/artefact/img').glob('*%s.jpg' % _sufixo)):
        TESTES.append((_arq.name, str(_arq), 'dataset/rotulos-artefact.json', 'dataset/fontes-artefact.csv'))


def tecnica(nome, csv_fontes):
    if not csv_fontes: return 'madeira/outro (antigo)'
    for r in csv.DictReader(open(csv_fontes, encoding='utf-8-sig')):
        if r['arquivo'] == nome:
            t = r['tecnica'].lower()
            return 'tela' if 'canvas' in t else ('papel/seda' if any(s in t for s in ('silk', 'paper', 'palm')) else 'madeira/outro')
    return '?'


def gabarito(nome, json_rotulos):
    for f in json.load(open(json_rotulos, encoding='utf-8'))['fotos']:
        if Path(f['arquivo']).name == nome:
            e = LADO / max(f['largura'], f['altura'])
            return np.array([[c['x'] * e, c['y'] * e, (c['x'] + c['w']) * e, (c['y'] + c['h']) * e] for c in f['caixas']]).reshape(-1, 4)
    return None


def rodar(modelo, nome, orcamento):
    CACHE.mkdir(parents=True, exist_ok=True)
    sess, entrada = base.carregar_modelo(modelo)
    inicio = time.time(); feitas = 0; pendentes = 0
    for nome_img, caminho, _, _ in TESTES:
        arq = CACHE / f'{nome}__{nome_img}.npz'
        if arq.exists(): continue
        if time.time() - inicio > orcamento: pendentes += 1; continue
        if not Path(caminho).exists(): print('FALTA a imagem', caminho); continue
        im = ImageOps.exif_transpose(Image.open(caminho)).convert('RGB')
        img, caixas, pont = base.prever(sess, entrada, im, 0.05)
        np.savez(arq, caixas=caixas, pont=pont, tam=np.array(img.size)); feitas += 1
        print(f'  {nome}: {nome_img} ok ({time.time() - inicio:.0f}s)', flush=True)
    print(f'{nome}: {feitas} imagens feitas nesta chamada, {pendentes} pendentes.')


def medir(nome, nome_img, gt):
    arq = CACHE / f'{nome}__{nome_img}.npz'
    if not arq.exists(): return None
    d = np.load(arq); caixas, pont, (W, H) = d['caixas'], d['pont'], d['tam']
    out = {}
    for conf in CONFS:
        cx = caixas[pont >= conf]
        mascara = np.zeros((H, W), bool)
        for c in cx: mascara[int(max(c[1], 0)):int(c[3]), int(max(c[0], 0)):int(c[2])] = True
        iou = base.iou_matriz(gt, cx) if len(gt) and len(cx) else np.zeros((len(gt), len(cx)))
        out[conf] = dict(caixas=len(cx), tocadas=int((iou.max(axis=1) >= 0.1).sum()) if iou.size else 0, area=float(mascara.mean()))
    return out


def resumo(nomes):
    linhas = []
    for nome_img, caminho, rotulos, fontes in TESTES:
        gt = gabarito(nome_img, rotulos)
        if gt is None: print('sem gabarito:', nome_img); continue
        linhas.append((nome_img, tecnica(nome_img, fontes), gt, {n: medir(n, nome_img, gt) for n in nomes}))
    for conf in CONFS:
        print(f'\n=== confianca minima {conf} ===  (cada modelo: caixas | gabarito tocado | % da imagem marcada)')
        print('imagem | tipo | caixas do gabarito | ' + ' | '.join(nomes))
        for nome_img, tipo, gt, m in linhas:
            cel = []
            for n in nomes:
                r = m[n]
                cel.append('(sem cache)' if r is None else f"{r[conf]['caixas']} | {r[conf]['tocadas']}/{len(gt)} | {r[conf]['area']*100:.0f}%")
            print(f'{nome_img} | {tipo} | {len(gt)} | ' + ' || '.join(cel))
        print('-- somas por grupo --')
        for grupo in sorted({l[1] for l in linhas}):
            sel = [l for l in linhas if l[1] == grupo]
            n_gt = sum(len(l[2]) for l in sel)
            txt = []
            for n in nomes:
                rs = [l[3][n][conf] for l in sel if l[3][n]]
                if len(rs) < len(sel): txt.append(f'{n}: incompleto'); continue
                txt.append(f"{n}: {sum(r['tocadas'] for r in rs)}/{n_gt} tocadas, {sum(r['caixas'] for r in rs)} caixas, area media {np.mean([r['area'] for r in rs])*100:.0f}%")
            print(f'{grupo} ({len(sel)} imagens, {n_gt} caixas de gabarito): ' + ' || '.join(txt))


if __name__ == '__main__':
    modo = sys.argv[1]
    if modo == 'rodar':
        orc = float(sys.argv[sys.argv.index('--orcamento') + 1]) if '--orcamento' in sys.argv else 140
        rodar(sys.argv[2], sys.argv[3], orc)
    else:
        resumo(sys.argv[2:])
