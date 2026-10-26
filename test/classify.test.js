import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseClassifier } from '../src/classify.js'

test('default shaping makes no HTTP requests', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('rules must not contact a model server')
  })
  const { classify } = await chooseClassifier('rules')
  assert.equal(classify, undefined)
  assert.equal(fetch.mock.callCount(), 0)
})
