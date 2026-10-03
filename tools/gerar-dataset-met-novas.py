"""
Monta o conjunto C: o conjunto A (ArtInsight + pinturas do Met antigas) mais as pinturas do Met que a autora
rotulou na rodada nova (tools/baixar-met.py + tools/rotular.html).

Entrada : dataset/yolo-A/                        (conjunto A ja gerado por tools/gerar-dataset-pinturas.py)
          dataset/trabalho-met/*.jpg             (imagens do Met, lado maior = 2560 px)
          dataset/rotulos-tabalho-met.json       (caixas e flag "revisada" exportados do rotular.html)
          dataset/fontes-met-novas.csv           (coluna "uso": "teste" nunca entra; imagem fora do CSV conta como treino)
Saida   : dataset/yolo-C/ e dataset/yolo-C-pinturas-met.zip  (para o Colab)

Regras (as mesmas do conjunto A, importadas de gerar-dataset-pinturas.py):
  - classe unica "avaria"; caixa grande demais (> --max-lado) descarta os recortes que tocam nela;
  - recorte com so uma ponta ou so parte da caixa (10% a 50%) e descartado como ambiguo.
Diferenca importante: imagem revisada SEM nenhuma caixa e uma pintura limpa. Dela entram
--negativos-por-limpa recortes sem dano (o conjunto A nao fazia isso). Imagem com caixas entra com
recortes com dano mais recortes sem dano na proporcao --negativos.
A validacao continua so com a pintura do ArtInsight reservada no conjunto A (as imagens de teste do Met ficam de fora).
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='dataset/yolo-A')
    ap.add_argument('--imagens', default='dataset/trabalho-met')
    ap.add_argument('--rotulos', default='dataset/rotulos-tabalho-met.json')
    ap.add_argument('--fontes', default='dataset/fontes-met-novas.csv')
    ap.add_argument('--saida', default='dataset')
    ap.add_argument('--max-lado', type=float, default=600)
    ap.add_argument('--negativos', type=float, default=1.0, help='recortes sem dano por recorte com dano, nas imagens com caixas')
    ap.add_argument('--negativos-por-limpa', type=int, default=8, help='recortes sem dano tirados de cada imagem sem caixa')
    ap.add_argument('--semente', type=int, default=7)
    args = ap.parse_args()
    random.seed(args.semente)

    fontes = {}
    with open(args.fontes, encoding='utf-8-sig', newline='') as arquivo_csv:
        for linha in csv.DictReader(arquivo_csv):
            fontes[Path(linha['arquivo']).name] = linha
    fichas = json.loads(Path(args.rotulos).read_text(encoding='utf-8'))['fotos']

    pasta_c = Path(args.saida) / 'yolo-C'
    if pasta_c.exists(): shutil.rmtree(pasta_c)
    shutil.copytree(args.base, pasta_c)
    antes = len(list((pasta_c / 'images' / 'train').glob('*.jpg')))

    resumo = defaultdict(lambda: {'imagens': 0, 'com_caixa': 0, 'positivos': 0, 'negativos': 0, 'caixas': 0})
    for ficha in sorted(fichas, key=lambda f: f['arquivo']):
        nome = Path(ficha['arquivo']).name
        linha = fontes.get(nome)
        uso = linha['uso (treino ou teste)'].strip() if linha else 'treino'
        if uso != 'treino':
            print('fora do treino (%s): %s' % (uso, nome)); continue
        if not ficha.get('revisada'):
            print('aviso: sem revisao, ignorada:', nome); continue
        imagem = Image.open(Path(args.imagens) / nome).convert('RGB')
        escala = imagem.width / ficha['largura']
        if abs(imagem.height - ficha['altura'] * escala) > 2:
            print('aviso: proporcao dos rotulos diferente da imagem, ignorada:', nome); continue
        caixas = [{'x': c['x'] * escala, 'y': c['y'] * escala, 'w': c['w'] * escala, 'h': c['h'] * escala} for c in ficha['caixas']]
        opcoes = argparse.Namespace(max_lado=args.max_lado)
        positivos, negativos, descartados, _, n_caixas, _ = base_do_conjunto_a.preparar_pintura(nome, imagem, [], imagem.size, caixas, opcoes)
        quantidade = round(len(positivos) * args.negativos) if caixas else args.negativos_por_limpa
        escolhidos = random.sample(negativos, min(len(negativos), quantidade))
        for rec, linhas in positivos + escolhidos:
            base = 'metn_%s_%d_%d' % (Path(nome).stem.replace('met_', ''), rec[0], rec[1])
            base_do_conjunto_a.gravar_recorte(imagem, rec, linhas, pasta_c, 'train', base)
        tecnica = linha['tecnica'].lower() if linha else ''
        grupo = 'tela' if 'canvas' in tecnica else ('madeira' if linha else 'madeira (fora do CSV)')
        r = resumo[grupo]
        r['imagens'] += 1; r['com_caixa'] += bool(caixas); r['positivos'] += len(positivos); r['negativos'] += len(escolhidos)
        r['caixas'] += sum(len(l) for _, l in positivos)
        print('%s (%s): %d caixas, %d recortes com dano, %d sem dano (de %d), %d descartados'
              % (nome, grupo, len(caixas), len(positivos), len(escolhidos), len(negativos), descartados))

    print('\nRESUMO DO MET NOVO (recortes de 640 px que entraram no treino):')
    for grupo, r in sorted(resumo.items()):
        print('  %-22s %2d imagens (%2d com caixa) | %3d recortes com dano (%d caixas) + %3d sem dano'
              % (grupo, r['imagens'], r['com_caixa'], r['positivos'], r['caixas'], r['negativos']))
    quantidades = {c: len(list((pasta_c / 'images' / c).glob('*.jpg'))) for c in ('train', 'val')}
    print('conjunto C: %d recortes de treino (A tinha %d), %d de validacao' % (quantidades['train'], antes, quantidades['val']))
    (pasta_c / 'data.yaml').write_text('path: .\ntrain: images/train\nval: images/val\nnames:\n  0: avaria\n')
    nome_zip = Path(args.saida) / 'yolo-C-pinturas-met.zip'
    with zipfile.ZipFile(nome_zip, 'w', zipfile.ZIP_DEFLATED) as z:
        for arq in sorted(pasta_c.rglob('*')):
            if arq.is_file(): z.write(arq, arq.relative_to(pasta_c))
    print('zip: %s (%.1f MB)' % (nome_zip, nome_zip.stat().st_size / 1048576))


if __name__ == '__main__':
    main()
