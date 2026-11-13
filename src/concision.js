'use strict';
// Module concision.js: the wordy → concise table of the writing checks (no model call) and concisionHits(text), used by
// the write notes of src/text-checks.js and by /check. Each entry: [regex source, concise form, tag]. The concise form is
// a literal replacement, '' (drop the phrase) or, when it starts with '=', an instruction ("=the plain verb"). Tag
// 'mechanical': the swap is safe without reading the sentence (grammar and meaning stay); 'judgment': it needs a look
// (case agreement in Russian, a subject that changes, a phrase that is sometimes needed). Nothing here is ever applied
// silently: a write gets a note, /check may offer a one-click swap of the mechanical ones. Pairs written for this
// project (the owner's seeds plus plain-English and Russian editing practice); src/prose-lists.js keeps its own short
// "wordy" tells, and text-checks.js drops a hit that a tell already reports.
/* exported CONCISION_PAIRS, concisionHits */

const CONCISION_PAIRS = [
  // English: phrases with a one- or two-word equivalent.
  ['in order to', 'to', 'mechanical'],
  ['so as to', 'to', 'mechanical'],
  ['in an effort to', 'to', 'mechanical'],
  ['with the aim of', 'to', 'judgment'],
  ['was conducted in accordance with', 'adhered to', 'judgment'],
  ['resulted in a significant (?:reduction|decrease) (?:in|of)', 'significantly reduced', 'judgment'],
  ['resulted in a significant increase (?:in|of)', 'significantly increased', 'judgment'],
  ['did not show any', 'showed no', 'mechanical'],
  ['does not show any', 'shows no', 'mechanical'],
  ['plays? an important role in', 'is central to', 'judgment'],
  ['for the treatment of', 'to treat', 'judgment'],
  ['a number of', 'several', 'judgment'],
  ['a large number of', 'many', 'mechanical'],
  ['a great number of', 'many', 'mechanical'],
  ['a small number of', 'a few', 'mechanical'],
  ['a great deal of', 'much', 'mechanical'],
  ['an increased number of', 'more', 'mechanical'],
  ['(?:due|owing) to the fact that', 'because', 'mechanical'],
  ['in (?:light|view) of the fact that', 'because', 'mechanical'],
  ['for the reason that', 'because', 'mechanical'],
  ['(?:despite|in spite of) the fact that', 'although', 'mechanical'],
  ['it should be (?:noted|emphasi[sz]ed|stressed) that', '', 'mechanical'],
  ['it is (?:important|worth) (?:to note|noting) that', '', 'mechanical'],
  ['it is clear that', '', 'judgment'],
  ['it was found that', '', 'judgment'],
  ['it has been (?:shown|reported|demonstrated) that', '=cite who showed it', 'judgment'],
  ['in the present (?:study|work|paper)', 'here', 'judgment'],
  ['at the present time', 'now', 'mechanical'],
  ['at this point in time', 'now', 'mechanical'],
  ['in the near future', 'soon', 'mechanical'],
  ['ha(?:s|ve) the (?:ability|capacity) to', 'can', 'mechanical'],
  ['(?:is|are) able to', 'can', 'mechanical'],
  ['(?:was|were) able to', 'could', 'judgment'],
  ['in close proximity to', 'near', 'mechanical'],
  ['in the vicinity of', 'near', 'mechanical'],
  ['prior to', 'before', 'mechanical'],
  ['subsequent to', 'after', 'mechanical'],
  ['utilize', 'use', 'mechanical'],
  ['utilizes', 'uses', 'mechanical'],
  ['utilized', 'used', 'mechanical'],
  ['utilizing', 'using', 'mechanical'],
  ['utilization', 'use', 'judgment'],
  ['with regard to', 'about', 'judgment'],
  ['with respect to', 'for', 'judgment'],
  ['the (?:vast )?majority of', 'most', 'mechanical'],
  ['a majority of', 'most', 'mechanical'],
  ['in the event that', 'if', 'mechanical'],
  ['for the purpose of', 'for', 'judgment'],
  ['on the basis of', 'based on', 'judgment'],
  ['in the absence of', 'without', 'mechanical'],
  ['in the presence of', 'with', 'judgment'],
  ['it is possible that', 'perhaps', 'judgment'],
  ['in a timely manner', 'promptly', 'mechanical'],
  ['in a similar (?:manner|fashion)', 'similarly', 'mechanical'],
  ['until such time as', 'until', 'mechanical'],
  ['whether or not', 'whether', 'judgment'],
  ['on a daily basis', 'daily', 'mechanical'],
  ['on a regular basis', 'regularly', 'mechanical'],
  ['a total of', '', 'judgment'],
  ['is dependent (?:up)?on', 'depends on', 'mechanical'],
  ['are dependent (?:up)?on', 'depend on', 'mechanical'],
  ['is indicative of', 'indicates', 'mechanical'],
  ['are indicative of', 'indicate', 'mechanical'],
  ['is in agreement with', 'agrees with', 'mechanical'],
  ['are in agreement with', 'agree with', 'mechanical'],
  ['is in contrast (?:to|with)', 'contrasts with', 'mechanical'],
  ['has been shown to be', 'is', 'judgment'],
  ['ma(?:de|ke) a decision', '=decide', 'judgment'],
  ['(?:perform|conduct|carry out)(?:s|ed)? an? analysis of', '=analyse', 'judgment'],
  ['(?:conduct|perform|carr(?:y|ied) out)(?:s|ed)? an? (?:study|investigation) of', '=study', 'judgment'],
  ['gives? rise to', '=cause', 'judgment'],
  ['in excess of', 'more than', 'mechanical'],
  ['(?:in|during) the course of', 'during', 'mechanical'],
  ['as a (?:consequence|result) of', 'because of', 'judgment'],
  ['by means of', 'by', 'mechanical'],
  ['with the help of', 'with', 'mechanical'],
  ['with the exception of', 'except', 'mechanical'],
  ['a sufficient (?:amount|number) of', 'enough', 'mechanical'],
  ['in terms of', '=rephrase', 'judgment'],
  ['take(?:s|n)? into (?:account|consideration)', '=consider', 'judgment'],
  ['ha(?:s|ve) an effect on', '=affect', 'judgment'], // "a significant effect on" is a result: only the bare phrase
  ['the question (?:as to )?whether', 'whether', 'mechanical'],
  ['serves? to', '', 'judgment'],
  // Russian: bureaucratic phrases (case agreement makes most of them a judgment).
  ['в настоящее время', 'сейчас', 'judgment'],
  ['на (?:сегодняшний день|данный момент)', 'сейчас', 'mechanical'],
  ['в данный момент', 'сейчас', 'mechanical'],
  ['осуществл\\p{L}*', '=the plain verb', 'judgment'],
  ['явля(?:ется|ются)', '=a dash or the verb', 'judgment'],
  ['явля(?:ется|ются) одним из', 'один из', 'judgment'],
  ['представля(?:ет|ют) собой', 'это', 'judgment'],
  ['в рамках', 'в', 'judgment'],
  ['в целях', 'чтобы', 'judgment'],
  ['с целью', 'чтобы', 'judgment'],
  ['данн(?:ый|ая|ое|ого|ой|ом|ому|ую)(?!\\s+выборк)', 'этот', 'judgment'],
  ['в связи с тем,? что', 'потому что', 'mechanical'],
  ['ввиду того,? что', 'потому что', 'mechanical'],
  ['по причине того,? что', 'потому что', 'mechanical'],
  ['в (?:том )?случае,? если', 'если', 'mechanical'],
  ['имеет место', 'есть', 'judgment'],
  ['оказывает (?:\\p{L}+ )?влияние на', 'влияет на', 'mechanical'],
  ['оказывают (?:\\p{L}+ )?влияние на', 'влияют на', 'mechanical'],
  ['принимает участие', 'участвует', 'mechanical'],
  ['принимают участие', 'участвуют', 'mechanical'],
  ['обладает способностью', 'может', 'mechanical'],
  ['обладают способностью', 'могут', 'mechanical'],
  ['имеет возможность', 'может', 'mechanical'],
  ['имеют возможность', 'могут', 'mechanical'],
  ['(?:провести|проводить|проведение) (?:анализа?|исследовани[ея])', '=the verb ("проанализировать")', 'judgment'],
  ['в качестве', 'как', 'judgment'],
  ['в процессе', 'при', 'judgment'],
  ['в ходе', 'при', 'judgment'],
  ['целый ряд', 'несколько', 'judgment'],
  ['(?:большое|значительное) количество', 'много', 'judgment'],
  ['в значительной (?:степени|мере)', 'во многом', 'judgment'],
  ['(?:необходимо|следует|стоит|важно) отметить,? что', '', 'mechanical'],
  ['на основании', 'по', 'judgment'],
  ['в соответствии с', 'по', 'judgment'],
  ['в отношении', 'о', 'judgment'],
  ['по отношению к', 'к', 'judgment'],
  ['тот факт,? что', 'что', 'judgment'],
  ['в (?:настоящей|данной) работе', 'здесь', 'judgment'],
];

// One case-insensitive whole-word regex per entry (letters of any script; the u flag), built once.
const CONCISION_RES = CONCISION_PAIRS.map(([src, to, tag]) => ({
  re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${src})(?![\\p{L}\\p{N}])`, 'giu'), to, mechanical: tag === 'mechanical',
}));

// The wordy phrases of a text: [{ match, to, mechanical, at }] in text order; to: the concise form ('' = drop it; a
// leading '=' marks an instruction, not a literal). Overlapping hits keep the longer, then the earlier one.
function concisionHits(text) {
  const s = String(text || '');
  const all = [];
  for (const { re, to, mechanical } of CONCISION_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      if (!m[0]) { re.lastIndex++; continue; }
      all.push({ match: m[0], to, mechanical, at: m.index });
    }
  }
  all.sort((a, b) => b.match.length - a.match.length || a.at - b.at);
  const out = [];
  for (const h of all) if (!out.some((o) => h.at < o.at + o.match.length && o.at < h.at + h.match.length)) out.push(h);
  return out.sort((a, b) => a.at - b.at);
}
