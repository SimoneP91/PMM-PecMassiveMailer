import { request } from 'node:https';
import { isIP } from 'node:net';

import { Injectable } from '@nestjs/common';

import { ForbiddenAddressError, guardedLookup, isForbiddenAddress } from './address-guard';

export interface WebhookRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
  readonly allowPrivateNetwork: boolean;
}

export interface WebhookResponse {
  readonly status: number;
}

/** Sends one notification. Behind an interface so the dispatcher is tested without a network. */
export interface WebhookTransport {
  post(request: WebhookRequest): Promise<WebhookResponse>;
}

export const WEBHOOK_TRANSPORT = Symbol('WEBHOOK_TRANSPORT');

/**
 * HTTPS only, certificate verified, no redirect followed (a 3xx is a failed
 * delivery: following it would let the endpoint send us anywhere), response
 * body read and discarded, and - unless the tenant allows it - no connection
 * to a private or reserved address.
 */
@Injectable()
export class HttpsWebhookTransport implements WebhookTransport {
  /** `ca` exists for tests with a self-signed server; production uses the system trust store. */
  public constructor(private readonly options: { readonly ca?: string } = {}) {}

  public post(input: WebhookRequest): Promise<WebhookResponse> {
    const url = new URL(input.url);
    if (url.protocol !== 'https:') {
      return Promise.reject(new Error('webhook URL must be https'));
    }
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (!input.allowPrivateNetwork && isIP(literal) !== 0 && isForbiddenAddress(literal)) {
      // An IP literal never goes through lookup: check it here.
      return Promise.reject(new ForbiddenAddressError(url.hostname, literal));
    }

    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'POST',
          headers: { ...input.headers, 'content-length': String(Buffer.byteLength(input.body)) },
          timeout: input.timeoutMs,
          ...(input.allowPrivateNetwork ? {} : { lookup: guardedLookup }),
          ...(this.options.ca === undefined ? {} : { ca: this.options.ca }),
        },
        (response) => {
          response.resume();
          response.on('end', () => {
            resolve({ status: response.statusCode ?? 0 });
          });
          response.on('error', reject);
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error(`no answer within ${String(input.timeoutMs)} ms`));
      });
      req.on('error', reject);
      req.end(input.body);
    });
  }
}
