# Ferramentas de PDF

Aplicação web estática para **comprimir**, **separar (quebrar)**, **extrair páginas** e **juntar** arquivos PDF,
além de **transformar imagens (JPG, PNG, WebP, GIF, BMP, SVG) em PDF**.
Todo o processamento acontece no navegador do usuário — nenhum arquivo é enviado para servidor algum.

## Comprimir / separar

- Upload por arrastar-e-soltar ou seleção de arquivo.
- Mostra o **tamanho atual** do PDF e o número de páginas.
- **Seleção de páginas**: grade clicável, atalhos (todas / ímpares / pares / limpar) e intervalos digitados (`1-3, 7, 10-12`).
- Dois modos:
  - **Comprimir** — rasteriza as páginas em JPEG otimizado (o layout é preservado; o texto deixa de ser selecionável).
  - **Somente separar** — extrai as páginas escolhidas sem recomprimir, mantendo qualidade e texto originais.
- Quatro níveis de compressão (Leve, Média, Forte e **Máxima**), cada um exibindo o **tamanho estimado do resultado** e a economia em %, calculados a partir de páginas reais do documento.
- Opção de conversão para tons de cinza para reduzir ainda mais o tamanho.
- Barra de progresso e **download do arquivo final** ao terminar.
- Se a compressão não reduzir o tamanho, o arquivo original é mantido.

## Juntar PDFs

- Aba **Juntar PDFs**: selecione ou arraste vários arquivos de uma vez (soltar mais de um arquivo
  na aba de compressão também leva para cá).
- Lista reordenável com ↑ e ↓, remoção individual e botão para adicionar mais arquivos.
- Campo **páginas** por arquivo: use o arquivo inteiro (vazio) ou apenas um trecho (`1-3, 7`).
- Mostra a quantidade de arquivos, o total de páginas do resultado e o tamanho final.
- A junção não recomprime nada: o conteúdo e o texto originais são preservados.
- Botão **Comprimir o resultado** envia o PDF unido direto para a aba de compressão.

## Imagens → PDF

- Aba **Imagens → PDF**: selecione ou arraste JPG, PNG, WebP, GIF, BMP ou SVG — cada imagem vira uma página
  (soltar imagens na aba de compressão também leva para cá).
- Lista com miniatura, dimensões em pixels e tamanho, reordenável com ↑ e ↓ e com remoção individual.
- Opções de montagem: **tamanho da página** (A4, Carta ou do tamanho da imagem a 150 DPI),
  **orientação** (automática por imagem, retrato ou paisagem), **margem** e **qualidade**
  (original sem recompressão, ou JPEG em 85%, 70% e 50%).
- A imagem é centralizada e redimensionada para caber sem distorcer; SVG é rasterizado em alta resolução.
- Botão **Comprimir o resultado** envia o PDF gerado direto para a aba de compressão.

## Como as estimativas são calculadas

Até 3 páginas representativas da seleção são comprimidas de verdade em cada nível; a média por página é
multiplicada pelo número de páginas selecionadas. O tamanho final exibido após a compressão é o real.

## Stack

Site estático (HTML + CSS + JavaScript, sem build), usando:

- [pdf.js](https://mozilla.github.io/pdf.js/) para renderizar as páginas
- [pdf-lib](https://pdf-lib.js.org/) para montar o PDF de saída

## Deploy na Vercel

Não há etapa de build. Importe o repositório na Vercel e use:

- **Framework Preset:** Other
- **Build Command:** (vazio)
- **Output Directory:** (vazio / raiz do projeto)

Ou, com a CLI:

```bash
npx vercel --prod
```

## Rodando localmente

```bash
npx serve .
# ou
python3 -m http.server 3000
```

Depois abra http://localhost:3000.
