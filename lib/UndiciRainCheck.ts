import type { Redis } from 'ioredis'
import type { Client, Dispatcher } from 'undici'
import type { Either, RetryConfig } from 'undici-retry'
import { sendWithRetry } from 'undici-retry'
import type { RequestResult } from 'undici-retry/dist/lib/undiciRetry'

import { RedisTimeoutError } from './RedisTimeoutError'

const TIMEOUT = Symbol()

export type RainCheckSuccessCallback<T> = (
  requestResult: RequestResult<T>,
  rainCheck: RequestRainCheckParams,
) => Promise<void>

export type RequestRainCheck = {
  expiresAt: number
  retryAfter: number
  request: Dispatcher.RequestOptions
  retryConfig?: RetryConfig
  rainCheckParams: RequestRainCheckParams
}

export type RequestRainCheckParams = {
  id: string
  redisListKey: string
  rainCheckRetryInMsecs: number
  expiresInMsecs: number
  sleepUntilSuccessful?: boolean
}

export type UndiciRainCheckConfig = {
  client: Client
  redis: Redis
  requestExpiresInMsecs?: number
  redisTimeoutInMsecs?: number
  guaranteedDelivery: boolean
  statusCodeSkipList?: readonly number[]
}

export class UndiciRainCheck {
  private readonly client: Client
  private readonly redis: Redis
  private readonly guaranteedDelivery: boolean
  private readonly redisTimeoutInMsecs?: number
  private readonly statusCodeSkipList: Set<number>

  constructor(config: UndiciRainCheckConfig) {
    this.client = config.client
    this.redis = config.redis
    this.guaranteedDelivery = config.guaranteedDelivery ?? true
    this.redisTimeoutInMsecs = config.redisTimeoutInMsecs
    this.statusCodeSkipList = config.statusCodeSkipList
      ? new Set(config.statusCodeSkipList)
      : new Set([400, 401, 403, 404, 405])
  }

  protected executeInRedisWithTimeout<T>(originalPromise: Promise<T>): Promise<T> {
    if (!this.redisTimeoutInMsecs) {
      return originalPromise
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let storedReject: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let storedTimeout: any
    const timeout = new Promise((resolve, reject) => {
      storedReject = reject
      storedTimeout = setTimeout(resolve, this.redisTimeoutInMsecs, TIMEOUT)
    })
    return Promise.race([timeout, originalPromise]).then((result) => {
      if (result === TIMEOUT) {
        throw new RedisTimeoutError()
      }

      if (storedReject) {
        storedReject(undefined)
        clearTimeout(storedTimeout)
      }
      return result as T
    })
  }

  async sendRequest<T>(
    request: Dispatcher.RequestOptions,
    rainCheckParams: RequestRainCheckParams,
    callback?: RainCheckSuccessCallback<T>,
    retryConfig?: RetryConfig,
  ): Promise<Either<RequestResult<unknown>, RequestResult<T>>> {
    const now = Date.now()
    const result = await sendWithRetry<T>(this.client, request, retryConfig)

    if (
      result.error &&
      this.guaranteedDelivery &&
      !this.statusCodeSkipList.has(result.error.statusCode)
    ) {
      const storedRequest: RequestRainCheck = {
        rainCheckParams,
        expiresAt: now + rainCheckParams.expiresInMsecs,
        retryAfter: Date.now() + rainCheckParams.rainCheckRetryInMsecs,
        request,
        retryConfig,
      }

      await this.executeInRedisWithTimeout(
        this.redis.rpush(rainCheckParams.redisListKey, JSON.stringify(storedRequest)),
      )
    }

    if (result.result && callback) {
      await callback(result.result, rainCheckParams)
    }

    if (result.error && rainCheckParams.sleepUntilSuccessful) {
      throw new Error('Implicit sleep is not supported yet')
    }

    return result
  }

  /**
   * Returns false if there are no more entries to process, true if there may still be some
   */
  async consumeRainCheck<T>(
    redisListKey: string,
    callback?: RainCheckSuccessCallback<T>,
  ): Promise<boolean> {
    const rainCheckString = await this.executeInRedisWithTimeout(this.redis.lpop(redisListKey))
    // nothing to process
    if (!rainCheckString) {
      return false
    }
    const rainCheck: RequestRainCheck = JSON.parse(rainCheckString)

    const now = Date.now()

    // rain check has expired
    if (rainCheck.expiresAt < now) {
      return true
    }

    // It's too early to process this one, push it to the end of the queue
    if (rainCheck.retryAfter > now) {
      await this.executeInRedisWithTimeout(this.redis.rpush(redisListKey, rainCheckString))
    }

    await this.sendRequest<T>(
      rainCheck.request,
      rainCheck.rainCheckParams,
      callback,
      rainCheck.retryConfig,
    )

    return true
  }
}
