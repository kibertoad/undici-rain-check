import { expect, afterAll, beforeAll, beforeEach, afterEach, describe, it } from 'vitest'
import { getLocal } from 'mockttp'
import { UndiciRainCheck } from '../lib/UndiciRainCheck'
import { Redis } from 'ioredis'
import { redisOptions } from './TestRedisConfig'
import { Client } from 'undici'

const JSON_HEADERS = {
  'content-type': 'application/json',
}
const BASE_URL = 'http://localhost:8080'
const mockServer = getLocal()
const client = new Client(BASE_URL)

describe('UndiciRainCheck', () => {
  let redis: Redis
  beforeEach(async () => {
    await mockServer.start(8080)
    redis = new Redis(redisOptions)
    await redis.flushall()
  })
  afterEach(async () => {
    await mockServer.stop()
    await redis.disconnect()
  })

  it('successfully runs the http operation the first time', async () => {
    expect.assertions(4)
    await mockServer.forPost('/').times(3).thenReply(500, JSON.stringify({}))
    await mockServer.forPost('/').thenCallback(async (req) => {
      const body = (await req.body.getJson()) as Record<string, any>
      expect(body.id).toEqual(123)
      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({ status: 'OK' }),
      }
    })

    const rainCheck = new UndiciRainCheck({
      redis,
      client,
      guaranteedDelivery: true,
    })

    const reply = await rainCheck.sendRequest(
      {
        path: '/',
        body: JSON.stringify({
          id: 123,
        }),
        method: 'POST',
      },
      {
        id: 'testRequest',
        redisListKey: 'myList',
        rainCheckRetryInMsecs: 0,
        expiresInMsecs: 9999999,
      },
    )

    expect(reply.error.statusCode).toEqual(500)

    await rainCheck.consumeRainCheck('myList', () => {
      throw new Error('Should not succeed ')
    })
    await rainCheck.consumeRainCheck('myList', () => {
      throw new Error('Should not succeed ')
    })
    await rainCheck.consumeRainCheck('myList', async (rainCheck, requestResult) => {
      expect(rainCheck.rainCheckParams.id).toBe('testRequest')
      expect(requestResult.body).toEqual({ status: 'OK' })
    })
  })
})
