"""
Monta um conjunto de treino juntando o conjunto A com varios LOTES de pinturas do Met rotuladas no tools/rotular.html.
Cada lote e um trio (mais um 4o campo opcional com a proporcao de recortes sem dano): pasta de imagens, JSON exportado do rotulador e CSV de fontes (coluna "uso": "teste" nunca entra).

Uso (os dois lotes abaixo ja sao o padrao; para um lote novo, repita --lote):
  python tools/gerar-dataset-met-lotes.py --nome yolo-C2
  python tools/gerar-dataset-met-lotes.py --nome yolo-C3 --lote dataset/trabalho-met,dataset/rotulos-tabalho-met.json,dataset/fontes-met-novas.csv --lote dataset/outra-pasta,dataset/outros-rotulos.json,dataset/outras-fontes.csv
  python tools/gerar-dataset-met-lotes.py --simular        (so conta os recortes, nao escreve nada)
  python tools/gerar-dataset-met-lotes.py --nome yolo-C3 --repetir-base 4 --negativos 0.5 --negativos-por-limpa 3   (conjunto reequilibrado)

Regras: as mesmas do conjunto C (tools/gerar-dataset-met-novas.py). Imagem revisada sem caixa = pintura limpa
(entram --negativos-por-limpa recortes sem dano). Lote cujo JSON ainda nao existe e ignorado com aviso.
Saida: dataset/<nome>/ e dataset/<nome>-pinturas-met.zip (o nome do zip vira o nome do modelo no Colab).
"""
import argparse, csv, importlib.util, json, random, shutil, zipfile
from collections import defaultdict
from pathlib import Path
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
aqui = Path(__file__).resolve().parent
especificacao = importlib.util.spec_from_file_location('gerar_dataset_pinturas', aqui / 'gerar-dataset-pinturas.py')
base_do_conjunto_a = importlib.util.module_from_spec(especificacao)
especificacao.loader.exec_module(base_do_conjunto_a)

LOTES_PADRAO = [
    'dataset/trabalho-met,dataset/rotulos-tabalho-met.json,dataset/fontes-met-novas.csv',
    'dataset/trabalho-met-candidatas-selecionadas,dataset/rotulos-met-selecionadas.json,dataset/fontes-met-candidatas-selecionadas.csv',
    'dataset/trabalho-met-novas2,dataset/rotulos-novas2.json,dataset/fontes-met-novas2.csv',
]


def ler_fontes(caminho_csv):
    fontes = {}
    with open(caminho_csv, encoding='utf-8-sig', newline='') as arquivo_csv:
        for linha in csv.DictReader(arquivo_csv):
            fontes[Path(linha['arquivo']).name] = linha
    return fontes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='dataset/yolo-A')
    ap.add_argument('--lote', action='append', help='IMAGENS,ROTULOS,CSV (repetivel)')
    ap.add_argument('--nome', default='yolo-C2')
    ap.add_argument('--saida', default='dataset')
    ap.add_argument('--max-lado', type=float, default=600)
    ap.add_argument('--negativos', type=float, default=1.0, help='recortes sem dano por recorte com dano, nas imagens com caixas')
    ap.add_argument('--negativos-por-limpa', type=int, default=8, help='recortes sem dano tirados de cada imagem sem caixa')
    ap.add_argument('--semente', type=int, default=7)
    ap.add_argument('--repetir-base', type=int, default=1, help='quantas vezes os recortes do conjunto A entram no treino (equilibra com o Met novo)')
    ap.add_argument('--simular', action='store_true', help='so conta, sem escrever arquivos')
    args = ap.parse_args()
    random.seed(args.semente)
    lotes = args.lote or LOTES_PADRAO

    pasta_nova = Path(args.saida) / args.nome
    if not args.simular:
        if pasta_nova.exists():
            try: shutil.rmtree(pasta_nova)
            except OSError:
                raise SystemExit('A pasta %s ja existe e nao pude apagar. Use outro --nome.' % pasta_nova)
        shutil.copytree(args.base, pasta_nova)
        antes = len(list((pasta_nova / 'images' / 'train').glob('*.jpg')))
        for r in range(2, args.repetir_base + 1):
            for jpg in sorted((pasta_nova / 'images' / 'train').glob('*.jpg')):
                if '_rep' in jpg.stem: continue
                txt = pasta_nova / 'labels' / 'train' / (jpg.stem + '.txt')
                shutil.copy2(jpg, jpg.with_name('%s_rep%d.jpg' % (jpg.stem, r)))
                if txt.exists(): shutil.copy2(txt, txt.with_name('%s_rep%d.txt' % (txt.stem, r)))
    else:
        antes = len(list((Path(args.base) / 'images' / 'train').glob('*.jpg')))

    resumo = defaultdict(lambda: {'imagens': 0, 'com_caixa': 0, 'positivos': 0, 'negativos': 0, 'caixas': 0})
    usados = set()
    novos = 0
    for texto in lotes:
        partes = [p.strip() for p in texto.split(',')]
        pasta_imagens, caminho_rotulos, caminho_csv = [Path(p) for p in partes[:3]]
        negativos_do_lote = float(partes[3]) if len(partes) > 3 else args.negativos  # 4o campo opcional: negativos deste lote
        if not caminho_rotulos.exists():
            print('LOTE IGNORADO (rotulos ainda nao existem): %s' % caminho_rotulos); continue
        fontes = ler_fontes(caminho_csv)
        fichas = json.loads(caminho_rotulos.read_text(encoding='utf-8'))['fotos']
        print('\n== lote %s: %d fotos rotuladas' % (pasta_imagens, len(fichas)))
        for ficha in sorted(fichas, key=lambda f: f['arquivo']):
            nome = Path(ficha['arquivo']).name
            linha = fontes.get(nome)
            uso = linha['uso (treino ou teste)'].strip() if linha else 'treino'
            if uso != 'treino':
                print('fora do treino (%s): %s' % (uso, nome)); continue
            if not ficha.get('revisada'):
                print('aviso: sem revisao, ignorada:', nome); continue
            if nome in usados:
                print('aviso: imagem repetida entre lotes, ignorada:', nome); continue
            usados.add(nome)
            imagem = Image.open(pasta_imagens / nome).convert('RGB')
            escala = imagem.width / ficha['largura']
            if abs(imagem.height - ficha['altura'] * escala) > 2:
                print('aviso: proporcao dos rotulos diferente da imagem, ignorada:', nome); continue
            caixas = [{'x': c['x'] * escala, 'y': c['y'] * escala, 'w': c['w'] * escala, 'h': c['h'] * escala} for c in ficha['caixas']]
            opcoes = argparse.Namespace(max_lado=args.max_lado)
            positivos, negativos, descartados, _, n_caixas, _ = base_do_conjunto_a.preparar_pintura(nome, imagem, [], imagem.size, caixas, opcoes)
            quantidade = round(len(positivos) * negativos_do_lote) if caixas else args.negativos_por_limpa
            escolhidos = random.sample(negativos, min(len(negativos), quantidade))
            for rec, linhas in positivos + escolhidos:
                base = 'metn_%s_%d_%d' % (Path(nome).stem.replace('met_', ''), rec[0], rec[1])
                if not args.simular:
                    base_do_conjunto_a.gravar_recorte(imagem, rec, linhas, pasta_nova, 'train', base)
                novos += 1
            tecnica = linha['tecnica'].lower() if linha else ''
            if not linha: grupo = 'madeira (fora do CSV)'
            elif 'canvas' in tecnica: grupo = 'tela'
            elif 'copper' in tecnica: grupo = 'cobre'
            elif any(s in tecnica for s in ('wood', 'panel')): grupo = 'madeira'
            elif any(s in tecnica for s in ('silk', 'paper', 'palm leaf')): grupo = 'papel/seda (asiatico)'
            else: grupo = 'outro'
            r = resumo[grupo]
            r['imagens'] += 1; r['com_caixa'] += bool(caixas); r['positivos'] += len(positivos); r['negativos'] += len(escolhidos)
            r['caixas'] += sum(len(l) for _, l in positivos)
            print('%s (%s): %d caixas, %d recortes com dano, %d sem dano (de %d), %d descartados'
                  % (nome, grupo, len(caixas), len(positivos), len(escolhidos), len(negativos), descartados), flush=True)

    print('\nRESUMO DO MET (recortes de 640 px que entram no treino):')
    for grupo, r in sorted(resumo.items()):
        print('  %-22s %2d imagens (%2d com caixa) | %3d recortes com dano (%d caixas) + %3d sem dano'
              % (grupo, r['imagens'], r['com_caixa'], r['positivos'], r['caixas'], r['negativos']))
    if args.simular:
        print('SIMULACAO: entrariam %d recortes novos do Met + %d do A (%d x %d). Total de treino: %d. Nada foi escrito.'
              % (novos, antes * args.repetir_base, antes, args.repetir_base, novos + antes * args.repetir_base)); return
    quantidades = {c: len(list((pasta_nova / 'images' / c).glob('*.jpg'))) for c in ('train', 'val')}
    print('conjunto %s: %d recortes de treino (A tinha %d), %d de validacao' % (args.nome, quantidades['train'], antes, quantidades['val']))
    (pasta_nova / 'data.yaml').write_text('path: .\ntrain: images/train\nval: images/val\nnames:\n  0: avaria\n')
    nome_zip = Path(args.saida) / (args.nome + '-pinturas-met.zip')
    with zipfile.ZipFile(nome_zip, 'w', zipfile.ZIP_STORED) as z:
        for arq in sorted(pasta_nova.rglob('*')):
            if arq.is_file(): z.write(arq, arq.relative_to(pasta_nova))
    print('zip: %s (%.1f MB)' % (nome_zip, nome_zip.stat().st_size / 1048576))


if __name__ == '__main__':
    main()
