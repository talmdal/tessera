// @vitest-environment node
// What a book remembers about a file shape. The first import of a CSV asks what the columns mean; every import
// of that same shape afterwards must not, which is the difference between a feature a user tolerates once and
// one they use every month.
import { describe, expect, it } from 'vitest'
import { EXCHANGE_COLLECTIONS, EXCHANGE_DIALOGS, csvProfileQuestionId } from '@tessera/exchange-api'
import { document, setupExchange, statement } from './harness'

const FINGERPRINT = 'a1b2c3d4'
const QUESTION_ID = csvProfileQuestionId(FINGERPRINT)

const MAPPING = {
  name: 'Maple Trust savings',
  delimiter: ',', quote: '"', skip: 1, header: true, encoding: 'utf-8',
  columns: { date: 'Date', payee: 'Description', debit: 'Debit', credit: 'Credit' },
  dateFormat: 'DMY', decimal: '.'
}

/** The question a CSV reader raises: its id carries the fingerprint of the file's shape. */
const mappingQuestion = {
  kind: 'csvProfile' as const,
  id: QUESTION_ID,
  title: 'Match the columns',
  sample: [['Date', 'Description', 'Debit', 'Credit']],
  suggested: MAPPING as never
}

describe('the first file of a shape', () => {
  it('asks the user, through the mapping dialog rather than the plain question one', async () => {
    const env = await setupExchange()
    env.format.asks(mappingQuestion)
    env.prompts.show.mockResolvedValue(MAPPING)

    await env.readOf(document({ statements: [statement()] }))

    expect(env.prompts.show).toHaveBeenCalledTimes(1)
    expect(env.prompts.show.mock.calls[0][0]).toBe(EXCHANGE_DIALOGS.csvProfile)
    expect(env.format.answers[0]).toEqual(MAPPING)
  })

  it('saves what the user said, under the name the mapping carries', async () => {
    const env = await setupExchange()
    env.format.asks(mappingQuestion)
    env.prompts.show.mockResolvedValue(MAPPING)
    await env.readOf()

    const saved = await env.session.database('exchange').collection<{ formatId: string, fingerprint: string, name: string, answers: { questionId: string, value: unknown }[] }>(EXCHANGE_COLLECTIONS.profiles).find()
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      formatId: 'fake.statements',
      fingerprint: FINGERPRINT,
      name: 'Maple Trust savings'
    })
    expect(saved[0].answers).toEqual([{ questionId: QUESTION_ID, value: MAPPING }])
  })

  it('saves nothing when the user cancels the dialog, and the read fails rather than guessing', async () => {
    const env = await setupExchange()
    env.format.asks(mappingQuestion)
    env.prompts.show.mockResolvedValue(undefined)

    await expect(env.readOf()).rejects.toThrow(/Match the columns/)
    const saved = await env.session.database('exchange').collection<{ formatId: string, fingerprint: string, name: string, answers: { questionId: string, value: unknown }[] }>(EXCHANGE_COLLECTIONS.profiles).find()
    expect(saved).toHaveLength(0)
  })
})

describe('the next file of the same shape', () => {
  it('is read without asking anything, using what was saved', async () => {
    const env = await setupExchange()
    env.format.asks(mappingQuestion)
    env.prompts.show.mockResolvedValue(MAPPING)
    await env.readOf(document(), '/in/statement.fake')

    // Next month's file: the same shape, different bytes.
    env.prompts.show.mockClear()
    env.format.asks(mappingQuestion)
    await env.readOf(document(), '/in/december.fake')

    expect(env.prompts.show).not.toHaveBeenCalled()
    expect(env.format.answers[1]).toEqual(MAPPING)
  })

  it('does not save a second profile for a shape already known', async () => {
    const env = await setupExchange()
    env.prompts.show.mockResolvedValue(MAPPING)
    env.format.asks(mappingQuestion)
    await env.readOf(document(), '/in/statement.fake')
    env.format.asks(mappingQuestion)
    await env.readOf(document(), '/in/december.fake')

    const saved = await env.session.database('exchange').collection<{ formatId: string, fingerprint: string, name: string, answers: { questionId: string, value: unknown }[] }>(EXCHANGE_COLLECTIONS.profiles).find()
    expect(saved).toHaveLength(1)
  })
})

describe('a file of a different shape', () => {
  it('is asked about on its own, because the fingerprint does not match', async () => {
    const env = await setupExchange()
    env.prompts.show.mockResolvedValue(MAPPING)
    env.format.asks(mappingQuestion)
    await env.readOf(document(), '/in/statement.fake')

    env.prompts.show.mockClear()
    env.format.asks({ ...mappingQuestion, id: csvProfileQuestionId('99999999') })
    await env.readOf(document(), '/in/december.fake')

    expect(env.prompts.show).toHaveBeenCalledTimes(1)
    const saved = await env.session.database('exchange').collection<{ formatId: string, fingerprint: string, name: string, answers: { questionId: string, value: unknown }[] }>(EXCHANGE_COLLECTIONS.profiles).find()
    expect(saved).toHaveLength(2)
  })
})

describe('a question that is not about a file shape', () => {
  it('goes to the plain question dialog and is not saved as a profile', async () => {
    const env = await setupExchange()
    env.prompts.show.mockResolvedValue('dmy')
    env.format.asks({
      kind: 'choice', id: 'exchange-qif.dateOrder', title: 'How are the dates written?',
      options: [{ value: 'dmy', label: 'Day first' }, { value: 'mdy', label: 'Month first' }]
    })
    await env.readOf()

    expect(env.prompts.show.mock.calls[0][0]).toBe(EXCHANGE_DIALOGS.question)
    const saved = await env.session.database('exchange').collection<{ formatId: string, fingerprint: string, name: string, answers: { questionId: string, value: unknown }[] }>(EXCHANGE_COLLECTIONS.profiles).find()
    expect(saved).toHaveLength(0)
  })
})
