const SERIF_RE =
  /serif|roman|garamond|georgia|playfair|didot|bodoni|baskerville|caslon|palatino|antiqua|minion|lora|merriweather|crimson|spectral|charter|literata|song|songti|宋|mincho|明朝|ming|batang|바탕|myeongjo|명조|gungsuh|궁서|細明|標楷|儷宋/i
const MONO_RE = /mono|courier|consolas|menlo|monaco|code|typewriter/i

function classifyFamily(family: string): 'serif' | 'sans' | 'mono' {
  if (MONO_RE.test(family)) return 'mono'
  if (SERIF_RE.test(family)) return 'serif'
  return 'sans'
}

export { classifyFamily }
