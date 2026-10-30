'use strict';
// Module prose-lists.js: the tell lists of the writing check (src/prose-lint.js), data only. PROSE_TELLS: one
// table per category, each entry [regex source, plain alternative ('' when the fix is to drop it), flags]; flags
// 's' = only at the start of a sentence. Matched case-insensitively, as whole words (letters of any script), in
// the order of PROSE_TELL_ORDER: a span found by an earlier category is not reported again by a later one.
// The lists are ours, kept short and aware of scientific prose (terms that are precise in a paper, such as
// "significantly", "facilitated diffusion" or the passive voice, are not listed). English entries were chosen
// from: clements23/ai-slop-library 1.7.0 (MIT, © 2026 Clements Emerson Dewanto); the existence and substitution
// rules of the errata-ai Microsoft and Google Vale styles (MIT, © 2018-2019 Joseph Kato); write-good (MIT,
// © 2014-2019 Brian Ford) with weasel-words (MIT, Brian Ford) and too-wordy (MIT, © 2014 Matt Blair); proselint's
// hedging, weasel-word, redundancy and cliché checks (BSD-3-Clause, © 2014-2015 Jordan Suchow, Michael Pacer and
// Lara A. Ross); a few bare words named in Wikipedia's "Signs of AI writing", with our own explanations. The
// Russian lists are written for this project (bureaucratic fillers and run-ups in the spirit of the published
// "stop words" method). Full licence texts: vendor/NOTICES.txt.
/* exported PROSE_TELLS, PROSE_TELL_ORDER */

const PROSE_TELL_ORDER = ['chat', 'staging', 'tail', 'opener', 'stock', 'filler', 'hedge', 'wordy', 'redundant'];

// Plural "данные" is the demonstrative ("эти") only before a noun in the same case ("данные образцы", "в данных
// условиях", "данным методом"); before a genitive it is the noun "data" ("данные эксперимента", "данные
// экспериментов"). Short lists of the nouns that follow it in scientific prose, by gender, since the endings
// differ: a masculine genitive singular ("метода") is not a plural, a neuter or feminine one ("условия",
// "величины") looks like one, so only nouns rarely meant as "data of …" are listed there.
const DANNYE_MASC = 'метод|способ|подход|образц|параметр|случа|вопрос|объект|эффект|прибор|раствор|реагент|материал|процесс|эксперимент|опыт';
const DANNYE_NEUT = 'услови|веществ|соединени|явлени|свойств|обстоятельств';
const DANNYE_FEM = 'характеристик|величин|особенност|методик';
const DANNYE_ANY = `${DANNYE_MASC}|${DANNYE_NEUT}|${DANNYE_FEM}`;
const dannyeBefore = (stems, endings) => `\\s+(?:${stems})(?:${endings})(?![\\p{L}\\p{N}])`;
const DANNYE_PLURAL = '(?<!(?:по|согласно|судя по|из|без|вопреки)\\s+)(?:'
  + `данные(?=${dannyeBefore(DANNYE_MASC, 'ы|и')}|${dannyeBefore(DANNYE_NEUT, 'а|я')}|${dannyeBefore(DANNYE_FEM, 'ы|и')})`
  + `|данных(?=${dannyeBefore(DANNYE_ANY, 'ах|ях')}|\\s+условий(?![\\p{L}\\p{N}]))`
  + `|данным(?=${dannyeBefore(DANNYE_ANY, 'ам|ям|ом|ем|ём')})`
  + `|данными(?=${dannyeBefore(DANNYE_ANY, 'ами|ями')}))`;

const PROSE_TELLS = {
  // Chat phrases that end up inside document text: only where a chat answer puts them.
  chat: [
    ['(?:^|(?<=\\n))\\s*here(?: is|\'s) (?:the|a|an|your)', 'drop it'],
    ['^\\s*(?:certainly|sure|absolutely|конечно)(?=[,!.])', 'drop it'],
    ['i hope this helps', 'drop it'],
    ['let me know if', 'drop it'],
    ['feel free to', 'drop it'],
    ['i(?:\'d| would) be happy to', 'drop it'],
    ['great question', 'drop it'],
    ['as an ai(?: language model)?', 'drop it'],
    ['you(?:\'re| are) absolutely right', 'drop it'],
    ['\\[(?:insert|your|add|placeholder)[^\\]\\n]{0,40}\\]', 'fill it in or drop it'],
    ['oaicite|contentreference|turn\\d+search\\d+', 'drop it'],
    ['вот (?:переписанн|исправленн|отредактированн|улучшенн|обновл[её]нн)\\p{L}*', 'drop it'],
    ['надеюсь, это (?:поможет|помогло)', 'drop it'],
    ['дайте (?:мне )?знать, если', 'drop it'],
    ['если (?:нужно|хотите), (?:я )?(?:могу|смогу)', 'drop it'],
    ['отличный вопрос', 'drop it'],
    ['как (?:языковая модель|ии-ассистент)', 'drop it'],
  ],
  // "not X but Y" staging: the contrast is usually a straw man.
  staging: [
    ['not (?:just|only|merely) [^.!?;:\\n]{1,80}? but', 'state the second part directly'],
    ['(?:it|this|that)(?:\'s| is| was) not (?:just |only |merely |about )?[^.!?;:\\n]{1,60}?[.;]\\s+(?:it|this|that)(?:\'s| is| was)', 'state what it is'],
    ['more than (?:just|merely|simply)', 'say what it is'],
    ['не просто [^.!?;:\\n]{1,80}?,\\s*а', 'state Y'],
    ['(?:речь ид[её]т|дело) не (?:о|в) [^.!?;:\\n]{1,60}?,\\s*а (?:о|в)', 'state Y'],
    ['больше,? чем просто', 'say what it is'],
  ],
  // ", highlighting …" tails that add weight but no fact. A pattern that starts with a comma follows a word.
  tail: [
    [',\\s*(?:highlighting|ensuring|reflecting|underscoring|emphasi[sz]ing|showcasing|signall?ing|cementing|solidifying)', 'end the sentence on its fact'],
    [',\\s*paving the way', 'end the sentence on its fact'],
    [',\\s*(?:подч[её]ркивая|отражая|обеспечивая|демонстрируя|свидетельствуя о)', 'end the sentence on its fact'],
    [',\\s*открывая (?:новые )?(?:возможности|перспективы|горизонты|путь)', 'end the sentence on its fact'],
  ],
  // Throat-clearing run-ups and stock connectives.
  opener: [
    ['it is worth (?:noting|mentioning) that', 'drop it'],
    ['it(?:\'s| is) (?:important|crucial|essential) to (?:note|remember|recogni[sz]e|understand) that', 'drop it'],
    ['it should be (?:noted|emphasi[sz]ed|stressed) that', 'drop it'],
    ['it goes without saying(?: that)?', 'drop it'],
    ['needless to say,?', 'drop it'],
    ['first and foremost,?', '"first"'],
    ['let\'s (?:dive|delve) into', 'drop it'],
    ['importantly,', 'drop it', 's'],
    ['notably,', 'drop it', 's'],
    ['interestingly,', 'drop it', 's'],
    ['additionally,', '"also", or drop it', 's'],
    ['ultimately,', 'drop it', 's'],
    ['essentially,', 'drop it', 's'],
    ['that being said,', 'drop it', 's'],
    ['in (?:conclusion|summary),', 'drop it', 's'],
    ['to (?:summari[sz]e|conclude|sum up),', 'drop it', 's'],
    ['overall,', 'drop it', 's'],
    ['(?:стоит|важно|следует|необходимо) (?:отметить|подчеркнуть|упомянуть)(?:,? что)?', 'drop it'],
    ['нельзя не (?:отметить|подчеркнуть)(?:,? что)?', 'drop it'],
    ['важно понимать(?:,? что)?', 'drop it'],
    ['таким образом', '"поэтому", or drop it', 's'],
    ['в заключение', 'drop it', 's'],
    ['подводя итоги?', 'drop it', 's'],
  ],
  // Inflated stock words, phrases and clichés.
  stock: [
    // Before "key role" and "crucial": the whole phrase is one note.
    ['play(?:s|ed|ing)? an? (?:vital|key|crucial|central|major|important|significant|pivotal|critical|essential|fundamental) role(?: in)?', 'say what it does'],
    ['pivotal', 'say what it does'],
    ['crucial(?:ly)?', 'say what it does'],
    ['key role', 'say what it does'],
    ['underscor(?:e|es|ed|ing)', '"shows"'],
    ['highlights? the', '"shows the"'],
    ['testament', 'state the fact'],
    ['landscape', 'name the field'],
    ['robust(?:ly)?', 'name the property'],
    ['seamless(?:ly)?', 'drop it'],
    ['delv(?:e|es|ed|ing)', '"examine"'],
    ['showcas(?:e|es|ed|ing)', '"show"'],
    ['foster(?:s|ed|ing)?', '"support"'],
    ['vibrant', 'drop it'],
    ['comprehensive', '"full", or drop it'],
    ['leverag(?:e|es|ed|ing)', '"use"'],
    ['serv(?:e|es|ed|ing) as', '"is"'],
    ['stands as', '"is"'],
    ['boasts', '"has"'],
    ['features (?:a|an)', '"has"'], // the verb; "the features of" is a noun
    ['realm', 'name the field'],
    ['tapestry', 'name the parts'],
    ['intricate(?:ly)?', '"complex", or say how'],
    ['multifaceted', 'name the facets'],
    ['holistic', 'say what is included'],
    ['transformative', 'say what changed'],
    ['groundbreaking|game[- ]chang(?:er|ing)|revolutionary', 'say what is new'],
    ['cutting[- ]edge|state[- ]of[- ]the[- ]art', '"new", "current", or name it'],
    ['unprecedented', 'say compared with what'],
    ['(?:of )?(?:paramount|utmost|great|vital|critical) importance', 'say what it changes'],
    ['paramount', '"main", or drop it'],
    ['(?:has|have|had) (?:attracted|gained|received|garnered|drawn) (?:considerable|significant|growing|increasing|much|great|wide|widespread) (?:attention|interest)', 'cite who studied it'],
    ['meticulous(?:ly)?', '"careful", or say how'],
    ['embark(?:s|ed|ing)? on', '"start"'],
    ['navigat(?:e|es|ed|ing) the (?:complexit|challeng)\\p{L}*', 'say what was done'],
    ['ever[- ]evolving', 'drop it'],
    ['nuanced', 'name the nuance'],
    ['garner(?:s|ed|ing)?', '"get", "receive"'],
    ['bolster(?:s|ed|ing)?', '"support", "strengthen"'],
    ['shed(?:s|ding)? (?:new )?light on', '"show", "explain"'],
    ['pav(?:e|es|ed|ing) the way', 'say what it enables'],
    ['valuable insights?', 'say what was learned'],
    ['harness(?:es|ed|ing)? the (?:power|potential)', '"use"'],
    ['unlock(?:s|ed|ing)? (?:the|new) (?:potential|possibilities)', 'say what it enables'],
    ['in today\'s (?:fast-paced |digital |modern )?(?:world|age|era)', 'drop it'],
    ['at the end of the day|in a nutshell|only time will tell|the tip of the iceberg|a double-edged sword', 'say it plainly'],
    ['crystal clear|paradigm shift|low-hanging fruit|last but not least|the elephant in the room', 'say it plainly'],
    ['(?:игра|сыгра)(?:ет|ют|л|ла|ло|ли|ть|ющ\\p{L}*) (?:ключев|важн|решающ|значим|центральн|огромн|существенн|немаловажн|важнейш)\\p{L}* рол(?:ь|и)', 'say what it does'],
    ['в современном мире', 'drop it'],
    ['в (?:нашу|современную|цифровую) эпоху', 'drop it'],
    ['ни для кого не секрет(?:,? что)?', 'drop it'],
    ['неотъемлем\\p{L}* част\\p{L}*', 'say how it belongs'],
    ['уникальн\\p{L}*', 'say what is different'],
    ['инновационн\\p{L}*', 'say what is new'],
    ['беспрецедентн\\p{L}*|революционн\\p{L}*', 'say compared with what'],
    ['многогранн\\p{L}*', 'name the facets'],
    ['всесторонн\\p{L}*', '"полный", or drop it'],
    ['комплексн\\p{L}* подход\\p{L}*', 'name the parts'],
    ['прол(?:ивает|ивают|ил|ила|или|ить) свет на', '"показывает", "объясняет"'],
    ['открыва(?:ет|ют|л|ли) (?:новые )?(?:горизонты|перспективы|возможности)', 'say what becomes possible'],
    ['подч[её]ркива(?:ет|ют|л|ли) (?:важность|значимость|роль)', '"показывает"'],
    ['огромн\\p{L}* значени\\p{L}*', 'say what it changes'],
    ['привлека(?:ет|ют|л|ла|ли) (?:вс[её] )?(?:большее |пристальное |значительное |повышенное |широкое )?внимание', 'cite who studied it'],
    ['вызыва(?:ет|ют|л|ла|ли) (?:большой|значительный|повышенный|огромный|живой|широкий) интерес', 'cite who studied it'],
    ['широк(?:ий|ого|ому|им|ом) спектр\\p{L}* (?:возможностей|задач|применений)', 'name them'],
  ],
  // Russian bureaucratic fillers: a plain verb or nothing says the same.
  filler: [
    ['явля(?:ется|ются|лся|лась|лось|лись|ясь|ющ\\p{L}*)', 'a dash or a plain verb'],
    ['представля(?:ет|ют|л|ла|ло|ли) собой', 'a dash or "это"'],
    ['осуществл\\p{L}*', 'the plain verb'],
    ['в рамках', '"в"'],
    ['в целом', 'drop it'],
    ['на данный момент|на сегодняшний день|в настоящее время', '"сейчас", or drop it'],
    // "данный" the demonstrative, not the noun "данные" (data: "по нашим данным", "данные о кинетике отсутствуют").
    // The singular forms are always the demonstrative ("в данной выборке" is a qualifier); the plural ones and
    // "данным" only before a noun in the same case (DANNYE_PLURAL).
    ['данн(?:ый|ая|ое|ого|ой|ом|ому|ую)(?!\\s+выборк)', '"этот"'],
    [DANNYE_PLURAL, '"эти", "этим"'],
    ['активно', 'drop it, or say how often'],
    ['эффективно', 'say how well'],
    ['имеет место', '"есть", "происходит"'],
    ['в качестве', '"как"'],
    ['в процессе', '"при", "во время"'],
  ],
  // Hedges without a reason, unattributed claims and intensifiers. The qualifiers an edit must keep ("may",
  // "suggests", "возможно") are not here: stacked ones are.
  hedge: [
    ['very', 'drop it, or give the number'],
    ['extremely', 'drop it, or give the number'],
    ['clearly|obviously', 'show it, or drop it'],
    ['quite', 'drop it'],
    ['remarkabl(?:e|y)', 'say compared with what'],
    ['arguably', 'make the argument, or drop it'],
    ['it is (?:widely|generally|commonly) (?:believed|accepted|known|thought)(?: that)?', 'cite who'],
    ['(?:studies|research) (?:show|shows|has shown|have shown|suggests?)', 'cite them'],
    ['experts (?:agree|believe|say)', 'cite them'],
    ['some (?:may|might|would) argue|it could be argued|i would argue(?: that)?', 'make the argument, or cite it'],
    ['to a (?:certain|some) (?:degree|extent)', 'say how much'],
    [',\\s*so to speak', 'drop it'],
    ['(?:may|might|could) (?:potentially|possibly|perhaps|conceivably)|potentially (?:may|might|could)', 'one hedge is enough'],
    ['очень', 'drop it, or give the number'],
    ['крайне|чрезвычайно|весьма', 'drop it, or give the number'],
    ['безусловно|несомненно', 'show it, or drop it'],
    ['очевидно,', 'show it, or drop it'],
    ['как известно,?', 'cite it'],
    ['принято считать(?:,? что)?', 'cite who'],
    ['многие (?:исследователи|уч[её]ные|авторы|эксперты) (?:считают|полагают|отмечают)', 'cite them'],
    ['по мнению (?:многих )?(?:экспертов|специалистов|уч[её]ных)', 'cite them'],
    ['в (?:некоторой|определ[её]нной|известной) (?:степени|мере)', 'say how much'],
    ['так сказать', 'drop it'],
    ['(?:возможно|вероятно),? (?:может|могут|мог|могла|могли)', 'one hedge is enough'],
  ],
  // Wordy phrases with a short equivalent (in Russian: compound prepositions and conjunctions).
  wordy: [
    ['in order to', '"to"'],
    ['(?:due|owing) to the fact that|because of the fact that|in view of the fact that', '"because"'],
    ['(?:despite|in spite of) the fact that', '"although"'],
    ['in the event that', '"if"'],
    ['a (?:large |great |significant )?number of', '"many", "several", or the number'],
    ['the (?:vast )?majority of', '"most"'],
    ['prior to', '"before"'],
    ['subsequent to', '"after"'],
    ['with (?:regard|respect) to', '"about", "for"'],
    ['in terms of', 'rephrase'],
    ['(?:has|have) the (?:ability|capacity) to|(?:is|are) able to', '"can"'],
    ['at (?:the present time|this point in time)', '"now"'],
    ['for the purpose of', '"for", "to"'],
    ['in an effort to|as a means (?:of|to)', '"to"'],
    ['it is possible that', '"may"'],
    ['take(?:s|n)? into (?:account|consideration)', '"consider"'],
    ['make use of|utiliz(?:e|es|ed|ing)|utilization', '"use"'],
    ['(?:conduct|perform|carr(?:y|ied) out)(?:s|ed)? an? (?:investigation|analysis|assessment|evaluation) of', 'the verb ("analyse")'],
    ['(?:a sufficient|an adequate) number of', '"enough"'],
    ['in close proximity to', '"near"'],
    ['whether or not', '"whether"'],
    ['on the basis of', '"from", "by"'],
    ['until such time as', '"until"'],
    ['in a (?:timely|similar|careful) manner', 'an adverb ("promptly", "similarly")'],
    ['в целях|с целью', '"чтобы", "для"'],
    ['в связи с тем,? что|ввиду того,? что', '"потому что"'],
    ['по отношению к', '"к", "для"'],
    ['целый ряд', '"несколько", or the number'],
    ['оказ(?:ывает|ывают|ывал|ывала|ывали|ывать|ал|ала|ало|али|ать) (?:сильное |существенное |значительное |заметное |большое |определ[её]нное )?влияние на', '"влияет на"'],
    ['оказ(?:ывает|ывают|ывал|ывала|ывали|ывать|ал|ала|ало|али|ать) (?:сильное |существенное |значительное |заметное )?воздействие на', '"действует на"'],
    ['в значительной (?:степени|мере)', '"во многом", or say how much'],
    ['(?:have|has|had) an? (?:major |strong |profound |considerable )?(?:impact|influence) on', '"affect"'], // "a significant effect on" is a statistical result
  ],
  // Redundant pairs: one word already says it.
  redundant: [
    ['absolutely (?:essential|necessary)', 'drop "absolutely"'],
    ['basic fundamentals', '"fundamentals"'],
    ['close proximity', '"proximity"'],
    ['completely (?:eliminat|destroy|fill|finish)\\p{L}*', 'drop "completely"'],
    ['end result|final (?:outcome|conclusion)', '"result", "outcome"'],
    ['future plans|past history|new innovation|advance planning|added bonus|unexpected surprise', 'drop the first word'],
    ['each and every', '"each"'],
    ['(?:combine|combined|mix|mixed|merge|merged|join|joined|connect|connected|collaborate|cooperate) together', 'drop "together"'],
    ['repeat(?:ed)? again', '"repeat"'],
    ['(?:revert|return|refer)(?:s|ed)? back', 'drop "back"'],
    ['true facts|actual fact', '"facts", "fact"'],
    ['general consensus|consensus of opinion', '"consensus"'],
    ['exact same', '"same"'],
    ['still remains?', '"remains"'],
    ['various different', '"various"'],
    ['joint collaboration|mutual cooperation', '"collaboration", "cooperation"'],
    ['(?:small|large) in size|(?:round|rectangular|square) in shape', 'drop "in size", "in shape"'],
    ['period of time|time period', '"period", "time"'],
    ['major breakthrough', '"breakthrough"'],
    ['(?:совместн|взаимн)\\p{L}* сотрудничеств\\p{L}*', '"сотрудничество"'],
    ['период\\p{L}* времени', '"период"'],
    ['в конечном итоге', '"в итоге"'],
    ['(?:основн|главн)\\p{L}* суть', '"суть"'],
    ['повтор\\p{L}* (?:снова|вновь|ещ[её] раз)', 'drop "снова"'],
    ['возвра\\p{L}* обратно', 'drop "обратно"'],
    ['подня\\p{L}* вверх|спусти\\p{L}* вниз', 'drop the adverb'],
    ['ведущ\\p{L}* лидер\\p{L}*|впервые дебютир\\p{L}*|памятн\\p{L}* сувенир\\p{L}*|свободн\\p{L}* ваканси\\p{L}*', 'drop the first word'],
    ['заранее (?:предусм|запланир|подготов)\\p{L}*', 'drop "заранее"'],
  ],
};
