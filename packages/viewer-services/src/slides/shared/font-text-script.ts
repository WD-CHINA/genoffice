type Script = 'arabic' | 'hebrew' | 'thai' | 'devanagari'

const SCRIPT_RES: Array<[Script, RegExp]> = [
  ['arabic', /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/],
  ['hebrew', /[\u0590-\u05ff\ufb1d-\ufb4f]/],
  ['thai', /[\u0e00-\u0e7f]/],
  ['devanagari', /[\u0900-\u097f]/],
]

export function complexScriptOf(text: string): Script | null {
  for (const [script, re] of SCRIPT_RES) {
    if (re.test(text)) return script
  }
  return null
}
