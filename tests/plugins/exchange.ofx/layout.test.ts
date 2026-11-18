// @vitest-environment node
// The layout token stream: every character of a file lands in exactly one token, so the tokens reassemble to
// the file — over both syntaxes, and over every committed fixture.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { decode } from '../../../plugins/exchange.ofx/src/privileged/encoding'
import { detokenizeLayout, escapeValue, tokenizeLayout } from '../../../plugins/exchange.ofx/src/privileged/layout'

const FIXTURES = path.resolve(__dirname, '../../fixtures/exchange')
const fixtureFiles = () => fs.readdirSync(FIXTURES, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(ofx|qfx|qbo)$/i.test(entry.name))
  .map(entry => path.relative(FIXTURES, path.join(entry.parentPath, entry.name)))

const SGML = 'OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\n\r\n<OFX>\r\n<SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS>\r\n' +
  '<FI><ORG>Bank &amp; Trust<FID>1</FI></SONRS>\r\n<STMTTRN>\r\n  <TRNAMT>-4.50\r\n  <NAME>Café <Martin\r\n</STMTTRN>\r\n</OFX>\r\n'
const XML = '﻿<?xml version="1.0" encoding="UTF-8"?>\n<?OFX OFXHEADER="200" VERSION="211"?>\n<!-- a comment -->\n' +
  '<OFX>\n  <STMTTRN>\n    <TRNAMT>-4.50</TRNAMT>\n    <NAME>Café</NAME>\n    <EMPTY/>\n  </STMTTRN>\n</OFX>\n'

describe('the layout token stream', () => {
  it.each([['SGML', SGML], ['XML', XML]])('reassembles %s exactly', (_name, source) => {
    expect(detokenizeLayout(tokenizeLayout(source))).toBe(source)
  })

  it('reassembles every committed fixture exactly', () => {
    for (const file of fixtureFiles()) {
      const { text } = decode(fs.readFileSync(path.join(FIXTURES, file)))
      expect(detokenizeLayout(tokenizeLayout(text)), file).toBe(text)
    }
  })

  it('reads the header as keyed lines, and keeps the blank line that ends it', () => {
    const tokens = tokenizeLayout(SGML)
    expect(tokens.slice(0, 2)).toEqual([
      { kind: 'header', key: 'OFXHEADER', value: '100', raw: 'OFXHEADER:100' },
      { kind: 'space', raw: '\r\n' }
    ])
    expect(tokens.filter(t => t.kind === 'header').map(t => t.key)).toEqual(['OFXHEADER', 'DATA', 'VERSION'])
  })

  it('gives each leaf its value, as written, with the path of elements above it', () => {
    const values = tokenizeLayout(SGML).filter(t => t.kind === 'value')
    expect(values).toContainEqual({ kind: 'value', tag: 'ORG', path: ['OFX', 'SONRS', 'FI'], raw: 'Bank &amp; Trust' })
    expect(values).toContainEqual({ kind: 'value', tag: 'TRNAMT', path: ['OFX', 'STMTTRN'], raw: '-4.50' })
    // A stray `<` inside a value: what precedes it is the value; what follows reads as a tag, as the reader
    // reads it, and nothing is lost either way
    expect(values).toContainEqual({ kind: 'value', tag: 'NAME', path: ['OFX', 'STMTTRN'], raw: 'Café' })
    expect(tokenizeLayout(SGML).some(t => t.raw.startsWith('<Martin'))).toBe(true)
  })

  it('keeps the XML prolog, comments and self-closing tags', () => {
    const tokens = tokenizeLayout(XML)
    expect(tokens.filter(t => t.kind === 'prolog').map(t => t.raw)).toEqual([
      '<?xml version="1.0" encoding="UTF-8"?>', '<?OFX OFXHEADER="200" VERSION="211"?>', '<!-- a comment -->'
    ])
    expect(tokens).toContainEqual({ kind: 'open', tag: 'EMPTY', raw: '<EMPTY/>', selfClosing: true })
    expect(tokens).toContainEqual({ kind: 'close', tag: 'TRNAMT', raw: '</TRNAMT>' })
  })

  it('escapes what the grammar reserves when a value is written back', () => {
    expect(escapeValue('Bank & Trust <Ltd>')).toBe('Bank &amp; Trust &lt;Ltd&gt;')
  })
})
