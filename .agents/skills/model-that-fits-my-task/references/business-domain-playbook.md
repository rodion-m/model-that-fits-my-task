# Business-domain decision playbook

Read this reference when the workload is professional or organizational rather than a generic chat, coding, or academic task. Apply the benchmark status map named in `SKILL.md` before using any cross-domain coding or agent benchmark. Resolve the current canonical benchmark IDs through `/benchmarks?kind=benchmark&q=<name>`; names below are stable reading labels, not hard-coded IDs.

Default to `competitive` unless the user explicitly asks for maximum quality.
Domain fit establishes the quality floor before workload cost; sparse business
evidence does not justify admitting a cheap general model below that floor.

## Evidence ladder

Use the narrowest evidence that reproduces the work:

1. **Exact workflow:** same deliverable, tools, policy constraints, and domain.
2. **Close domain task:** same professional reasoning, but a different interface or artifact.
3. **Broad occupational work:** useful as a prior when no narrow score exists.
4. **Generic capability:** tools, documents, long context, structured output, or knowledge; supporting evidence only.

Do not blend these tiers into a universal business score. If the snapshot has only an aggregate benchmark score, do not infer a hidden domain split. Benchmark rows often measure a complete `model × harness × tools × effort` system; preserve those conditions and avoid attributing the full result to the base model.

Before using a named benchmark, resolve its canonical entry and count exact comparable observations. A catalog definition without matching model observations is documentation, not ranking evidence. Prefer active/current releases; use archived or saturated benchmarks only as historical coverage anchors and say so explicitly.

## Domain routes

| Workload | Primary evidence | Supporting evidence | What the evidence does not establish |
| --- | --- | --- | --- |
| Broad professional deliverables | [GDPval-AA](https://artificialanalysis.ai/evaluations/gdpval-aa/) for economically valuable artifacts across many occupations; [APEX-Agents](https://www.mercor.com/blog/introducing-apex-agents/) for long-horizon investment-banking, consulting, and legal work; [JobBench](https://job-bench.github.io/) for work experts actually want delegated | AA Briefcase and [original GDPval](https://openai.com/index/gdpval/) rubrics as separately labeled broad professional-work signals | An aggregate score does not identify the best model for one occupation, company process, or application stack; preserve the evaluated system and exact score scale |
| Cross-application business automation | [AutomationBench-AA](https://artificialanalysis.ai/evaluations/automationbench-aa/) for Finance, HR, Marketing, Operations, Sales, and Support workflows across simulated SaaS APIs | [EnterpriseOps-Gym](https://github.com/ServiceNow/EnterpriseOps-Gym) for Calendar, CSM, Drive, Email, HR, ITSM, Teams, and hybrid stateful workflows | Automation success does not prove campaign quality, sales judgment, fair hiring, or policy correctness; compare guardrail-safe score as well as objectives completed |
| Customer service and service operations | [τ³-bench](https://taubench.com/) first, then τ²/τ-bench for the matching retail, airline, telecom, or banking lane; EnterpriseOps-Gym CSM for back-office state changes | AutomationBench Support and generic tool-use evidence | Do not transfer results across domain, release, text/voice/knowledge mode, policy set, user simulator, or tool environment |
| Finance research and analyst work | [Vals Finance Agent v2](https://www.vals.ai/benchmarks/fabv2) for filing-grounded analyst workflows; [FinanceArena](https://www.afterquery.com/leaderboard/finance-arena) only for its exact published FinanceQA lane | Broad APEX/GDPval finance tasks; archived, saturated [CorpFin v2](https://www.vals.ai/benchmarks/corp_fin_v2) only as a historical credit-agreement anchor | Retrieval scores do not establish modeling accuracy; partial-credit scores do not imply a review-ready analyst deliverable |
| Investment banking and financial artifacts | [EMB](https://www.vals.ai/benchmarks/emb) for Excel models; BankerToolBench for end-to-end Excel, PowerPoint, and Word deliverables; APEX-Agents for cross-application banking work | [SpreadsheetBench 2](https://spreadsheetbench.github.io/) and Finance Agent v2 | Hold template versus scratch mode, Excel engine, tools, task budget, formulas, numerical checks, presentation rubric, and source citations constant |
| Tax questions and mortgage-tax documents | [TaxEval v2](https://www.vals.ai/benchmarks/tax_eval_v2) for tax answer correctness and stepwise reasoning; [MortgageTax](https://www.vals.ai/benchmarks/mortgage_tax) for multimodal tax-certificate extraction and calculation | Finance Agent v2 for filing/accounting analysis; SpreadsheetBench 2 for workbook execution | TaxEval is not bookkeeping or audit evidence; MortgageTax is not general mortgage underwriting; pin jurisdiction, tax year, source freshness, image modality, and structured-output parser |
| Legal research | [Vals Legal Research Bench](https://www.vals.ai/benchmarks/legal_research) for tool-using U.S. research with authoritative sources and strict all-pass scoring | [LegalBench](https://legalbench.ai/) for narrower legal-reasoning types; archived, saturated CaseLaw v2 only as a historical Canadian case-law anchor | LegalBench is not end-to-end legal work. Never transfer across jurisdiction, date, practice area, source access, citation rules, or judge |
| Legal matter work and contracting | [Harvey LAB](https://www.harvey.ai/blog/introducing-harveys-legal-agent-benchmark) for client-matter files and reviewable documents, spreadsheets, presentations, and redlines | CorpFin v2 for long credit agreements; APEX-Agents legal tasks | Criterion-pass can be high while strict task resolution is low. Keep public versus held-out set, skills, file tools, internet access, judges, and all-pass metric separate |
| Written clinician support | [HealthBench Professional](https://cdn.openai.com/dd128428-0184-4e25-b155-3a7686c7d744/HealthBench-Professional.pdf) for clinician-facing care consults, writing/documentation, and medical research | HealthBench/Hard for broader health conversations; MedXpertQA as a knowledge anchor; archived MedQA only as historical coverage | Written rubric performance is not diagnosis, treatment safety, procedural competence, regulatory approval, or clinical accountability |
| Healthcare administration | [MedScribe](https://www.vals.ai/benchmarks/medscribe) for SOAP-note generation; [MedCode](https://www.vals.ai/benchmarks/medcode) for ICD-10-CM primary and secondary diagnosis coding | HealthBench Professional writing/documentation split | MedScribe uses synthetic transcripts derived from de-identified notes; MedCode does not cover full billing, payer rules, or claim adjudication. Preserve coding standard, jurisdiction, note template, and human review |
| Education assessment | [Vals SAGE](https://www.vals.ai/benchmarks/sage) for rubric-based grading of handwritten advanced-math work | Document vision/OCR and subject-matter benchmarks | SAGE does not measure tutoring, lesson planning, feedback quality across subjects, admissions, or general educational safety; inspect grading bias and subject split |
| Public benefits and government guidance | [Public Benefits Bench](https://www.vals.ai/benchmarks/public-benefits-bench) for SNAP questions under the matching web-search and multi-turn condition | Current retrieval, citation, and structured-output evidence | It does not cover all benefits or jurisdictions. Policy recency and local procedures are central; a high score never removes the need for grounded state/county sources and escalation |
| Spreadsheets, documents, and presentations | [SpreadsheetBench 2](https://spreadsheetbench.github.io/) for generation, debugging, and visualization in business workbooks; [OfficeQA Pro](https://github.com/databricks/officeqa) for grounded reasoning over office artifacts | GDP.pdf/Chartography for professional PDF and chart understanding; GDPval/APEX for complete deliverables | OfficeQA Pro measures understanding, not artifact creation. Spreadsheet scores are harness- and application-dependent; preserve workbook engine and file-format checks |
| Enterprise IT, SRE, FinOps, and compliance operations | [ITBench](https://github.com/itbench-hub/ITBench) for SRE, CISO, and FinOps scenarios; EnterpriseOps-Gym for ITSM and cross-system workflows | AutomationBench Operations and tool-use benchmarks | ITBench domains are distinct: incident repair, security/compliance assessment, and cost operations must not be averaged into interchangeable competence |
| Defensive detection, SOC, and security compliance | [CTI-REALM](https://www.microsoft.com/en-us/security/blog/2026/03/20/cti-realm-a-new-benchmark-for-end-to-end-detection-rule-generation-with-ai-agents/) for threat-intelligence-to-detection workflows; ITBench CISO for operational compliance/security | CyScenarioBench or CyberGym only when the exact sandboxed defensive task matches | CTF, exploit, fuzzing, and cyber-range results are not evidence of safe production defense, governance, or refusal behavior; keep platform, tools, safeguards, and authorization explicit |
| Vulnerability reproduction and patching | CyberBench for reproducing a published vulnerability, producing a proof of concept, and patching it in its sandboxed setup | CyberGym and repository-level coding evidence | This does not establish secure design review, SOC performance, red-team safety, or production authorization; preserve target, sandbox, tools, verifier, and successful-patch criterion |
| Software modernization and legacy reconstruction | Code Migration or SWE Refactor Bench for source-available migration; [ProgramBench](https://programbench.com/) for black-box behavioral reimplementation; ReverseEngBench for binary reverse engineering | Repository-level coding benchmarks for implementation quality | These are different tasks. Do not use binary/black-box success as a proxy for safe dependency upgrades, or source translation as proof of behavioral equivalence |
| Research and management consulting | APEX-Agents for professional consulting deliverables; BrowseComp/WideResearch for evidence-gathering when browsing is central | GDPval-AA and document/chart benchmarks | Research accuracy does not establish recommendation quality, organizational fit, forecast accuracy, or successful implementation |

## Thin or missing direct coverage

GDPval-AA is not the original OpenAI GDPval run. As of this review, the official
GDPval-AA v2 protocol uses the Stirrup harness and pairwise LLM judging to
produce Elo. Do not call unversioned catalog rows v2 or convert Elo/normalized
index values into a percentage of professional reliability. The published
Fable result includes an Opus 4.8 fallback; without that configuration, a
republished score cannot establish base-model performance. Source-specific
lanes prevent cross-source blending but cannot recover omitted harness,
fallback, judge, or dataset details. See the [current methodology](https://artificialanalysis.ai/evaluations/gdpval-aa/).

The current snapshot has useful operational evidence but no strong dedicated ranking for several decisions. Report these gaps instead of stretching a nearby benchmark:

| Domain | What is available | Required caveat |
| --- | --- | --- |
| Sales strategy and persuasion | AutomationBench Sales; broad GDPval/APEX evidence | Measures workflow execution, not persuasion, account strategy, forecasting, or commercial outcome |
| Marketing strategy and creative performance | AutomationBench Marketing; creative-writing or artifact benchmarks | Measures cross-app operations, not audience fit, brand lift, attribution, or campaign ROI |
| HR and recruiting decisions | EnterpriseOps-Gym HR and AutomationBench HR | Measures process execution, not candidate quality, employment-law compliance, bias, or fair selection |
| Accounting, audit, and controllership | TaxEval, Finance Agent, EMB, SpreadsheetBench 2 | No dedicated audit/opinion, reconciliation, close, or internal-controls benchmark with broad current model coverage |
| Insurance | GDPval occupational aggregate and generic document reasoning | No dedicated underwriting, claims, actuarial, or policy-servicing ranking in the snapshot |
| Procurement and supply chain | GDPval aggregate, AutomationBench Operations, spreadsheet/document evidence | No dedicated sourcing, purchase-order, logistics, inventory, or supplier-risk ranking in the snapshot |
| Negotiation and executive strategy | APEX consulting tasks and broad professional evidence | Agent Poker Bench is game-specific and must not be used as a proxy for negotiation or business strategy |
| General government administration | Public Benefits Bench and broad occupational evidence | SNAP guidance is not evidence for permitting, procurement, case management, or policy analysis |

## Comparison checklist

Before ranking models within a domain, keep these fields comparable:

- exact benchmark release, task split, metric, unit, judge, and strict versus partial success;
- base model versus full agent system, harness, skills, tools, retries, and fallback model;
- reasoning effort, temperature, token/time budget, context packing, and internet/RAG access;
- source-document modality, application or file engine, output format, and verifier;
- jurisdiction, policy or tax year, professional standard, dataset privacy split, and evaluation date;
- task-level latency and spend versus current provider list pricing.

Use a broad benchmark to break a tie only when the narrow evidence is missing or statistically indistinguishable. In high-stakes domains, the final recommendation must state that published benchmark evidence narrows candidates but does not replace organization-specific validation and qualified human review.
