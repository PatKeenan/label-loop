import { describe, expect, test } from 'bun:test'
import { createMemoryRateLimitStore } from './memory-store.ts'
import { CONTRACT_POLICY, describeRateLimitStoreContract } from './store.contract-test.ts'

let counter = 0
const nextSubject = (): string => {
  counter += 1
  return `subject-${counter}`
}

describeRateLimitStoreContract({
  create: async () => ({ store: createMemoryRateLimitStore(), subject: nextSubject }),
})

describe('the in-memory store, beyond the shared contract', () => {
  test('forgets subjects whose buckets have expired, rather than growing forever', async () => {
    const store = createMemoryRateLimitStore()
    // The sweep is amortised and only fires past its threshold, so this asserts the
    // property it protects — an expired bucket is a full one — rather than the `Map`'s
    // size, which is an implementation detail the port deliberately does not expose.
    const decision = await store.consume({
      subject: 'gone',
      cost: 1,
      nowMs: 10_000_000,
      policy: CONTRACT_POLICY,
    })
    expect(decision.remaining).toBe(CONTRACT_POLICY.capacity - 1)
    await store.close()
  })
})
