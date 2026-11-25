import { expect, it } from 'vitest'
import { hasUnpushedWork, UNPUSHED_PATH } from '../src/client/unpushed.ts'

const answer = (status: number, body: unknown): typeof fetch => async () => Response.json(body, { status })

it('asks the stack for the session and warns when the answer says warn', async () => {
  let asked = ''
  const ask: typeof fetch = async (input) => { asked = String(input); return Response.json({ folder: true, changed: 2, unpushed: 0, warn: true }) }
  expect(await hasUnpushedWork('a b/c', ask)).toBe(true)
  expect(asked).toBe(`${UNPUSHED_PATH}?session=a%20b%2Fc`)
})

it('shows nothing for warn false, a 404, a bad body or a failed request', async () => {
  expect(await hasUnpushedWork('s', answer(200, { folder: false, changed: 0, unpushed: 0, warn: false }))).toBe(false)
  expect(await hasUnpushedWork('s', answer(200, { warn: 'yes' }))).toBe(false)
  expect(await hasUnpushedWork('s', answer(200, null))).toBe(false)
  expect(await hasUnpushedWork('s', answer(404, { warn: true }))).toBe(false)
  expect(await hasUnpushedWork('s', async () => new Response('not json', { status: 200 }))).toBe(false)
  expect(await hasUnpushedWork('s', async () => { throw new Error('offline') })).toBe(false)
})
