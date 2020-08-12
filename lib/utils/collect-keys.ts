/**
 * @fileoverview Collect localization keys
 * @author kazuya kawaguchi (a.k.a. kazupon)
 */
import { CLIEngine } from 'eslint'
import { parseForESLint, AST as VAST } from 'vue-eslint-parser'
import { readFileSync } from 'fs'
import { resolve, extname } from 'path'
import { listFilesToProcess } from './glob-utils'
import { ResourceLoader } from './resource-loader'
import { CacheLoader } from './cache-loader'
import { defineCacheFunction } from './cache-function'
import debugBuilder from 'debug'
import type { VisitorKeys } from '../types'
const debug = debugBuilder('eslint-plugin-vue-i18n:collect-keys')

/**
 *
 * @param {CallExpression} node
 */
function getKeyFromCallExpression(node: VAST.ESLintCallExpression) {
  const funcName =
    (node.callee.type === 'MemberExpression' &&
      node.callee.property.type === 'Identifier' &&
      node.callee.property.name) ||
    (node.callee.type === 'Identifier' && node.callee.name) ||
    ''

  if (
    !/^(\$t|t|\$tc|tc)$/.test(funcName) ||
    !node.arguments ||
    !node.arguments.length
  ) {
    return null
  }

  const [keyNode] = node.arguments
  if (keyNode.type !== 'Literal') {
    return null
  }

  return keyNode.value ? keyNode.value : null
}

/**
 * @param {VDirective} node
 */
function getKeyFromVDirective(node: VAST.VDirective) {
  if (
    node.value &&
    node.value.type === 'VExpressionContainer' &&
    node.value.expression &&
    node.value.expression.type === 'Literal'
  ) {
    return node.value.expression.value ? node.value.expression.value : null
  } else {
    return null
  }
}

/**
 * @param {VAttribute} node
 */
function getKeyFromI18nComponent(node: VAST.VAttribute) {
  if (node.value && node.value.type === 'VLiteral') {
    return node.value.value
  } else {
    return null
  }
}

function getParser(
  parser: string | undefined
): {
  parseForESLint?: typeof parseForESLint
  parse: (code: string, options: unknown) => VAST.ESLintProgram
} {
  if (parser) {
    try {
      return require(parser)
    } catch (_e) {
      // ignore
    }
  }
  return {
    parseForESLint,
    parse(code: string, options: unknown) {
      return parseForESLint(code, options).ast
    }
  }
}

/**
 * Collect the used keys from source code text.
 * @param {string} text
 * @param {string} filename
 * @param {CLIEngine} cliEngine
 * @returns {string[]}
 */
function collectKeysFromText(
  text: string,
  filename: string,
  cliEngine: CLIEngine
) {
  const effectiveFilename = filename || '<text>'
  debug(`collectKeysFromFile ${effectiveFilename}`)
  const config = cliEngine.getConfigForFile(effectiveFilename)
  const parser = getParser(config.parser)

  const parserOptions = Object.assign({}, config.parserOptions, {
    loc: true,
    range: true,
    raw: true,
    tokens: true,
    comment: true,
    eslintVisitorKeys: true,
    eslintScopeManager: true,
    filePath: effectiveFilename
  })
  try {
    const parseResult =
      typeof parser.parseForESLint === 'function'
        ? parser.parseForESLint(text, parserOptions)
        : { ast: parser.parse(text, parserOptions) }
    return collectKeysFromAST(parseResult.ast, parseResult.visitorKeys)
  } catch (_e) {
    return []
  }
}

/**
 * Collect the used keys from files.
 * @returns {ResourceLoader[]}
 */
function collectKeyResourcesFromFiles(fileNames: string[]) {
  debug('collectKeysFromFiles', fileNames)

  const cliEngine = new CLIEngine({})
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  cliEngine.addPlugin('@intlify/vue-i18n', require('../index')) // for Test

  const results = []

  // detect used lodalization keys with linter
  for (const filename of fileNames) {
    debug(`Processing file ... ${filename}`)

    results.push(
      new ResourceLoader(resolve(filename), () => {
        const text = readFileSync(resolve(filename), 'utf8')
        return collectKeysFromText(text, filename, cliEngine)
      })
    )
  }

  return results
}

/**
 * Collect the used keys from Program node.
 * @returns {string[]}
 */
export function collectKeysFromAST(
  node: VAST.ESLintProgram,
  visitorKeys?: VisitorKeys
): string[] {
  debug('collectKeysFromAST')

  const results = new Set<string>()
  /**
   * @param {Node} node
   */
  function enterNode(node: VAST.Node) {
    if (node.type === 'VAttribute') {
      if (node.directive) {
        if (
          node.key.name.name === 't' ||
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          node.key.name === 't' /* vue-eslint-parser v5 */
        ) {
          debug(
            "call VAttribute[directive=true][key.name.name='t'] handling ..."
          )
          const key = getKeyFromVDirective(node)
          if (key) {
            results.add(String(key))
          }
        }
      } else {
        if (
          node.key.name === 'path' &&
          (node.parent.parent.name === 'i18n' ||
            node.parent.parent.name === 'i18n-t')
        ) {
          debug(
            "call VElement:matches([name=i18n], [name=i18n-t]) > VStartTag > VAttribute[key.name='path'] handling ..."
          )

          const key = getKeyFromI18nComponent(node)
          if (key) {
            results.add(key)
          }
        }
      }
    } else if (node.type === 'CallExpression') {
      debug('CallExpression handling ...')
      const key = getKeyFromCallExpression(node)
      if (key) {
        results.add(String(key))
      }
    }
  }

  if (node.templateBody) {
    VAST.traverseNodes(node.templateBody, {
      enterNode,
      leaveNode() {
        // noop
      }
    })
  }
  VAST.traverseNodes(node, {
    visitorKeys,
    enterNode,
    leaveNode() {
      // noop
    }
  })

  return [...results]
}

class UsedKeysCache {
  private _targetFilesLoader: CacheLoader<[string[], string[]], string[]>
  private _collectKeyResourcesFromFiles: (
    fileNames: string[]
  ) => ResourceLoader<string[]>[]
  constructor() {
    this._targetFilesLoader = new CacheLoader((files, extensions) => {
      return listFilesToProcess(files, { extensions })
        .filter(f => !f.ignored && extensions.includes(extname(f.filename)))
        .map(f => f.filename)
    })
    this._collectKeyResourcesFromFiles = defineCacheFunction(fileNames => {
      return collectKeyResourcesFromFiles(fileNames)
    })
  }
  /**
   * Collect the used keys from files.
   * @param {string[]} files
   * @param {string[]} extensions
   * @returns {string[]}
   */
  collectKeysFromFiles(files: string[], extensions: string[]) {
    const result = new Set<string>()
    for (const resource of this._getKeyResources(files, extensions)) {
      for (const key of resource.getResource()) {
        result.add(key)
      }
    }
    return [...result]
  }

  /**
   * @returns {ResourceLoader[]}
   */
  _getKeyResources(files: string[], extensions: string[]) {
    const fileNames = this._targetFilesLoader.get(files, extensions)
    return this._collectKeyResourcesFromFiles(fileNames)
  }
}

export const usedKeysCache = new UsedKeysCache() // used locale message keys
