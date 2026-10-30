'use strict';
// Module guidelines.js: reporting-guideline coverage (the tool guideline_coverage, Auto with the Docs API). The panel,
// not the model, runs it: the items go in batches of GL_BATCH to quiet document passes (mode 'coverage', registered into
// the document-pass tables of constants.js and prompts.js at load: no chat history, the document inline when it fits,
// else the outline and the reading tools), each answering per item covered / partly / missing with a quote and its line;
// the quotes are verified against the document, and the results go into one Docs table (Item, Topic, Status, Where,
// Note) after a line or at the end, with a caption line under it, as one undoable edit (journal kind 'coverage').
// Coverage says nothing about quality; the caption says so.
//
// The item lists are short paraphrases (the item number and at most 12 words of our own), not the checklists' wording.
// Sources and licences (checked on the official sites and the publishing journals):
// - CONSORT 2010 (randomised trials): Schulz KF, Altman DG, Moher D, for the CONSORT Group. CONSORT 2010 Statement.
//   Trials 2010;11:32, doi:10.1186/1745-6215-11-32, CC BY 2.0. (The site's own files may not be modified; the list
//   paraphrases the CC BY article. CONSORT 2025 has since replaced it.)
// - PRISMA 2020 (systematic reviews): Page MJ, McKenzie JE, Bossuyt PM, et al. BMJ 2021;372:n71,
//   doi:10.1136/bmj.n71, CC BY 4.0.
// - STROBE (observational studies): von Elm E, Altman DG, Egger M, et al. PLoS Med 2007;4(10):e296,
//   doi:10.1371/journal.pmed.0040296, CC BY. (The STROBE site asks to be contacted before its material is republished.)
// - ARRIVE 2.0 (animal research): Percie du Sert N, Hurst V, Ahluwalia A, et al. PLoS Biol 2020;18(7):e3000410,
//   doi:10.1371/journal.pbio.3000410, CC0.
// - TRIPOD+AI (prediction models): Collins GS, Moons KGM, Dhiman P, et al. BMJ 2024;385:e078378,
//   doi:10.1136/bmj-2023-078378, CC BY 4.0.
// - CARE (case reports): the checklist is © IMI LLC (care-statement.org: copying for information allowed, no commercial
//   use, all other rights reserved), so its licence for redistribution is unclear: only the item numbers and topic
//   words, with the link; the tool result says so.
// The attributions are repeated in vendor/NOTICES.txt.
/* global apiEditing, buildTurnContext, DOC_PASS_HEADS, DOC_PASS_MODES, DOC_PASS_TASKS, docsBatchUpdate, fetchDocModel, finishEdit,
   commitSequence, gateEdit, lineAtIndex, planInsertTable, registerTools, registerUndoHandler, reqDelete, reqInsert, setStatus,
   tableAt, tableSignature, TABLE_LIMITS, toolLoop, writeError */
/* exported GUIDELINES, GL_BATCH, glAsked, guidelineBatches, parseCoverage, coverageRows, runGuidelineCoverage, undoCoverage, COVERAGE_TASK */

const GL_BATCH = 8; // items per request
const GL_QUOTE_WORDS = 20;
const GL_TABLE_LIMITS = { ...TABLE_LIMITS, rows: 60, gateCells: Infinity }; // the panel's own table: up to 59 items

// form: 'paraphrase' (items [id, topic, paraphrase]) or 'topics' (items [id, topic]: the licence is unclear).
const GUIDELINES = {
  CONSORT: {
    name: 'CONSORT 2010', scope: 'randomised trials', form: 'paraphrase', url: 'https://www.consort-spirit.org/',
    source: 'Schulz, Altman, Moher. CONSORT 2010 Statement. Trials 2010;11:32', licence: 'CC BY 2.0',
    items: [
      ['1a', 'Title', 'identified as a randomised trial in the title'],
      ['1b', 'Abstract', 'structured summary of design, methods, results and conclusions'],
      ['2a', 'Background', 'scientific background and rationale explained'],
      ['2b', 'Objectives', 'specific objectives or hypotheses'],
      ['3a', 'Trial design', 'design described, including the allocation ratio'],
      ['3b', 'Trial design', 'important method changes after the start, with reasons'],
      ['4a', 'Participants', 'eligibility criteria for participants'],
      ['4b', 'Participants', 'settings and locations where the data were collected'],
      ['5', 'Interventions', 'each group’s interventions in replicable detail, with timing'],
      ['6a', 'Outcomes', 'prespecified primary and secondary outcomes fully defined, with timing'],
      ['6b', 'Outcomes', 'changes to the outcomes after the trial began, with reasons'],
      ['7a', 'Sample size', 'how the sample size was determined'],
      ['7b', 'Sample size', 'interim analyses and stopping rules, if any'],
      ['8a', 'Randomisation', 'method used to generate the allocation sequence'],
      ['8b', 'Randomisation', 'type of randomisation and any restriction such as blocking'],
      ['9', 'Allocation concealment', 'mechanism and steps used to conceal the sequence'],
      ['10', 'Implementation', 'who generated the sequence, enrolled and assigned participants'],
      ['11a', 'Blinding', 'who was blinded after assignment, and how'],
      ['11b', 'Blinding', 'similarity of the interventions, if relevant'],
      ['12a', 'Statistical methods', 'methods comparing groups on primary and secondary outcomes'],
      ['12b', 'Statistical methods', 'methods of additional analyses such as subgroup or adjusted'],
      ['13a', 'Participant flow', 'numbers randomised, treated and analysed per group (a diagram)'],
      ['13b', 'Participant flow', 'losses and exclusions after randomisation, with reasons'],
      ['14a', 'Recruitment', 'dates of recruitment and follow-up'],
      ['14b', 'Recruitment', 'why the trial ended or was stopped'],
      ['15', 'Baseline data', 'baseline characteristics of each group, usually a table'],
      ['16', 'Numbers analysed', 'number analysed per group, by the groups as assigned'],
      ['17a', 'Outcomes and estimation', 'per-group results with effect size and its precision'],
      ['17b', 'Outcomes and estimation', 'absolute and relative effect sizes for binary outcomes'],
      ['18', 'Ancillary analyses', 'other analyses, marked as prespecified or exploratory'],
      ['19', 'Harms', 'all important harms or unintended effects per group'],
      ['20', 'Limitations', 'limitations, sources of bias, imprecision and multiplicity'],
      ['21', 'Generalisability', 'external validity and applicability of the findings'],
      ['22', 'Interpretation', 'interpretation consistent with results, weighing benefits and harms'],
      ['23', 'Registration', 'registration number and name of the trial registry'],
      ['24', 'Protocol', 'where the full trial protocol can be accessed'],
      ['25', 'Funding', 'sources of funding and other support; the funders’ role'],
    ],
  },
  PRISMA: {
    name: 'PRISMA 2020', scope: 'systematic reviews', form: 'paraphrase', url: 'https://www.prisma-statement.org/',
    source: 'Page et al. The PRISMA 2020 statement. BMJ 2021;372:n71', licence: 'CC BY 4.0',
    items: [
      ['1', 'Title', 'identified as a systematic review'],
      ['2', 'Abstract', 'structured abstract (PRISMA for Abstracts)'],
      ['3', 'Rationale', 'rationale in the context of existing knowledge'],
      ['4', 'Objectives', 'explicit objectives or questions the review addresses'],
      ['5', 'Eligibility criteria', 'inclusion and exclusion criteria; how studies were grouped'],
      ['6', 'Information sources', 'all databases, registers and other sources searched, with dates'],
      ['7', 'Search strategy', 'full search strategies, including filters and limits'],
      ['8', 'Selection process', 'how studies were screened, by how many reviewers, any automation'],
      ['9', 'Data collection process', 'how data were collected and confirmed, any automation'],
      ['10a', 'Data items', 'outcomes sought and which results were collected'],
      ['10b', 'Data items', 'other variables sought, such as participants, interventions, funding'],
      ['11', 'Study risk of bias', 'methods and tools for assessing risk of bias'],
      ['12', 'Effect measures', 'effect measures used for each outcome'],
      ['13a', 'Synthesis methods', 'how studies were chosen for each synthesis'],
      ['13b', 'Synthesis methods', 'data preparation, such as missing statistics or conversions'],
      ['13c', 'Synthesis methods', 'methods to tabulate or display results'],
      ['13d', 'Synthesis methods', 'synthesis methods with rationale, models and heterogeneity'],
      ['13e', 'Synthesis methods', 'methods to explore causes of heterogeneity'],
      ['13f', 'Synthesis methods', 'sensitivity analyses of the synthesis'],
      ['14', 'Reporting bias assessment', 'methods for bias from missing results'],
      ['15', 'Certainty assessment', 'methods for assessing certainty of the evidence'],
      ['16a', 'Study selection', 'search and selection results, ideally a flow diagram'],
      ['16b', 'Study selection', 'seemingly eligible studies that were excluded, with reasons'],
      ['17', 'Study characteristics', 'each included study cited, with its characteristics'],
      ['18', 'Risk of bias in studies', 'risk-of-bias assessment for each included study'],
      ['19', 'Results of individual studies', 'per-study summary statistics and effect estimates'],
      ['20a', 'Results of syntheses', 'characteristics and risk of bias of contributing studies'],
      ['20b', 'Results of syntheses', 'each synthesis with precision and heterogeneity'],
      ['20c', 'Results of syntheses', 'results of investigations of heterogeneity'],
      ['20d', 'Results of syntheses', 'results of sensitivity analyses'],
      ['21', 'Reporting biases', 'assessments of bias from missing results'],
      ['22', 'Certainty of evidence', 'certainty of the evidence for each outcome'],
      ['23a', 'Discussion', 'results interpreted in the context of other evidence'],
      ['23b', 'Discussion', 'limitations of the included evidence'],
      ['23c', 'Discussion', 'limitations of the review processes'],
      ['23d', 'Discussion', 'implications for practice, policy and future research'],
      ['24a', 'Registration and protocol', 'registration name and number, or that it was not registered'],
      ['24b', 'Registration and protocol', 'where the protocol can be accessed, or that none exists'],
      ['24c', 'Registration and protocol', 'amendments to the registration or protocol'],
      ['25', 'Support', 'sources of support and the funders’ role'],
      ['26', 'Competing interests', 'competing interests of the review authors'],
      ['27', 'Availability of data and code', 'which data, code and materials are public, and where'],
    ],
  },
  STROBE: {
    name: 'STROBE', scope: 'observational studies', form: 'paraphrase', url: 'https://www.strobe-statement.org/',
    source: 'von Elm et al. The STROBE statement. PLoS Med 2007;4(10):e296', licence: 'CC BY',
    items: [
      ['1a', 'Title and abstract', 'design named with a common term in the title or abstract'],
      ['1b', 'Title and abstract', 'informative, balanced summary of what was done and found'],
      ['2', 'Background', 'scientific background and reasons for the study'],
      ['3', 'Objectives', 'specific objectives, including prespecified hypotheses'],
      ['4', 'Study design', 'key elements of the design, early in the paper'],
      ['5', 'Setting', 'setting, locations and dates of recruitment, exposure, follow-up, data collection'],
      ['6a', 'Participants', 'eligibility, sources and selection of participants; follow-up methods'],
      ['6b', 'Participants', 'matching criteria and numbers matched, if matched'],
      ['7', 'Variables', 'outcomes, exposures, predictors, confounders and effect modifiers defined'],
      ['8', 'Data sources and measurement', 'sources and assessment methods for each variable; comparability'],
      ['9', 'Bias', 'efforts to address potential sources of bias'],
      ['10', 'Study size', 'how the study size was arrived at'],
      ['11', 'Quantitative variables', 'how quantitative variables were handled and grouped'],
      ['12a', 'Statistical methods', 'all statistical methods, including control of confounding'],
      ['12b', 'Statistical methods', 'methods for subgroups and interactions'],
      ['12c', 'Statistical methods', 'how missing data were addressed'],
      ['12d', 'Statistical methods', 'how loss to follow-up, matching or sampling was handled'],
      ['12e', 'Statistical methods', 'sensitivity analyses'],
      ['13a', 'Participants', 'numbers of individuals at each stage of the study'],
      ['13b', 'Participants', 'reasons for non-participation at each stage'],
      ['13c', 'Participants', 'a flow diagram, considered'],
      ['14a', 'Descriptive data', 'participant characteristics, exposures and potential confounders'],
      ['14b', 'Descriptive data', 'number with missing data for each variable'],
      ['14c', 'Descriptive data', 'follow-up time summarised (cohort studies)'],
      ['15', 'Outcome data', 'numbers of outcome events or summary measures'],
      ['16a', 'Main results', 'unadjusted and adjusted estimates with precision; confounders named'],
      ['16b', 'Main results', 'category boundaries when continuous variables were categorised'],
      ['16c', 'Main results', 'relative risk translated into absolute risk, if relevant'],
      ['17', 'Other analyses', 'subgroup, interaction and sensitivity analyses'],
      ['18', 'Key results', 'key results summarised with reference to the objectives'],
      ['19', 'Limitations', 'limitations, bias and imprecision, with their direction and size'],
      ['20', 'Interpretation', 'cautious interpretation weighing objectives, limitations and other evidence'],
      ['21', 'Generalisability', 'external validity of the results'],
      ['22', 'Funding', 'source of funding and the funders’ role'],
    ],
  },
  ARRIVE: {
    name: 'ARRIVE 2.0', scope: 'animal research', form: 'paraphrase', url: 'https://arriveguidelines.org/',
    source: 'Percie du Sert et al. The ARRIVE guidelines 2.0. PLoS Biol 2020;18(7):e3000410', licence: 'CC0',
    items: [
      ['1a', 'Study design', 'groups compared, including controls; rationale if there are none'],
      ['1b', 'Study design', 'the experimental unit, such as an animal, litter or cage'],
      ['2a', 'Sample size', 'exact number of experimental units per group and in total'],
      ['2b', 'Sample size', 'how the sample size was decided, with any calculation'],
      ['3a', 'Inclusion and exclusion criteria', 'criteria set before the study'],
      ['3b', 'Inclusion and exclusion criteria', 'animals, units or data excluded, with reasons'],
      ['3c', 'Inclusion and exclusion criteria', 'exact number in each analysis per group'],
      ['4a', 'Randomisation', 'whether and how units were randomly allocated'],
      ['4b', 'Randomisation', 'how confounders such as order or cage location were minimised'],
      ['5', 'Blinding', 'who knew the group allocation at each stage'],
      ['6a', 'Outcome measures', 'every outcome measure assessed, clearly defined'],
      ['6b', 'Outcome measures', 'the primary outcome, for hypothesis-testing studies'],
      ['7a', 'Statistical methods', 'methods and software for each analysis'],
      ['7b', 'Statistical methods', 'how assumptions were checked; alternatives if they failed'],
      ['8a', 'Experimental animals', 'species, strain, sex, age or stage, and weight'],
      ['8b', 'Experimental animals', 'source, health status, genetic modification, earlier procedures'],
      ['9a', 'Experimental procedures', 'what was done, how, and with what, for each group'],
      ['9b', 'Experimental procedures', 'when and how often the procedures were done'],
      ['9c', 'Experimental procedures', 'where, including acclimatisation periods'],
      ['9d', 'Experimental procedures', 'why: the rationale for the procedures'],
      ['10a', 'Results', 'descriptive statistics per group with a measure of variability'],
      ['10b', 'Results', 'effect size with a confidence interval, where applicable'],
      ['11', 'Abstract', 'accurate summary of objectives, animals, methods, findings and conclusions'],
      ['12a', 'Background', 'scientific background and relevance to the field'],
      ['12b', 'Background', 'why the species and model were chosen; relevance to humans'],
      ['13', 'Objectives', 'research questions, objectives and hypotheses'],
      ['14', 'Ethical statement', 'ethics review body and approval or licence numbers'],
      ['15', 'Housing and husbandry', 'housing conditions and environmental enrichment'],
      ['16a', 'Animal care and monitoring', 'care, monitoring and steps to reduce pain or distress'],
      ['16b', 'Animal care and monitoring', 'expected or unexpected adverse events'],
      ['16c', 'Animal care and monitoring', 'humane endpoints and how often they were checked'],
      ['17a', 'Interpretation', 'results interpreted against the objectives, theory and literature'],
      ['17b', 'Interpretation', 'limitations: bias, limits of the animal model, imprecision'],
      ['18', 'Generalisability and translation', 'relevance to other species or to humans'],
      ['19', 'Protocol registration', 'whether a protocol was prepared or registered, and where'],
      ['20', 'Data access', 'where the study data can be accessed'],
      ['21a', 'Declaration of interests', 'conflicts of interest, or that there are none'],
      ['21b', 'Declaration of interests', 'funding sources and the funders’ role'],
    ],
  },
  CARE: {
    name: 'CARE', scope: 'case reports', form: 'topics', url: 'https://www.care-statement.org/checklist',
    source: 'Gagnier et al. The CARE guidelines (2013), care-statement.org', licence: 'not stated for redistribution (© IMI LLC)',
    items: [
      ['1', 'Title'], ['2', 'Key words'], ['3', 'Abstract'], ['4', 'Introduction'], ['5', 'Patient information'], ['6', 'Clinical findings'],
      ['7', 'Timeline'], ['8', 'Diagnostic assessment'], ['9', 'Therapeutic intervention'], ['10', 'Follow-up and outcomes'],
      ['11', 'Discussion'], ['12', 'Patient perspective'], ['13', 'Informed consent'],
    ],
  },
  'TRIPOD+AI': {
    name: 'TRIPOD+AI', scope: 'prediction models', form: 'paraphrase', url: 'https://www.tripod-statement.org/',
    source: 'Collins et al. TRIPOD+AI statement. BMJ 2024;385:e078378', licence: 'CC BY 4.0',
    items: [
      ['1', 'Title', 'study develops or evaluates a prediction model; population and outcome'],
      ['2', 'Abstract', 'abstract following TRIPOD+AI for Abstracts'],
      ['3a', 'Background', 'healthcare context and rationale; references to existing models'],
      ['3b', 'Background', 'target population, intended purpose and users in the care pathway'],
      ['3c', 'Background', 'known health inequalities between sociodemographic groups'],
      ['4', 'Objectives', 'objectives: development, validation, or both'],
      ['5a', 'Data', 'data sources for development and evaluation; rationale and representativeness'],
      ['5b', 'Data', 'dates of participant data: accrual start and end, follow-up end'],
      ['6a', 'Participants', 'study setting, number and location of centres'],
      ['6b', 'Participants', 'eligibility criteria for participants'],
      ['6c', 'Participants', 'treatments received and how they were handled'],
      ['7', 'Data preparation', 'pre-processing and quality checks, across sociodemographic groups'],
      ['8a', 'Outcome', 'outcome and time horizon defined; how, when, and why chosen'],
      ['8b', 'Outcome', 'qualifications and demographics of outcome assessors, if subjective'],
      ['8c', 'Outcome', 'blinding of the outcome assessment'],
      ['9a', 'Predictors', 'choice of initial predictors and any pre-selection'],
      ['9b', 'Predictors', 'all predictors defined: how and when measured, blinding'],
      ['9c', 'Predictors', 'qualifications and demographics of predictor assessors, if subjective'],
      ['10', 'Sample size', 'how the study size was reached and why it suffices'],
      ['11', 'Missing data', 'how missing data were handled, reasons for omitted data'],
      ['12a', 'Analytical methods', 'how data were used and partitioned for development and evaluation'],
      ['12b', 'Analytical methods', 'how predictors were handled: functional form, rescaling, transformation'],
      ['12c', 'Analytical methods', 'model type and rationale, building steps, tuning, internal validation'],
      ['12d', 'Analytical methods', 'heterogeneity across clusters such as hospitals or countries'],
      ['12e', 'Analytical methods', 'performance measures and plots, with rationale; model comparisons'],
      ['12f', 'Analytical methods', 'model updating such as recalibration after evaluation'],
      ['12g', 'Analytical methods', 'how predictions were calculated during evaluation'],
      ['13', 'Class imbalance', 'class-imbalance methods, why, and any recalibration'],
      ['14', 'Fairness', 'approaches used to address model fairness, with rationale'],
      ['15', 'Model output', 'model output; classification thresholds and how they were set'],
      ['16', 'Training versus evaluation', 'differences between development and evaluation data'],
      ['17', 'Ethical approval', 'ethics committee approval and informed consent or its waiver'],
      ['18a', 'Funding', 'funding sources and the funders’ role'],
      ['18b', 'Conflicts of interest', 'conflicts of interest and financial disclosures of all authors'],
      ['18c', 'Protocol', 'where the protocol can be accessed, or that none was prepared'],
      ['18d', 'Registration', 'registry name and number, or that it was not registered'],
      ['18e', 'Data sharing', 'availability of the study data'],
      ['18f', 'Code sharing', 'availability of the analytical code'],
      ['19', 'Patient and public involvement', 'patient and public involvement, or that there was none'],
      ['20a', 'Participants', 'participant flow, numbers with and without the outcome, follow-up'],
      ['20b', 'Participants', 'characteristics per data source, missing data, demographic differences'],
      ['20c', 'Participants', 'evaluation data compared with development data on key variables'],
      ['21', 'Model development', 'participants and outcome events in each analysis'],
      ['22', 'Model specification', 'full model details for new predictions; access restrictions'],
      ['23a', 'Model performance', 'performance estimates with confidence intervals, including key subgroups'],
      ['23b', 'Model performance', 'heterogeneity in performance across clusters, if examined'],
      ['24', 'Model updating', 'results of any model updating and the updated performance'],
      ['25', 'Interpretation', 'overall interpretation, including fairness, against objectives and other studies'],
      ['26', 'Limitations', 'limitations and their effects on bias, uncertainty and generalisability'],
      ['27a', 'Usability', 'how poor or missing input data should be handled in use'],
      ['27b', 'Usability', 'whether users interact with inputs, and the expertise needed'],
      ['27c', 'Usability', 'next steps for research on applicability and generalisability'],
    ],
  },
};
const GL_NAMES = Object.keys(GUIDELINES);

// ---- The document pass ----------------------------------------------------------------------------------------------
// Registered into the document-pass tables at load (request.js reads them at run time), so the pass gets the same
// request path as /review and the paper card: no chat history, the document inline when it fits.
const COVERAGE_HEAD = 'You check whether a document the user writes in Google Docs reports the items of a reporting guideline. You see only the document and the task. You cannot edit the document. Answer with the JSON the task asks for, nothing else.';
const COVERAGE_TASK = `Coverage task. For each checklist item in the message below, decide whether the document reports it: "covered" (fully), "partly" (some of it) or "missing". For covered and partly give "line" (its line number) and "quote" (at most ${GL_QUOTE_WORDS} words copied exactly from that line). "note": at most 15 words, what is missing or where. Judge only whether the information is there, not its quality. Answer with JSON only:
{"items":[{"id":"1a","status":"covered","line":3,"quote":"exact words","note":""}]}`;
if (!DOC_PASS_MODES.includes('coverage')) DOC_PASS_MODES.push('coverage');
DOC_PASS_HEADS.coverage = COVERAGE_HEAD;
DOC_PASS_TASKS.coverage = COVERAGE_TASK;

// The items in batches of GL_BATCH.
function guidelineBatches(g) {
  const out = [];
  for (let i = 0; i < g.items.length; i += GL_BATCH) out.push(g.items.slice(i, i + GL_BATCH));
  return out;
}
const itemLine = (g, it) => (g.form === 'topics' ? `${it[0]} ${it[1]}` : `${it[0]} ${it[1]}: ${it[2]}`);
const batchMessage = (g, batch) => `Guideline: ${g.name} (${g.scope}).${g.form === 'topics' ? ' Only the item topics are given; judge by the usual content of such a section.' : ''} Items:\n${batch.map((it) => itemLine(g, it)).join('\n')}`;

// ---- Parsing and verifying ------------------------------------------------------------------------------------------
const GL_STATUS = { covered: 'Covered', partly: 'Partly', partial: 'Partly', missing: 'Missing' };
const glNorm = (t) => String(t || '').toLowerCase().replace(/[“”«»"„]/g, '"').replace(/[‘’]/g, "'").replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();
const glWords = (t, n) => { const w = String(t || '').replace(/\s+/g, ' ').trim().split(' '); return w.length > n ? w.slice(0, n).join(' ') + '…' : w.join(' '); };
// The answer of one batch: Map id -> { status, line, quote, note } (only ids of the batch; unparseable answers give an empty map).
function parseCoverage(text, batch) {
  const out = new Map();
  const s = String(text || '');
  const from = s.indexOf('{');
  const to = s.lastIndexOf('}');
  if (from < 0 || to <= from) return out;
  let data;
  try { data = JSON.parse(s.slice(from, to + 1)); } catch (e) { return out; }
  const ids = new Map(batch.map((it) => [String(it[0]).toLowerCase(), it[0]]));
  for (const x of Array.isArray(data && data.items) ? data.items : []) {
    const id = ids.get(String((x && x.id) || '').toLowerCase().replace(/^item\s*/, ''));
    const status = GL_STATUS[String((x && x.status) || '').toLowerCase().trim()];
    if (!id || !status || out.has(id)) continue;
    const line = Number(x.line);
    out.set(id, { status, line: Number.isInteger(line) && line > 0 ? line : null, quote: typeof x.quote === 'string' ? x.quote.trim() : '', note: typeof x.note === 'string' ? x.note.trim() : '' });
  }
  return out;
}
// A quote checked against the lines of the document (lines[i]: line i + 1): the line it is on (the given one first), or 0.
function quoteLine(lines, quote, line) {
  const q = glNorm(quote).replace(/…$/, '').replace(/^"|"$/g, '').trim();
  if (q.length < 4) return 0;
  if (line && lines[line - 1] != null && glNorm(lines[line - 1]).includes(q)) return line;
  const at = lines.findIndex((l) => glNorm(l).includes(q));
  return at + 1;
}

// The table rows (header first) and the counts, from the per-item results (Map id -> result) and the document lines.
function coverageRows(g, results, lines) {
  const n = { Covered: 0, Partly: 0, Missing: 0, 'Not checked': 0 };
  const rows = [['Item', 'Topic', 'Status', 'Where (line)', 'Note']];
  for (const it of g.items) {
    const r = results.get(it[0]);
    if (!r) { n['Not checked']++; rows.push([it[0], it[1], 'Not checked', '', 'No answer for this item.']); continue; }
    n[r.status]++;
    let where = '';
    let note = r.note;
    if (r.status !== 'Missing') {
      const at = r.quote ? quoteLine(lines, r.quote, r.line) : 0;
      if (at) { where = String(at); note = `«${glWords(r.quote, GL_QUOTE_WORDS)}»${note ? ' ' + note : ''}`; } else note = `Quote not found in the document.${note ? ' ' + note : ''}`;
    }
    rows.push([it[0], it[1], r.status, where, note.slice(0, 300)]);
  }
  return { rows, n };
}
const countsText = (n, total) => `${n.Covered} of ${total} items covered` + (n.Partly ? `, ${n.Partly} partly` : '') + (n.Missing ? `, ${n.Missing} missing` : '') +
  (n['Not checked'] ? `, ${n['Not checked']} not checked` : '');
const captionText = (g, n) => `${g.name} coverage (${g.scope}): ${countsText(n, g.items.length)}. Coverage shows only whether an item is reported, not how well. Checklist: ${g.source} (${g.licence})${g.form === 'topics' ? `; item topics only, full items at ${g.url}` : ''}.`;

// ---- The table edit ---------------------------------------------------------------------------------------------------
// The table after line n with its caption in the empty paragraph Docs leaves under it: the table tool's insert plan plus
// a third batch for the caption; journal kind 'coverage' (undo: the table and the caption go together).
function planCoverageTable(model, line, rows, caption, title) {
  const plan = planInsertTable(model, { line, rows: rows.length, columns: rows[0].length }, rows, GL_TABLE_LIMITS);
  if (plan.error) return plan;
  const start = (line === 0 ? model.lines[0].start : model.lines[line - 1].end) + 1;
  plan.steps.push((m) => {
    const t = tableAt(m, start);
    if (!t) throw new Error('the new table was not found after filling it');
    return { requests: [reqInsert(m, t.end, caption)] };
  });
  const where = line === 0 ? 'at the beginning' : `after line ${line}`;
  Object.assign(plan, {
    title: `Inserted the ${title} coverage table ${where}`, cardText: caption, cardLabel: 'Caption',
    gate: { large: false, what: `inserts the ${title} coverage table (${rows.length - 1} items)`, range: line === 0 ? 'At the beginning' : `After line ${line}`, excerptLabel: 'Caption', excerpt: caption },
    journal: { kind: 'coverage', anchor: false },
  });
  plan.finish = (m) => {
    const t = tableAt(m, start);
    if (!t) throw new Error('the new table was not found after inserting it');
    plan.journal = { kind: 'coverage', anchor: false, start: t.start, sig: tableSignature(m, t), caption };
    plan.done = `inserted the ${title} coverage table T${t.n} (${rows.length - 1} items) ${where}, with its caption below it`;
    plan.affected = () => [t.firstLine, Math.min(m.lines.length, t.lastLine + 1)];
  };
  return plan;
}

// undoEdit for kind 'coverage': the table (found by its start or its signature) and its caption line are deleted, when
// the caption is unchanged and alone in its line.
async function undoCoverage(edit) {
  const ctrlZ = 'so it cannot be undone automatically. Use Undo (Ctrl+Z) in Google Docs instead.';
  const model = await fetchDocModel(edit.docId, edit.tabId);
  const outer = (model.tables || []).filter((t) => !t.nested);
  const t = outer.find((x) => x.start === edit.start && tableSignature(model, x) === edit.sig) ||
    (() => { const same = outer.filter((x) => tableSignature(model, x) === edit.sig); return same.length === 1 ? same[0] : null; })();
  if (!t) throw new Error(`the coverage table changed after it was inserted (or is gone), ${ctrlZ}`);
  const cap = lineAtIndex(model, t.end);
  if (!cap || cap.text !== edit.caption) throw new Error(`the caption under the coverage table changed, ${ctrlZ}`);
  // The caption's text first, then the table with the line break before it: back to front, so the indices hold.
  await docsBatchUpdate(model, [reqDelete(model, cap.start, cap.start + edit.caption.length), reqDelete(model, t.start - 1, t.end)]);
  const now = await fetchDocModel(edit.docId, edit.tabId);
  const back = lineAtIndex(now, t.start - 1);
  return { model: now, restored: '', lostObjects: false, range: back ? [back.line, back.line] : [1, 1], what: 'removed the coverage table and its caption' };
}
registerUndoHandler('coverage', undoCoverage);

// ---- The tool ---------------------------------------------------------------------------------------------------------
// Runs the batches (quiet document passes on a copy of the turn snapshot: the frozen start-of-turn view), then inserts
// the table. Stop between or during batches ends it without an edit.
async function runGuidelineCoverage(name, args, snap, ui, call) {
  const key = String((args && args.guideline) || '').trim().toUpperCase().replace(/\s+/g, '');
  const g = GUIDELINES[key] || GUIDELINES[GL_NAMES.find((k) => k.replace('+', '') === key.replace('+', '')) || ''];
  if (!g) return writeError(`guideline must be one of ${GL_NAMES.join(', ')}.`, 'guideline_coverage: unknown guideline');
  const model = snap.model;
  const total = model.lines.length;
  const line = args.line == null || args.line === '' ? total : Number(args.line);
  if (!Number.isInteger(line) || line < 0 || line > total) return writeError(`line must be an integer from 0 to ${total}, or null for the end.`, 'guideline_coverage: invalid line');
  if (snap.responseWrite) return writeError('line numbers changed after the previous edit in this response, so the coverage table was not inserted; re-read with read_lines and call it again.', 'guideline_coverage: line numbers changed; not run');
  const view = snap.promptView || snap;
  const lines = String(view.docText || '').split('\n');
  const batches = guidelineBatches(g);
  const results = new Map();
  const pass = { ...snap, quiet: true, docPass: null, docCache: new Map(), turnLines: [] };
  const signal = snap.signal || new AbortController().signal;
  const stopped = (k) => writeError(`stopped after ${k} of ${batches.length} batches of ${g.name} items; nothing was inserted.`, 'guideline_coverage: stopped');
  for (let k = 0; k < batches.length; k++) {
    if (signal.aborted) return stopped(k);
    const b = batches[k];
    const from = k * GL_BATCH + 1;
    setStatus(`Checking ${g.name} items ${from}–${from + b.length - 1} of ${g.items.length}…`);
    const history = [{ role: 'user', content: batchMessage(g, b), _context: buildTurnContext('card', pass, null) }];
    try {
      await toolLoop('coverage', pass, signal, { messages: history, quiet: true, request: { history }, status: setStatus });
    } catch (e) {
      if (signal.aborted || (e && e.name === 'AbortError')) return stopped(k);
      return writeError(`the ${g.name} check failed in batch ${k + 1} of ${batches.length} (${e.message || e}); nothing was inserted.`, 'guideline_coverage: ' + (e.message || e));
    }
    const last = [...history].reverse().find((m) => m.role === 'assistant' && m.content);
    for (const [id, r] of parseCoverage(last ? last.content : '', b)) results.set(id, r);
  }
  if (signal.aborted) return stopped(batches.length);
  const { rows, n } = coverageRows(g, results, lines);
  const caption = captionText(g, n);
  const plan = planCoverageTable(model, line, rows, caption, g.name);
  if (plan.error) return writeError(plan.error, plan.short);
  const refused = await gateEdit(name, plan, snap, ui);
  if (refused) return refused;
  const res = await commitSequence(snap, plan, call.id, plan.steps);
  if (res.fail) return res.fail;
  try { plan.finish(res.model); } catch (e) {
    plan.journal = { kind: 'coverage', anchor: false, undoable: false };
    plan.done = `${plan.title.charAt(0).toLowerCase()}${plan.title.slice(1)} (${e.message}; it cannot be undone from the panel)`;
    plan.affected = () => plan.region;
  }
  const out = await finishEdit(snap, plan, call.id, res.model);
  const missing = g.items.filter((it) => (results.get(it[0]) || {}).status === 'Missing').map((it) => `${it[0]} ${it[1]}`);
  const summary = `${g.name}: ${countsText(n, g.items.length)}.`;
  const notes = [summary + (missing.length ? ` Missing: ${missing.join('; ')}.` : ''), 'Tell the user this summary; coverage says nothing about quality.'];
  if (g.form === 'topics') notes.push(`The ${g.name} checklist's wording is not licensed for redistribution, so only item numbers and topics were used; the full items are at ${g.url}.`);
  return { ...out, content: out.content + '\n' + notes.join('\n'), _message: summary };
}

const GUIDELINE_DEF = { type: 'function', function: {
  name: 'guideline_coverage',
  description: `Check which items of a reporting guideline the document reports (covered, partly, missing, with a quote and line) and insert the results as a table after a line (null: at the end) with a caption; one undoable edit. ${GL_NAMES.join(', ')}. Costs about 150 tokens per item plus one read of the document per ${GL_BATCH} items; use it only when the user asks for a guideline check. Coverage says nothing about quality.`,
  parameters: {
    type: 'object',
    properties: {
      guideline: { type: 'string', enum: GL_NAMES, description: 'CONSORT (randomised trials), PRISMA (systematic reviews), STROBE (observational), ARRIVE (animal research), CARE (case reports), TRIPOD+AI (prediction models).' },
      line: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'The table goes after this line (0 = at the beginning); null = at the end.' },
    },
    required: ['guideline', 'line'],
    additionalProperties: false,
  },
} };

// Offered only in an Auto turn with the Docs API whose message names a guideline or asks for a reporting checklist:
// the definition costs about 250 tokens, and the other turns (Munin's 64k window) stay as they were. The turn's message
// is the same in every round, so the offer is too.
const GL_ASK_RE = /\b(?:CONSORT|PRISMA|STROBE|ARRIVE|CARE|TRIPOD(?:\+AI)?)\b|\b(?:consort|prisma|strobe|arrive 2|tripod)\b|reporting (?:guideline|checklist)|guideline coverage|чек-?лист|руководств\p{L}* по (?:представлению|описанию)/u;
function glAsked(snap) {
  const msgs = (snap && snap.chatCtx && snap.chatCtx.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user' && !msgs[i]._auto) return GL_ASK_RE.test(String(msgs[i].content || ''));
  return false;
}
registerTools([GUIDELINE_DEF], {
  offer: (mode, snap) => apiEditing(mode, snap) && glAsked(snap),
  reading: false,
  icon: '📋',
  pending: 'Checking the guideline items…',
  summary: (n, args) => `${String(args.guideline || '')}${args.line == null ? ' at the end' : ` after line ${args.line}`}`,
  gate: (n, plan) => plan.gate,
  run: runGuidelineCoverage,
  prompt: [{ section: 'edit', line: `- guideline_coverage(guideline, line): which items of ${GL_NAMES.join(', ')} the document reports, as a table after line (null: the end). Only when asked.` }],
});
