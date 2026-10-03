"""
Passo 1 do treino: normaliza as fotos.
Aplica a rotacao do EXIF (celular guarda foto "deitada" com um aviso de rotacao), reduz o lado maior
para 2560 px e salva em JPEG. Todas as fotos ficam na mesma escala de trabalho, que e a escala em que
o modelo vai treinar e depois rodar no celular.

Uso:  python tools/preparar-fotos.py dataset/treino-steelbook dataset/trabalho
"""
import sys
from pathlib import Path
from PIL import Image, ImageOps

LADO_MAIOR = 2560

def main():
    pasta_entrada, pasta_saida = Path(sys.argv[1]), Path(sys.argv[2])
    pasta_saida.mkdir(parents=True, exist_ok=True)
    for caminho in sorted(pasta_entrada.glob('*')):
        if caminho.suffix.lower() not in ('.jpg', '.jpeg', '.png', '.heic'):
            continue
        imagem = ImageOps.exif_transpose(Image.open(caminho)).convert('RGB')
        fator = LADO_MAIOR / max(imagem.size)
        if fator < 1:
            imagem = imagem.resize((round(imagem.width * fator), round(imagem.height * fator)), Image.LANCZOS)
        destino = pasta_saida / (caminho.stem + '.jpg')
        imagem.save(destino, quality=92)
        print(caminho.name, '->', destino.name, imagem.size)

if __name__ == '__main__':
    main()
