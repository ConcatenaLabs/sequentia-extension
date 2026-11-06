// Word names: a payment name of two words from a word list, written together, derived from the
// name's key (lnaddr.js `nameKey`), so a wallet restored from its phrase gets the same name back.
//
//   amberfalcon@sequentiatestnet.com, shown as AmberFalcon@sequentiatestnet.com
//
// The name itself is the joined words in lower case: LUD-16 allows only a-z 0-9 - _ . in a name,
// and some payers' wallets refuse capitals. Capitals are for display only (`displayName`); every
// lookup ignores case, so a name typed with capitals pays the same wallet.
//
// A key's candidates come in a fixed order (`wordNameCandidates`): two words first, then three
// words, each from SHA-256 over a tag, the key and the candidate's number. The wallet registers the
// first the service does not hold already, so a third word is added only when the two-word name is
// taken. The service keys names by the joined lower-case string, so two names that read the same
// can never both be registered, however their words split.
//
// The words: the EFF short wordlist 1 (Electronic Frontier Foundation, CC BY 3.0 US,
// https://www.eff.org/dice), less every word of the BIP39 English list (a recovery phrase's words
// never appear in a public name) and the one word that is not letters alone (yo-yo): 831 words.
// See NOTICE.
//
// No DOM: it runs under Node (word-name.test.mjs). The browser extension copies this file into its
// vendor/ and Ambra mobile holds the same list and rule (app/lib/src/data/word_name.dart): change all
// three together.
import { sha256 } from './btc.js';

export const WORDS = Object.freeze([
  'acorn', 'acre', 'acts', 'afar', 'affix', 'aged', 'agile', 'aging', 'agony', 'aide', 'aids',
  'ajar', 'alias', 'alibi', 'alike', 'alive', 'aloe', 'aloft', 'aloha', 'amend', 'amino', 'ample',
  'amuse', 'angel', 'apron', 'aqua', 'arise', 'aroma', 'array', 'arson', 'ashen', 'ashes', 'atlas',
  'attic', 'audio', 'avert', 'award', 'awoke', 'bagel', 'baggy', 'baked', 'baker', 'balmy',
  'banjo', 'barge', 'barn', 'bash', 'basil', 'bask', 'batch', 'bath', 'baton', 'bats', 'blank',
  'blaze', 'blend', 'blimp', 'blink', 'bloat', 'blob', 'blog', 'blot', 'blunt', 'blurt', 'boast',
  'bok', 'bolt', 'boned', 'boney', 'bony', 'booth', 'boots', 'botch', 'both', 'boxer', 'breed',
  'bribe', 'bride', 'brim', 'brink', 'broad', 'broil', 'broke', 'brook', 'buck', 'bud', 'buggy',
  'bulge', 'bully', 'bunch', 'bunny', 'bunt', 'bush', 'bust', 'cache', 'cadet', 'cameo', 'cane',
  'canon', 'cape', 'carol', 'carve', 'cedar', 'chain', 'chant', 'charm', 'cheek', 'cheer', 'chess',
  'chew', 'chili', 'chill', 'chip', 'chomp', 'chop', 'chow', 'chuck', 'chump', 'chute', 'cider',
  'cinch', 'civic', 'clad', 'clamp', 'clash', 'clasp', 'class', 'clear', 'cleat', 'cleft', 'cling',
  'clink', 'cloak', 'clone', 'coat', 'cod', 'coke', 'cola', 'cold', 'colt', 'coma', 'comma',
  'cone', 'cope', 'cork', 'cot', 'cough', 'cozy', 'cramp', 'crank', 'crate', 'crave', 'creme',
  'crepe', 'crept', 'crib', 'cried', 'crook', 'crown', 'crumb', 'crust', 'cub', 'cult', 'cupid',
  'cure', 'curl', 'curry', 'curse', 'curvy', 'cushy', 'cut', 'dab', 'daily', 'dairy', 'daisy',
  'dandy', 'darn', 'dart', 'data', 'date', 'deaf', 'dean', 'debit', 'debt', 'debug', 'decaf',
  'decal', 'decay', 'deck', 'decor', 'decoy', 'deed', 'denim', 'dense', 'dent', 'derby', 'dig',
  'dill', 'dime', 'dimly', 'diner', 'dingy', 'disco', 'disk', 'ditch', 'ditzy', 'dock', 'dodge',
  'doing', 'dome', 'donut', 'dot', 'down', 'dowry', 'doze', 'drab', 'drank', 'dried', 'drone',
  'droop', 'drove', 'drown', 'duct', 'dude', 'dug', 'duke', 'duo', 'dusk', 'dwell', 'easel',
  'eaten', 'eats', 'ebay', 'ebony', 'ebook', 'eel', 'eject', 'elf', 'elk', 'elm', 'elope', 'elude',
  'elves', 'email', 'emit', 'emu', 'envoy', 'etch', 'evade', 'even', 'evict', 'fable', 'faced',
  'fact', 'fang', 'fax', 'feast', 'femur', 'fend', 'ferry', 'fetal', 'fifth', 'fifty', 'filth',
  'finch', 'five', 'flaky', 'flap', 'flask', 'fled', 'flick', 'fling', 'flint', 'flirt', 'flop',
  'floss', 'flyer', 'foe', 'folic', 'folk', 'fool', 'foyer', 'frail', 'fray', 'fried', 'frill',
  'frisk', 'from', 'froth', 'froze', 'gag', 'gains', 'gala', 'gave', 'gear', 'gecko', 'geek',
  'gem', 'gig', 'gills', 'given', 'giver', 'gloss', 'goal', 'going', 'golf', 'gong', 'gooey',
  'goofy', 'gore', 'graph', 'grasp', 'grave', 'gravy', 'gray', 'greet', 'grew', 'grill', 'grip',
  'groom', 'grope', 'growl', 'grub', 'gulf', 'gulp', 'gummy', 'guru', 'gush', 'gut', 'guy', 'halo',
  'halt', 'harm', 'hash', 'hasty', 'hatch', 'hate', 'haven', 'hazel', 'hazy', 'heap', 'heat',
  'heave', 'hedge', 'hefty', 'herbs', 'hers', 'hug', 'hula', 'hull', 'humid', 'hump', 'hung',
  'hunk', 'hush', 'hut', 'icing', 'icy', 'igloo', 'ion', 'islam', 'ivy', 'jab', 'jam', 'jaws',
  'jeep', 'jet', 'jiffy', 'jog', 'jolly', 'jolt', 'jot', 'juicy', 'july', 'jumbo', 'junky',
  'juror', 'jury', 'keg', 'kept', 'kilt', 'king', 'kitty', 'knelt', 'koala', 'kung', 'ladle',
  'lair', 'lance', 'land', 'lapel', 'lash', 'lasso', 'last', 'latch', 'late', 'lent', 'lever',
  'lid', 'lilac', 'lily', 'limes', 'line', 'lint', 'lip', 'lived', 'liver', 'lung', 'lurch',
  'lure', 'lurk', 'lying', 'lyric', 'mace', 'maker', 'malt', 'mama', 'manor', 'many', 'map',
  'mardi', 'marry', 'mash', 'mate', 'moan', 'mocha', 'moist', 'mold', 'moody', 'mop', 'morse',
  'most', 'motto', 'mount', 'mousy', 'mouth', 'mower', 'mud', 'mug', 'mulch', 'mull', 'mumbo',
  'mummy', 'mural', 'muse', 'musky', 'mute', 'nacho', 'nag', 'nail', 'nanny', 'nap', 'navy',
  'neat', 'neon', 'nerd', 'niece', 'ninth', 'nutty', 'oasis', 'oat', 'omen', 'ooze', 'opal', 'opt',
  'otter', 'ouch', 'ounce', 'owl', 'pace', 'pagan', 'pager', 'pants', 'panty', 'pasta', 'patio',
  'payer', 'pecan', 'penny', 'pep', 'perch', 'perky', 'perm', 'pest', 'petal', 'petri', 'petty',
  'plank', 'plant', 'plaza', 'plead', 'plot', 'plow', 'plus', 'poach', 'pod', 'pogo', 'poise',
  'poker', 'polio', 'polka', 'polo', 'poppy', 'pork', 'poser', 'pouch', 'pound', 'pout', 'prank',
  'press', 'prior', 'prism', 'probe', 'prong', 'props', 'prude', 'prune', 'pry', 'pug', 'puma',
  'punk', 'purr', 'putt', 'quack', 'quake', 'query', 'quiet', 'quill', 'quilt', 'quota', 'rabid',
  'raft', 'rage', 'raid', 'rake', 'rank', 'rant', 'rash', 'reach', 'react', 'ream', 'recap',
  'relay', 'relic', 'remix', 'repay', 'repel', 'reply', 'rerun', 'reset', 'rhyme', 'rigor',
  'rinse', 'ripen', 'rise', 'ritzy', 'robe', 'robin', 'rock', 'rogue', 'roman', 'romp', 'rope',
  'rover', 'ruby', 'ruin', 'runny', 'rush', 'rust', 'rut', 'sadly', 'sage', 'said', 'saint',
  'salsa', 'sandy', 'santa', 'satin', 'sauna', 'saved', 'savor', 'sax', 'scam', 'scarf', 'scary',
  'scoff', 'scold', 'scoop', 'scoot', 'scope', 'score', 'scorn', 'scowl', 'scuba', 'scuff', 'sect',
  'sedan', 'self', 'send', 'sepia', 'serve', 'set', 'shack', 'shade', 'shady', 'shaky', 'sham',
  'shape', 'sharp', 'sheep', 'sheet', 'shelf', 'shiny', 'shirt', 'shore', 'shout', 'shown',
  'showy', 'shred', 'shun', 'shush', 'shut', 'sift', 'silo', 'sip', 'sixth', 'skew', 'skid',
  'skier', 'skies', 'skip', 'skit', 'sky', 'slack', 'slain', 'slang', 'slash', 'slate', 'slaw',
  'sled', 'sleek', 'sleet', 'slept', 'slick', 'slimy', 'sling', 'slip', 'slit', 'slob', 'slug',
  'slum', 'slurp', 'smash', 'smell', 'smirk', 'smog', 'snare', 'snarl', 'sneak', 'sneer', 'snore',
  'snort', 'snout', 'snowy', 'snub', 'snuff', 'spent', 'spew', 'spied', 'spill', 'spiny', 'spoke',
  'spoof', 'spool', 'spout', 'spree', 'spur', 'squad', 'squat', 'squid', 'stack', 'stain', 'stall',
  'stank', 'stark', 'stash', 'stays', 'steam', 'steep', 'stew', 'stir', 'stole', 'stomp', 'stony',
  'stood', 'stoop', 'stop', 'storm', 'stout', 'straw', 'stray', 'strut', 'stuck', 'stud', 'stump',
  'stung', 'stunt', 'suds', 'sulk', 'surf', 'sushi', 'swab', 'swan', 'sway', 'sweat', 'sweep',
  'swell', 'swept', 'swipe', 'swirl', 'swoop', 'swore', 'tacky', 'taco', 'take', 'tall', 'talon',
  'tamer', 'taper', 'taps', 'tarot', 'tart', 'tasty', 'taunt', 'thaw', 'theft', 'thigh', 'think',
  'thong', 'thorn', 'those', 'throb', 'thud', 'thump', 'thus', 'tiara', 'tidal', 'tidy', 'tile',
  'tint', 'trace', 'trait', 'trek', 'trio', 'trout', 'truce', 'trump', 'trunk', 'tug', 'tulip',
  'tummy', 'turf', 'tusk', 'tutor', 'tutu', 'tux', 'tweak', 'tweet', 'twine', 'twins', 'twirl',
  'uncut', 'unify', 'union', 'untie', 'user', 'usher', 'utter', 'value', 'vegan', 'verse', 'vest',
  'veto', 'vice', 'viral', 'visor', 'vixen', 'volt', 'voter', 'vowel', 'wad', 'wafer', 'wager',
  'wages', 'wake', 'wand', 'watch', 'wavy', 'whiff', 'whole', 'whoop', 'wick', 'widen', 'widow',
  'wifi', 'wilt', 'wimp', 'wind', 'wipe', 'wired', 'wiry', 'wispy', 'wok', 'womb', 'woozy',
  'wound', 'woven', 'wrath', 'xerox', 'yahoo', 'yam', 'yeast', 'yelp', 'yield', 'yodel', 'yoga',
  'yoyo', 'yummy', 'zesty', 'zippy', 'zoom'
]);

// How many candidates a key has: one of two words, then three-word ones.
export const CANDIDATES = 8;
const TAG = 'sequentia-name-words/1';
const enc = (s) => new TextEncoder().encode(s);

// The words of candidate `k` of the key `pubHex` (32-byte hex): two for k = 0, three after.
function wordsAt (pubHex, k) {
  const h = sha256(enc(`${TAG}\n${String(pubHex).toLowerCase()}\n${k}`));
  const want = k === 0 ? 2 : 3;
  const out = [];
  for (let i = 0; i + 4 <= h.length && out.length < want; i += 4) {
    const n = ((h[i] << 24) >>> 0) + (h[i + 1] << 16) + (h[i + 2] << 8) + h[i + 3];
    const w = WORDS[n % WORDS.length];
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

// The key's candidates, in the order a wallet tries them: [{ name, words }].
export function wordNameCandidates (pubHex, count = CANDIDATES) {
  const out = [];
  for (let k = 0; k < count; k++) { const words = wordsAt(pubHex, k); out.push({ name: words.join(''), words }); }
  return out;
}

// The words of `name` when it is one of the key's candidates, else null.
export function wordsOf (name, pubHex, count = CANDIDATES) {
  const n = String(name || '').toLowerCase();
  const c = wordNameCandidates(pubHex, count).find((x) => x.name === n);
  return c ? c.words : null;
}

// How a name is shown: each word with a capital (AmberFalcon) when it is one of the key's word
// names, else as it is.
export function displayName (name, pubHex) {
  const w = pubHex ? wordsOf(name, pubHex) : null;
  return w ? w.map((x) => x[0].toUpperCase() + x.slice(1)).join('') : String(name || '');
}
