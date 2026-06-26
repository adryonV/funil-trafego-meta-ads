# Funil de Tráfego — Meta Ads (dashboard 100% na nuvem)

Dashboard estático publicado no **GitHub Pages** que cruza duas planilhas Google
(métricas de anúncios + lista de compradores), monta o funil completo
**Investimento → Impressões → Cliques → Page Views → Checkouts Initiated → Vendas**
e atribui as vendas à campanha / conjunto / anúncio pelas **UTMs**.

O build roda **100% na nuvem** (GitHub Actions) — não depende de nenhum PC.

## Como funciona

```
cron-job.org  --(POST /dispatches a cada 2h)-->  GitHub Actions
                                                     │
                                  node build.mjs ────┤  lê as 2 planilhas (CSV, somente leitura)
                                  public/data.json ──┤  agrega (sem dados pessoais)
                                                     │
                                  deploy-pages ──────►  GitHub Pages (site público)
```

- **`build.mjs`** — baixa as duas planilhas via export CSV, normaliza as chaves de
  UTM (corrige diferença de espaços), aplica o **imposto ×1,1385** sobre o gasto e
  grava `public/data.json` **agregado** (sem nome/e-mail dos compradores).
- **`public/index.html`** — o dashboard (period selector + comparação vs período
  anterior, funil, cards, gráficos e tabelas de otimização). Lê `data.json?v=<timestamp>`
  (cache-bust) a cada carregamento.
- **`.github/workflows/build.yml`** — roda no `schedule` (a cada 2h, backup),
  no `workflow_dispatch` (botão) e no `repository_dispatch` (disparado pelo cron-job.org).

> **Somente leitura:** o build apenas lê as planilhas pelo endpoint público de exportação. Nunca escreve nelas.

## Imposto

A alíquota fica em **uma linha** no topo do `build.mjs`:

```js
const TAX_RATE = 1.1385;
```

Mude o número e o próximo build recalcula **todas** as métricas de custo
(CPM, CPC, CAC, ROAS, custo por checkout…) com o gasto já com imposto.

## Atualização automática via cron-job.org (a cada 2h)

Crie um cronjob em https://cron-job.org com:

- **URL:** `https://api.github.com/repos/adryonV/funil-trafego-meta-ads/dispatches`
- **Método:** `POST`
- **Schedule:** a cada 2 horas
- **Headers:**
  - `Accept: application/vnd.github+json`
  - `Authorization: Bearer SEU_TOKEN_GITHUB`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `Content-Type: application/json`
- **Body:**
  ```json
  {"event_type":"rebuild"}
  ```

Resposta esperada: **HTTP 204** (sucesso, sem corpo). Em "Settings" do cronjob,
marque para tratar **2xx** como sucesso.

> O token vai **somente** no cron-job.org (campo de header). Ele **não** fica neste
> repositório. O deploy interno usa o `GITHUB_TOKEN` nativo do Actions.

## Privacidade

`data.json` é **agregado** por dia/campanha/conjunto/anúncio e **não** contém
nome, e-mail ou qualquer dado pessoal dos compradores.
