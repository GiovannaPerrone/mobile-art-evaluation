"""
Junta os rotulos das imagens do Met (rotulos-pinturas-extras.json e rotulos-metal.json, exportados pelo
rotular.html com os nomes de download do Met) em dataset/rotulos-extras.json, com os nomes met_<id>.jpg.
Rode de novo sempre que reexportar um dos dois arquivos, e depois rode o gerar-dataset-pinturas.py.
"""
import json
from pathlib import Path

NOMES = {
    'DP-32259-001.jpg': 'met_37614.jpg', 'DP244667_CRD.jpg': 'met_45428.jpg', 'main-image (1).jpg': 'met_471905.jpg',
    'main-image (10).jpg': 'met_39569.jpg', 'main-image (3).jpg': 'met_436280.jpg', 'main-image (4).jpg': 'met_437243.jpg',
    'main-image (5).jpg': 'met_436429.jpg', 'main-image (6).jpg': 'met_435762.jpg', 'main-image (7).jpg': 'met_437236.jpg',
    'main-image (8).jpg': 'met_436514.jpg', 'main-image (2).jpg': 'met_49568.jpg', 'main-image (9).jpg': 'met_53779.jpg',
    'main-image.jpg': 'met_27651.jpg',
}

def main():
    saida = {'versao': 2, 'fotos': []}
    for arquivo in ('dataset/rotulos-pinturas-extras.json', 'dataset/rotulos-metal.json'):
        dados = json.loads(Path(arquivo).read_text(encoding='utf-8'))
        for foto in dados['fotos']:
            foto['arquivo'] = NOMES.get(foto['arquivo'], foto['arquivo'])
            saida['fotos'].append(foto)
            print(foto['arquivo'], len(foto['caixas']), 'caixas')
        saida.setdefault('classes', dados.get('classes'))
    Path('dataset/rotulos-extras.json').write_text(json.dumps(saida, ensure_ascii=False, indent=1), encoding='utf-8')

if __name__ == '__main__':
    main()
