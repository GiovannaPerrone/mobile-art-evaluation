"""
Olha o dataset ARTeFACT (Hugging Face: danielaivanova/damaged-media) SEM baixar as imagens: mostra licenca, arquivos e
tamanhos, o cartao (README) e a contagem das colunas de texto/numero (materiais, classes etc.).
Uso (no seu Windows, com internet):
    pip install huggingface_hub pyarrow
    python tools/ver-artefact.py > dataset/artefact-info.txt
Depois me avise; eu leio o dataset/artefact-info.txt.
"""
from collections import Counter
REPO = 'danielaivanova/damaged-media'


def main():
    from huggingface_hub import HfApi, HfFileSystem, hf_hub_download
    import pyarrow as pa, pyarrow.parquet as pq
    api = HfApi()
    info = api.dataset_info(REPO, files_metadata=True)
    print('== DADOS DO REPOSITORIO ==')
    print('licenca/tags:', getattr(info, 'tags', None))
    print('cardData:', getattr(info, 'card_data', None))
    print('\n== ARQUIVOS (MB) ==')
    parquets = []
    for s in info.siblings:
        print('%8.1f  %s' % ((s.size or 0) / 1048576, s.rfilename))
        if s.rfilename.endswith('.parquet'): parquets.append(s.rfilename)
    print('\n== README ==')
    try: print(open(hf_hub_download(REPO, 'README.md', repo_type='dataset'), encoding='utf-8').read()[:6000])
    except Exception as e: print('sem README:', e)
    fs = HfFileSystem()
    print('\n== COLUNAS E CONTAGENS ==')
    for nome in parquets:
        print('\n--', nome)
        pf = pq.ParquetFile(fs.open('datasets/%s/%s' % (REPO, nome)))
        esquema = pf.schema_arrow
        print('linhas:', pf.metadata.num_rows)
        for campo in esquema: print('  coluna:', campo.name, '|', campo.type)
        leves = [c.name for c in esquema if pa.types.is_string(c.type) or pa.types.is_integer(c.type) or pa.types.is_floating(c.type) or pa.types.is_boolean(c.type)
                 or (pa.types.is_list(c.type) and (pa.types.is_string(c.type.value_type) or pa.types.is_integer(c.type.value_type)))]
        if leves:
            tabela = pf.read(columns=leves).to_pydict()
            for col in leves:
                vals = tabela[col]
                try: cont = Counter(str(v) if not isinstance(v, list) else ','.join(map(str, v)) for v in vals)
                except Exception: continue
                print('  contagem de', col, '(%d valores distintos):' % len(cont), cont.most_common(25))


if __name__ == '__main__':
    main()
