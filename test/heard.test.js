import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { heard } from '../src/heard.js'

describe('what comes back from a recording', () => {
  test('brackets she actually said survive, because they are not a tag', () => {
    // A tag is upper case; "[see note]" is dictated punctuation.
    assert.equal(heard('put it in [see note] the backlog'), 'put it in [see note] the backlog')
  })

  test('a whole utterance that is one sound tag is not a message', () => {
    // What a door, a chair and a keyboard come back as. Sent as it was, each
    // one started a turn and the agent answered it out loud.
    assert.equal(heard(' [explosion]'), '')
    assert.equal(heard('(coughing)'), '')
    assert.equal(heard('[Laughter].'), '')
  })
})
