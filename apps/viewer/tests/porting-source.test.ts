import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const repo = new URL('../../../', import.meta.url)
const bytes = (path: string) => readFile(new URL(path, repo))
const manifest = async (path: string) => JSON.parse((await bytes(path)).toString())

test('all declared renderer snapshots are exact copies or individually documented adapters', async () => {
  for (const file of ['sources.json', 'docs-sources.json']) {
    const data = await manifest(`packages/viewer-renderers/${file}`)
    for (const source of [...(data.runtimeFiles || data.files), ...(data.typeFiles || [])]) {
      const target = source.startsWith('packages/ui/src/')
        ? source.replace('packages/ui/src/', 'ui/')
        : source.replace(/^apps\/(docs|slides|pdf)\/src\//, '$1/')
      assert.notEqual(target, source, `Unmapped source: ${source}`)
      const original = await bytes(source),
        snapshot = await bytes(`packages/viewer-renderers/src/${target}`)
      if (!snapshot.equals(original))
        assert.ok(
          data.adaptedFiles?.[target]?.length > 10,
          `Undocumented source divergence: ${target}`,
        )
    }
  }
})

test('registered missing code/UI/font resources and the OOXML module stay byte-identical', async () => {
  for (const pkg of ['viewer-renderers', 'viewer-services']) {
    const data = await manifest(`packages/${pkg}/sources.json`)
    assert.ok(data.directCopies.length > 0)
    for (const copy of data.directCopies)
      assert.deepEqual(
        await bytes(`packages/${pkg}/src/${copy.target}`),
        await bytes(copy.source),
        copy.source,
      )
  }
})

function parse(text: string) {
  return ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true)
}
function symbol(file: ts.SourceFile, name: string): ts.Node {
  let found: ts.Node | undefined
  const visit = (node: ts.Node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    )
      found = ts.isVariableDeclaration(node) ? node.initializer : node
    if (!found) ts.forEachChild(node, visit)
  }
  visit(file)
  assert.ok(found, `Missing source symbol ${name}`)
  return found
}
function tokens(text: string) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text)
  const result: string[] = []
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) result.push(scanner.getTokenText())
  return result
}

test('extracted SVG, TIFF guards and script fallback decisions retain main-package tokens', async () => {
  const data = await manifest('packages/viewer-services/sources.json')
  for (const item of data.extractedSymbols) {
    const original = parse((await bytes(item.source)).toString())
    const snapshot = parse((await bytes(`packages/viewer-services/src/${item.target}`)).toString())
    for (const name of item.symbols)
      assert.deepEqual(
        tokens(symbol(snapshot, name).getText()),
        tokens(symbol(original, name).getText()),
        `${item.target}: ${name}`,
      )
  }
})

function decodeStatements(file: ts.SourceFile, name: string) {
  const fn = symbol(file, name) as ts.FunctionDeclaration
  const block = fn.body!.statements.find(ts.isTryStatement)!.tryBlock.statements
  const at = (name: string) =>
    block.findIndex(
      (node) =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (decl) => ts.isIdentifier(decl.name) && decl.name.text === name,
        ),
    )
  assert.ok(at('ifds') >= 0 && at('rgba') > at('ifds'))
  return block
    .slice(at('ifds'), at('rgba') + 1)
    .map((node) => node.getText())
    .join('\n')
}

test('TIFF selection and pre/post decode validation remain the original core between host adapters', async () => {
  const main = parse((await bytes('apps/slides/src/main/tiff-decode.ts')).toString())
  const snapshot = parse(
    (await bytes('packages/viewer-services/src/slides/shared/tiff-pixels.ts')).toString(),
  )
  assert.deepEqual(
    tokens(decodeStatements(snapshot, 'decodeTiffPixels')),
    tokens(decodeStatements(main, 'tiffToPng')),
  )
})
