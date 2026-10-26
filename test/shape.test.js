import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createShaper, fallback } from '../src/shape.js'

test('local rules leave even short numbered instructions on screen', async () => {
  const said = []
  const shown = []
  const shaper = createShaper({ classify: async (c) => fallback(c.block), onSay: (s) => said.push(s), onShow: (b) => shown.push(b) })
  shaper.push('1. Install Node.\n2. Run npm start.\n\n')
  shaper.end()
  await shaper.settled()
  assert.deepEqual(said, ['There are 2 steps on screen.'])
  assert.equal(shown[0].purpose, 'steps')
})

test('local rules still read a short list of facts', async () => {
  const said = []
  const shaper = createShaper({ classify: async (c) => fallback(c.block), onSay: (s) => said.push(s), onShow: () => {} })
  shaper.push('- The build passed.\n- The tests passed.\n\n')
  shaper.end()
  await shaper.settled()
  assert.deepEqual(said, ['The build passed.', 'The tests passed.'])
})
