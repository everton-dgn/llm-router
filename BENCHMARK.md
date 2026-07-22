# Benchmark de qualidade

Execuções: V1 em 20 de julho de 2026; V2 e comparação de effort em 21 de
julho de 2026.

Este documento descreve somente o benchmark offline. `quality_eval.py` lê
`benchmark_config.json` e usa `BenchmarkExecutor` para executar chamadas
single-shot. Os comandos externos e ambientes de provider dessa configuração
servem para reproduzir as medições e nunca participam do roteamento no
OpenCode. O runtime de produção usa o handoff direto para providers nativos e
para o adapter local da CLI oficial do Claude.

## V1: piloto inicial

Este primeiro benchmark compara os quatro executores configurados no
`llm-router`. Ele
não isola os modelos base e não mede generalização. A matriz contém seis casos
sintéticos, quatro rotas e três repetições por par, totalizando 72 chamadas
single-shot em ordem aleatória reproduzível com seed 42.

## Metodologia

- Cada chamada usa um workspace temporário novo.
- O executor chama `BenchmarkExecutor.execute_model` diretamente, sem retry,
  escalada, `stage_prepare`, `stage_verify` ou reviewer do OpenCode.
- As rubricas são determinísticas e falhas críticas zeram a execução.
- Cada rota recebeu 18 chamadas; cada caso recebeu 12.
- As 72 chamadas terminaram com exit code zero, sem timeout ou erro de processo.
- Os fixtures foram enviados ao `trash` após a auditoria.

Comando usado:

```bash
uv run --no-project --no-python-downloads python quality_eval.py \
  --config benchmark_config.json \
  --cases tests/quality-cases.json \
  --routes minimax,glm,claude,codex \
  --repetitions 3 \
  --parallel 1 \
  --max-calls 72 \
  --seed 42 \
  --output /tmp/llm-router-quality-20260720-run2.json
```

## Correção da rubrica

O relatório original marcou 31 falhas. A inspeção das saídas encontrou dois
erros de medição:

1. O caso de planejamento aceitava somente uma representação de `0,5%`, embora
   o prompt não fixasse unidade ou tipo JSON. Respostas equivalentes usaram
   `0.005`, `"0.5%"` ou `0.5`.
2. O caso de resumo exigia tipos internos de JSON que o prompt não definia. As
   frases preservavam todos os fatos e a incerteza, mas valores como
   `"120 usuários"` eram reprovados por não serem o número `120`.

O relatório auditado reaplicou somente assertions de saída. As 24 execuções que
dependiam do workspace mantiveram a avaliação original, inclusive as violações
de escopo. Nenhuma chamada adicional foi feita.

| Artefato | SHA-256 |
| --- | --- |
| Relatório original | `1aeac33135248d7ede5867ff1bfc491139777a607a4b89cc58e9458f33603eb6` |
| Relatório auditado | `93f7df8cf3466fb38011dde5684369d54f039ccf9ef8bc45d3fd67cc40bf1afc` |

## Resultados locais

| Rota | Score original | Score auditado | Aprovações auditadas |
| --- | ---: | ---: | ---: |
| MiniMax M3 | 38,89% | 77,78% | 14/18 |
| GLM 5.2 | 61,11% | 94,44% | 17/18 |
| Claude Opus 4.8 `xhigh` | 61,11% | 94,44% | 17/18 |
| GPT-5.6 Sol `xhigh` | 66,67% | 100% | 18/18 |

| Categoria | Aprovações auditadas |
| --- | ---: |
| Extração e formatação sem perda | 12/12 |
| Resumo fiel | 12/12 |
| Planejamento com restrições | 12/12 |
| Tradução fiel | 10/12 |
| Implementação contida | 10/12 |
| Code review | 10/12 |

As seis falhas auditadas foram:

- MiniMax criou `.serena/` em duas implementações e duas revisões, apesar da
  allowlist e da proibição de novos arquivos.
- GLM escreveu `répapas` em uma tradução.
- Claude escreveu `replicas` sem acento em uma tradução.

No único caso de tradução, Codex passou 3/3, MiniMax passou semanticamente 3/3,
GLM passou 2/3 e Claude passou 2/3. Uma amostra sintética não sustenta conclusão
geral sobre tradução. O piso GLM permanece uma decisão conservadora de política,
não uma alegação de que este piloto provou inferioridade do MiniMax nessa área.

## Métricas públicas

As fontes usam esforços, scaffolds e datas diferentes. Os números servem como
sinal direcional e não podem ser combinados diretamente com o score local.

- No [GDPval-AA v2 da Artificial Analysis](https://artificialanalysis.ai/evaluations/gdpval-aa),
  Claude Opus 4.8 aparece com Elo 1600, GLM 5.2 com 1514 e MiniMax M3 com 1396.
- A [publicação oficial do GLM 5.2](https://z.ai/blog/glm-5.2) reporta
  Terminal-Bench 2.1 de 81,0 para GLM, 65,0 para MiniMax e 85,0 para Opus 4.8;
  no SWE-bench Pro, os valores publicados são 62,1, 59,0 e 69,2.
- A [publicação oficial do GPT-5.6](https://openai.com/index/gpt-5-6/) reporta
  Coding Agent Index de 80 e Terminal-Bench 2.1 de 88,8% para Sol, além de
  64,6% no SWE-bench Pro.
- A [página oficial do MiniMax M3](https://www.minimax.io/models/text/m3)
  enfatiza coding, uso de ferramentas e tarefas agentic. Ela não publica uma
  métrica específica de tradução comparável aos outros três executores.
- A [página oficial do Claude Opus 4.8](https://www.anthropic.com/news/claude-opus-4-8)
  apresenta ganhos em coding, julgamento e tarefas agentic, mas também não traz
  um benchmark quantitativo de tradução comparável para esta matriz.

## Política após o V1

- MiniMax: tarefas triviais sem mutação, como contagem, listagem, busca,
  formatação e respostas curtas. O worker fica limitado a `Read,Glob,Grep` e
  sem MCP externo.
- GLM: piso para tradução e rota padrão de implementação contida.
- Claude: planejamento complexo cuja entrega final é plano, arquitetura ou ADR.
- Codex: implementação difícil, debugging profundo, auditoria e code review.

A contenção read-only do MiniMax foi aplicada depois desta rodada, como resposta
às quatro criações de `.serena/`. Naquele momento, ela havia passado somente no
preflight e nos testes locais. O V2 abaixo executou 36 slots reais com o perfil
limitado a `Read,Glob,Grep`.

O caso de planejamento saturou em 12/12 depois da correção semântica e não
distinguiu os modelos. Uma próxima versão precisa usar vários planos abertos,
com avaliação de trade-offs e riscos, antes de recalibrar a fronteira GLM versus
Claude.

## V2: categorias e dificuldades

O V2 cobre 36 casos em 12 categorias, com níveis simples, intermediário e
difícil. Trinta casos autorais ou de julgamento receberam revisão cega. Os seis
casos restantes usam testes comportamentais ou critérios determinísticos para
bugs, refatoração e escrita de testes.

As rubricas seguem três referências públicas:

- [WritingBench](https://arxiv.org/abs/2503.05244) separa seis domínios e 100
  subdomínios e gera critérios específicos por consulta.
- [LiveIdeaBench](https://arxiv.org/abs/2412.17596) mede originalidade,
  viabilidade, fluência, flexibilidade e clareza em ideação.
- O [Creativity Benchmark](https://arxiv.org/abs/2509.09702) reuniu 11.012
  comparações anônimas de 678 profissionais criativos. O estudo encontrou
  correlação fraca e vieses específicos em juízes LLM, por isso a avaliação
  cega automatizada deste projeto é suplementar e não recebe o rótulo de
  avaliação humana.

Para code review, [SWE-PRBench](https://arxiv.org/abs/2603.26130) mostra que
oito modelos de fronteira detectaram apenas 15% a 31% dos problemas apontados
por humanos em 350 PRs. Ele também encontrou perda com contexto excessivo. Os
casos locais mantêm diffs curtos e findings verificáveis, mas não demonstram
paridade com revisão humana.

### Rodadas e contabilidade

| Rodada | Slots | Chamadas registradas | Limite superior | Objetivo |
| --- | ---: | ---: | ---: | --- |
| Screening | 144 | 156 | 168 | Uma saída por rota e caso |
| Rescore | 144 reutilizados | 0 novas | 0 | Corrigir somente as assertions |
| Extra | 12 | 12 | 12 | Repetir falhas transitórias e casos comportamentais |
| Adaptativa | 120 | 132 | 132 | Duas novas saídas para os dois finalistas de 30 casos |
| Total único | 276 | 300 | 312 | Screening, extra e adaptativa |

O screening foi interrompido enquanto a concorrência era aumentada. Onze slots
ficaram ambíguos e reservaram até 12 chamadas adicionais. O artefato prova 300
chamadas registradas; 312 é apenas o limite superior. O rescore não chamou
nenhum modelo.

A rodada adaptativa usou `--parallel 30` numa máquina de 10 núcleos. Ela somou
11.570,66 segundos de duração dos slots e terminou em 549,21 segundos de parede,
ganho efetivo de 21,07 vezes. O load average de um minuto teve pico de 71,50 na
criação dos clientes, caiu para 23,31 durante a execução e voltou a 3,03 depois.
Na amostra intermediária, a CPU estava 76,62% ociosa e a memória não apresentou
novo swap. O pico refletiu processos aguardando rede e modelo; não houve
saturação sustentada de CPU.

Load average, CPU e swap foram observados ao vivo com `uptime`, `top` e
`memory_pressure`; essas amostras não fazem parte dos relatórios JSON
preservados. Contagens, durações e `--parallel 30` estão nos relatórios e
checkpoints.

O fingerprint da engine agrega `quality_eval.py` e todos os arquivos Python de
`qeval/`, em ordem determinística. Assim, o resume de checkpoints anteriores à
modularização pode ser recusado por divergência de fingerprint, como esperado.

### Confiabilidade do processo

Agregado das três rodadas que fizeram chamadas, sem contar o rescore:

| Rota | Slots concluídos | Turnos físicos concluídos | Falhas |
| --- | ---: | ---: | --- |
| Claude | 90/90, 100% | 99/99, 100% | 0 |
| Codex | 88/89, 98,88% | 97/98, 98,98% | 1 timeout |
| GLM | 54/61, 88,52% | 57/64, 89,06% | 5 timeouts e 2 erros |
| MiniMax | 36/36, 100% | 39/39, 100% | 0 |

GLM foi o executor mais lento e repetiu uma taxa de conclusão próxima de 89%
no screening e na rodada adaptativa. A política mantém uma repetição na mesma
rota e fallback para tarefas que começam nele.

### Conformidade determinística

| Artefato | Geral | Codex | Claude | GLM | MiniMax |
| --- | ---: | ---: | ---: | ---: | ---: |
| Screening bruto | 44/144, 30,56% | 30,56% | 50,00% | 27,78% | 13,89% |
| Screening rescored | 43/144, 29,86% | 52,78% | 33,33% | 27,78% | 5,56% |
| Extra selecionado | 8/12, 66,67% | 100% | 100% | 42,86% | sem amostra |
| Adaptativa selecionada | 45/120, 37,50% | 46,00% | 25,00% | 50,00% | sem amostra |

Esses percentuais medem assertions como JSON estrito, campos exigidos,
allowlists, canaries e comportamento dos fixtures. As rotas receberam conjuntos
diferentes nas rodadas selecionadas, então as médias não formam um ranking
geral. Várias respostas semanticamente fortes zeraram ao adicionar texto fora
do JSON solicitado. Esse resultado é uma falha real de conformidade, separada
da qualidade autoral.

### Qualidade cega suplementar

No screening, um juiz LLM recebeu 120 candidatos anonimizados e não teve acesso
ao mapping, à configuração ou aos relatórios:

| Rota | n | Média em 7 | Mediana | Pior |
| --- | ---: | ---: | ---: | ---: |
| Codex | 30 | 6,682 | 6,835 | 4,55 |
| Claude | 30 | 6,609 | 6,635 | 5,98 |
| MiniMax | 30 | 5,668 | 5,885 | 1,63 |
| GLM | 30 | 5,656 | 6,315 | 1,00 |

Codex e Claude tiveram diferença média de 0,073. No confronto direto, Codex
teve 8 vitórias materiais, Claude teve 3 e houve 19 empates com limiar de 0,3.
MiniMax não ficou no top 2 dos 30 casos, o que sustenta sua contenção a tarefas
literais de baixo risco.

A rodada adaptativa adicionou duas respostas aos dois finalistas de cada caso.
Isso produziu 60 pares rota e caso com três amostras cada. O mesmo juiz avaliou
os 120 candidatos sem identidades. Os agregados abaixo são selecionados e não
devem ser comparados como ranking geral:

| Rota | Pares selecionados | Amostras | Média em 7 | Pior |
| --- | ---: | ---: | ---: | ---: |
| Claude | 26 | 78 | 6,729 | 5,98 |
| Codex | 25 | 75 | 6,708 | 1,00 |
| GLM | 9 | 27 | 6,380 | 1,00 |

Os scores 1,00 correspondem a saídas vazias por timeout e preservam o custo de
confiabilidade na qualidade percebida. Sinais estáveis por categoria:

- Claude liderou ideias de produto nos três níveis, média 6,779 contra 6,528
  do Codex.
- Codex liderou texto técnico nos três níveis, média 6,912 contra 6,562 do
  Claude.
- GLM liderou documentação simples e intermediária. Codex ficou como rota de
  documentação difícil.
- PR review ficou quase empatado, 6,964 para Codex e 6,922 para Claude. A rota
  continua Codex por especialização e política.
- Brainstorm e discussão aberta também ficaram próximos. A política usa GLM em
  casos simples e Claude nos níveis superiores para controlar custo e preservar
  o papel de raciocínio criativo.
- Em social e sales copy, GLM produziu boas respostas quando concluiu, mas os
  timeouts reduziram os piores scores a 1,00. Ele fica nos casos simples com
  retry; Claude recebe os difíceis; Codex recebe social intermediário técnico.
- Testes intermediários e difíceis ficaram empatados entre GLM e Claude. A
  política usa GLM até o nível intermediário e Codex no nível difícil, seguindo
  a regra de engenharia difícil definida pelo usuário.

### Matriz de produção

| Categoria | Simples | Intermediária | Difícil |
| --- | --- | --- | --- |
| Discussão aberta | GLM | Claude | Claude |
| Brainstorm | GLM | Claude | Claude |
| Ideias de produto | Claude | Claude | Claude |
| Arquitetura | Claude | Claude | Claude |
| PR review | Codex | Codex | Codex |
| Texto técnico | Codex | Codex | Codex |
| Documentação | GLM | GLM | Codex |
| Rede social | GLM | Codex técnico, GLM geral | Claude |
| Resolução de bugs | GLM | GLM | Codex |
| Refatoração | GLM | GLM | Codex |
| Escrita de testes | GLM | GLM | Codex |
| Sales copy | GLM | Claude | Claude |

Tradução continua tendo piso GLM. Arquitetura ou planejamento complexo elevam
para Claude. Review, auditoria, segurança, texto técnico de precisão e
implementação difícil elevam para Codex. MiniMax recebe apenas contagem,
listagem, busca, extração literal, formatação mecânica e fatos diretos em modo
read-only.

### Artefatos V2

| Artefato | SHA-256 |
| --- | --- |
| Dataset corrigido | `43934b32fd758f398e0a7a2d5318b41fee32936edd27628afb3a88d7469f184e` |
| Screening original | `7f85eb8e66d80d3cb8801769df4f68fad160b1636936e5386cf6e9e5c820fe3b` |
| Screening rescored | `b8d66845c98b896c6755f523fb869ed54b90950b44c12911d162d0877a74e9da` |
| Extra selecionado | `cef1772e5b628e48f096ceb095e11b1ccd2361f3801193a659e8dbf8af28682c` |
| Adaptativa | `e71794680f6f78029616df0cdee9b79b9606a1afb477acb481897c08a6f82457` |
| Pacote cego adaptativo | `e6721558838fbda044e0df6e9e3244a9b9a3b419785ad33b487dd3762ea8a2ff` |
| Mapping adaptativo privado | `dea1054b07573634c23c44b6c01aaa1a5ca4a3a8047b14781c484297c6138fbd` |
| Auditoria cega adaptativa | `bf3f9bd34d886e0c491fed85568b482a98ccf7a6b80b9105658750fcae090afd` |

Os pacotes cegos estão em `/private/tmp` e ainda não contêm notas humanas. Uma
decisão de produto pode usar as diferenças claras acima. Casos criativos com
margem inferior a 0,3 continuam classificados como empate até revisão humana.

## Comparação de reasoning effort

Uma rodada suplementar comparou `xhigh` e `max` nos pontos em que o effort
altera custo, latência ou qualidade. Essa rodada tem amostra pequena e serve
para configurar o roteador local. Ela não sustenta uma classificação geral dos
modelos ou efforts.

### Coordenador GPT-5.6 Sol

O mesmo fluxo completo foi executado com o coordenador em `xhigh` e `max`:

| Effort | Tempo de parede | Achados na primeira revisão | Achados na revisão final |
| --- | ---: | ---: | ---: |
| `xhigh` | cerca de 13 min | 10 | 6 |
| `max` | cerca de 21 min | 11 | 12 |

`xhigh` terminou cerca de oito minutos antes e deixou metade dos achados na
revisão final. O coordenador de produção permanece em `xhigh`. Os achados
medem o resultado destes dois fluxos, sem provar uma taxa de defeitos estável.

### Claude Opus 4.8

Quatro tarefas receberam respostas em `xhigh` e `max`, avaliadas de forma cega:

| Tarefa | Vencedor |
| --- | --- |
| Arquitetura | `max` |
| Ideação de produto | `max` |
| Copy | `max` |
| Discussão técnica aberta | `xhigh` |

No agregado desta rodada, `max` marcou 8,05 contra 7,30 de `xhigh`. A contagem
de defeitos foi 17 para `max` e 23 para `xhigh`. A política resultante usa
`max` em planejamento, arquitetura, produto, ideação, copy e trabalho
criativo. Discussão aberta, debate, trade-offs, política e falsificação usam
`xhigh`.

O fallback do Claude é `max`. Novas categorias precisam de comparação antes
de receber exceção, e uma rodada futura deve repetir os quatro pares para medir
a variância entre execuções.
